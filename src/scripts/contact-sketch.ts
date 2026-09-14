// Contact page: a small sketch environment. The contact layout is fixed geometry; visitors can
// add lines, rectangles and circles with snapping and live dimensions. Their sketch is kept in
// localStorage. The message dialog composes a mailto: link (the site has no server).

const EMAIL = 'contact@doriantodd.com';
const SVGNS = 'http://www.w3.org/2000/svg';

const root = document.getElementById('sketch') as HTMLElement;
const STORE = root.dataset.store || 'contact-sketch-v1';
const svg = root.querySelector('svg') as SVGSVGElement;
const userLayer = svg.querySelector('[data-user]') as SVGGElement;
const preview = svg.querySelector('[data-preview]') as SVGGElement;
const readout = root.querySelector('[data-readout]') as HTMLElement;
const statusEl = root.querySelector('[data-status]') as HTMLElement;
const countEl = document.querySelector('[data-count]') as HTMLElement | null;
const HOME = { x: 0, y: 0, w: 1200, h: 800 };
let view = { ...HOME };

type Tool = 'select' | 'line' | 'rect' | 'circle';
type Pt = { x: number; y: number };
type Entity =
  | { id: number; kind: 'line'; a: Pt; b: Pt; construction: boolean }
  | { id: number; kind: 'rect'; a: Pt; b: Pt; construction: boolean }
  | { id: number; kind: 'circle'; c: Pt; r: number; construction: boolean };

let tool: Tool = 'select';
let construction = false;
let entities: Entity[] = load();
let undoStack: Entity[][] = [];
let redoStack: Entity[][] = [];
let selected: number | null = null;
let nextId = entities.reduce((m, e) => Math.max(m, e.id), 0) + 1;

function load(): Entity[] {
  try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { return []; }
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(entities)); } catch {}
}

const el = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent?: Element) => {
  const node = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.append(node);
  return node;
};
const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

// ---------------------------------------------------------------- draw-in on first load
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  svg.classList.add('is-drawing');
  setTimeout(() => svg.classList.remove('is-drawing'), 1400);
}

// ---------------------------------------------------------------- view (pan / zoom)
const applyView = () => svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
function toSvg(e: { clientX: number; clientY: number }): Pt {
  const p = svg.createSVGPoint();
  p.x = e.clientX;
  p.y = e.clientY;
  const r = p.matrixTransform(svg.getScreenCTM()!.inverse());
  return { x: r.x, y: r.y };
}
/** SVG units per screen pixel, for zoom-independent sizes. */
const unitsPerPx = () => view.w / svg.getBoundingClientRect().width;

root.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = toSvg(e);
  const k = Math.exp(e.deltaY * 0.0015);
  const w = Math.min(Math.max(view.w * k, 240), 5000);
  const f = w / view.w;
  view = { x: p.x - (p.x - view.x) * f, y: p.y - (p.y - view.y) * f, w, h: view.h * f };
  applyView();
  render();
}, { passive: false });

// ---------------------------------------------------------------- rendering of visitor geometry
function render() {
  userLayer.replaceChildren();
  const ptSize = 7 * unitsPerPx();
  for (const e of entities) {
    const g = el('g', { 'data-id': e.id }, userLayer);
    const cls = `u-geom${e.construction ? ' is-construction' : ''}${e.id === selected ? ' is-selected' : ''}`;
    if (e.kind === 'line') {
      el('line', { class: 'u-hit', x1: e.a.x, y1: e.a.y, x2: e.b.x, y2: e.b.y }, g);
      el('line', { class: cls, x1: e.a.x, y1: e.a.y, x2: e.b.x, y2: e.b.y }, g);
      for (const p of [e.a, e.b]) el('rect', { class: 'u-pt', x: p.x - ptSize / 2, y: p.y - ptSize / 2, width: ptSize, height: ptSize }, g);
    } else if (e.kind === 'rect') {
      const x = Math.min(e.a.x, e.b.x), y = Math.min(e.a.y, e.b.y), w = Math.abs(e.b.x - e.a.x), h = Math.abs(e.b.y - e.a.y);
      el('rect', { class: 'u-hit', x, y, width: w, height: h }, g);
      el('rect', { class: cls, x, y, width: w, height: h }, g);
      for (const p of [{ x, y }, { x: x + w, y }, { x, y: y + h }, { x: x + w, y: y + h }]) el('rect', { class: 'u-pt', x: p.x - ptSize / 2, y: p.y - ptSize / 2, width: ptSize, height: ptSize }, g);
    } else {
      el('circle', { class: 'u-hit', cx: e.c.x, cy: e.c.y, r: e.r }, g);
      el('circle', { class: cls, cx: e.c.x, cy: e.c.y, r: e.r }, g);
      el('rect', { class: 'u-pt', x: e.c.x - ptSize / 2, y: e.c.y - ptSize / 2, width: ptSize, height: ptSize }, g);
    }
  }
  const n = entities.length;
  if (countEl) countEl.textContent = n ? `${n} ${n === 1 ? 'entity' : 'entities'}` : 'No entities yet';
  statusEl.textContent = n ? 'Under defined' : 'Fully defined';
  statusEl.parentElement!.classList.toggle('is-under', n > 0);
  (document.querySelector('[data-undo]') as HTMLButtonElement).disabled = !undoStack.length;
  (document.querySelector('[data-redo]') as HTMLButtonElement).disabled = !redoStack.length;
}

function commit(next: Entity[]) {
  undoStack.push(entities);
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  entities = next;
  save();
  render();
}

// ---------------------------------------------------------------- snapping
function snapPoints(): Pt[] {
  const pts: Pt[] = [];
  for (const e of entities) {
    if (e.kind === 'line') pts.push(e.a, e.b, { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 });
    else if (e.kind === 'rect') pts.push(e.a, e.b, { x: e.a.x, y: e.b.y }, { x: e.b.x, y: e.a.y });
    else pts.push(e.c);
  }
  // key points of the contact layout
  svg.querySelectorAll<SVGCircleElement>('.sk-line').forEach((c) => {
    if (c.tagName === 'circle') pts.push({ x: +c.getAttribute('cx')!, y: +c.getAttribute('cy')! });
  });
  return pts;
}

function snap(p: Pt, from?: Pt, shift = false): { p: Pt; hint: string | null; target: Pt | null } {
  const tol = 10 * unitsPerPx();
  let best: Pt | null = null, bestD = tol;
  for (const s of snapPoints()) {
    const d = Math.hypot(s.x - p.x, s.y - p.y);
    if (d < bestD) { best = s; bestD = d; }
  }
  if (best) return { p: { ...best }, hint: 'coincident', target: best };
  let q = { x: Math.round(p.x / 10) * 10, y: Math.round(p.y / 10) * 10 };
  let hint: string | null = null;
  if (from) {
    const dx = q.x - from.x, dy = q.y - from.y;
    if (shift) {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
      const len = Math.hypot(dx, dy);
      q = { x: from.x + Math.cos(ang) * len, y: from.y + Math.sin(ang) * len };
    } else if (Math.abs(dy) < tol * 0.8) { q.y = from.y; hint = 'H'; }
    else if (Math.abs(dx) < tol * 0.8) { q.x = from.x; hint = 'V'; }
  }
  return { p: q, hint, target: null };
}

// ---------------------------------------------------------------- live preview while drawing
function drawPreview(a: Pt, b: Pt, info: ReturnType<typeof snap>) {
  preview.replaceChildren();
  const cls = `u-geom${construction ? ' is-construction' : ''}`;
  const px = unitsPerPx();
  let label = '';
  let lx = b.x, ly = b.y;
  if (tool === 'line') {
    el('line', { class: cls, x1: a.x, y1: a.y, x2: b.x, y2: b.y }, preview);
    label = fmt(Math.hypot(b.x - a.x, b.y - a.y));
    lx = (a.x + b.x) / 2; ly = (a.y + b.y) / 2 - 14 * px;
  } else if (tool === 'rect') {
    el('rect', { class: cls, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }, preview);
    label = `${fmt(Math.abs(b.x - a.x))} x ${fmt(Math.abs(b.y - a.y))}`;
    lx = (a.x + b.x) / 2; ly = Math.min(a.y, b.y) - 12 * px;
  } else if (tool === 'circle') {
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    el('circle', { class: cls, cx: a.x, cy: a.y, r }, preview);
    el('line', { class: 'u-geom is-construction', x1: a.x, y1: a.y, x2: b.x, y2: b.y }, preview);
    label = `⌀ ${fmt(r * 2)}`;
    lx = (a.x + b.x) / 2; ly = (a.y + b.y) / 2 - 12 * px;
  }
  const t = el('text', { class: 'u-dim', x: lx, y: ly, 'text-anchor': 'middle', 'font-size': 13 * px }, preview);
  t.textContent = label;
  if (info.target) el('circle', { class: 'u-snap', cx: info.target.x, cy: info.target.y, r: 7 * px }, preview);
  if (info.hint === 'H' || info.hint === 'V') {
    const g = el('g', { class: 'u-infer', transform: `translate(${b.x + 12 * px} ${b.y + 12 * px}) scale(${px})` }, preview);
    el('rect', { width: 16, height: 16, rx: 3 }, g);
    const tt = el('text', { x: 8, y: 12, 'text-anchor': 'middle' }, g);
    tt.textContent = info.hint;
  }
  readout.hidden = false;
  readout.textContent = `${tool}  ${label}`;
}

// ---------------------------------------------------------------- pointer handling
type Gesture =
  | { kind: 'pan'; start: { x: number; y: number }; view: typeof view; moved: boolean; id: number }
  | { kind: 'draw'; a: Pt; id: number; moved: boolean; clickMode: boolean };
let gesture: Gesture | null = null;

root.addEventListener('pointerdown', (e) => {
  if (e.button === 1 || e.button === 2 || (tool === 'select' && e.button === 0)) {
    // In select mode, clicking visitor geometry selects it
    const hit = (e.target as Element).closest('[data-user] [data-id]');
    if (tool === 'select' && hit) {
      selected = Number(hit.getAttribute('data-id'));
      render();
      return;
    }
    if (tool === 'select' && (e.target as Element).closest('.sk-entity')) return; // let links work
    gesture = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, view: { ...view }, moved: false, id: e.pointerId };
    return;
  }
  if (e.button !== 0) return;
  if (gesture?.kind === 'draw' && gesture.clickMode) return; // second click handled on pointerup
  const info = snap(toSvg(e));
  gesture = { kind: 'draw', a: info.p, id: e.pointerId, moved: false, clickMode: false };
  root.setPointerCapture(e.pointerId);
});

root.addEventListener('pointermove', (e) => {
  if (!gesture) return;
  if (gesture.kind === 'pan') {
    const dx = e.clientX - gesture.start.x, dy = e.clientY - gesture.start.y;
    if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
    if (!gesture.moved) { gesture.moved = true; root.setPointerCapture(gesture.id); root.classList.add('is-panning'); selected = null; render(); }
    const s = gesture.view.w / svg.getBoundingClientRect().width;
    view.x = gesture.view.x - dx * s;
    view.y = gesture.view.y - dy * s;
    applyView();
    return;
  }
  const info = snap(toSvg(e), gesture.a, e.shiftKey);
  if (Math.hypot(info.p.x - gesture.a.x, info.p.y - gesture.a.y) > 2) gesture.moved = true;
  drawPreview(gesture.a, info.p, info);
});

root.addEventListener('pointerup', (e) => {
  if (!gesture) return;
  if (gesture.kind === 'pan') {
    if (gesture.moved) root.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); }, { capture: true, once: true });
    else if (tool === 'select' && selected !== null) { selected = null; render(); }
    gesture = null;
    root.classList.remove('is-panning');
    return;
  }
  const info = snap(toSvg(e), gesture.a, e.shiftKey);
  const b = info.p;
  const size = Math.hypot(b.x - gesture.a.x, b.y - gesture.a.y);
  if (!gesture.moved && !gesture.clickMode) {
    // click-click drawing: keep the start point and wait for the second click
    gesture.clickMode = true;
    return;
  }
  if (size > 3) {
    const a = gesture.a;
    const id = nextId++;
    const ent: Entity = tool === 'circle'
      ? { id, kind: 'circle', c: a, r: size, construction }
      : { id, kind: tool === 'rect' ? 'rect' : 'line', a, b, construction };
    commit([...entities, ent]);
    // lines chain from the last end point, like Onshape
    if (tool === 'line' && gesture.clickMode) {
      gesture = { kind: 'draw', a: b, id: e.pointerId, moved: false, clickMode: true };
      preview.replaceChildren();
      return;
    }
  }
  gesture = null;
  preview.replaceChildren();
  readout.hidden = true;
});

function cancelDraw() {
  gesture = null;
  preview.replaceChildren();
  readout.hidden = true;
}

// ---------------------------------------------------------------- tools, keys, buttons
function setTool(t: Tool) {
  tool = t;
  root.dataset.tool = t;
  cancelDraw();
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
}
document.querySelectorAll<HTMLButtonElement>('button[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool as Tool)));
const constructionBtn = document.querySelector<HTMLButtonElement>('[data-construction]')!;
const toggleConstruction = () => { construction = !construction; constructionBtn.setAttribute('aria-pressed', String(construction)); };
constructionBtn.addEventListener('click', toggleConstruction);

const undo = () => { if (!undoStack.length) return; redoStack.push(entities); entities = undoStack.pop()!; selected = null; save(); render(); };
const redo = () => { if (!redoStack.length) return; undoStack.push(entities); entities = redoStack.pop()!; save(); render(); };
document.querySelector('[data-undo]')!.addEventListener('click', undo);
document.querySelector('[data-redo]')!.addEventListener('click', redo);
document.querySelector('[data-clear]')!.addEventListener('click', () => { if (entities.length) commit([]); });
const fit = () => { view = { ...HOME }; applyView(); render(); };
document.querySelector('[data-fit]')!.addEventListener('click', fit);

document.querySelectorAll<HTMLButtonElement>('[data-layer]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    svg.querySelectorAll(`[data-group="${btn.dataset.layer}"]`).forEach((g) => g.toggleAttribute('data-hide', !on));
  }),
);

document.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.closest('input, textarea')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === 'escape') { cancelDraw(); if (tool !== 'select') setTool('select'); selected = null; render(); }
  else if (k === 'v') setTool('select');
  else if (k === 'l') setTool('line');
  else if (k === 'r') setTool('rect');
  else if (k === 'c') setTool('circle');
  else if (k === 'q') toggleConstruction();
  else if (k === 'f') fit();
  else if ((k === 'delete' || k === 'backspace') && selected !== null) { commit(entities.filter((x) => x.id !== selected)); selected = null; }
});

// ---------------------------------------------------------------- hover sync between list and sketch
function preselect(id: string | null) {
  document.querySelectorAll<HTMLElement | SVGElement>('[data-entity]').forEach((node) => node.classList.toggle('is-preselect', !!id && node.dataset.entity === id));
}
document.querySelectorAll<HTMLElement>('[data-entity]').forEach((node) => {
  node.addEventListener('mouseenter', () => preselect(node.dataset.entity!));
  node.addEventListener('mouseleave', () => preselect(null));
  node.addEventListener('focus', () => preselect(node.dataset.entity!));
  node.addEventListener('blur', () => preselect(null));
});

// ---------------------------------------------------------------- copy email
const copyLabel = document.querySelector<HTMLElement>('[data-copy-label]');
async function copyEmail() {
  try {
    await navigator.clipboard.writeText(EMAIL);
    if (copyLabel) { copyLabel.textContent = 'Copied'; setTimeout(() => (copyLabel.textContent = 'Copy email address'), 1600); }
    const slot = svg.querySelector('.sk-entity[data-entity="email"]');
    slot?.classList.add('is-copied');
    setTimeout(() => slot?.classList.remove('is-copied'), 1600);
  } catch {}
}
document.querySelector('[data-copy]')?.addEventListener('click', copyEmail);
svg.querySelector('[data-copy-on-click]')?.addEventListener('click', () => { copyEmail(); });

// ---------------------------------------------------------------- message dialog -> mailto
const form = document.getElementById('message-form') as HTMLFormElement | null;
form?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!form.reportValidity()) return;
  const fd = new FormData(form);
  const topic = String(fd.get('topic') || 'Other');
  const name = String(fd.get('name') || '').trim();
  const subject = String(fd.get('subject') || '').trim() || `${topic} inquiry from ${name}`;
  const body = `${String(fd.get('message') || '').trim()}\n\n- ${name}`;
  location.href = `mailto:${EMAIL}?subject=${encodeURIComponent(`[${topic}] ${subject}`)}&body=${encodeURIComponent(body)}`;
});

applyView();
render();
