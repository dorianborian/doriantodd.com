// Small DOM helpers shared by the article widgets.

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

/** Widget frame: a titled head, a body, and an optional note line. */
export function frame(el: HTMLElement, title: string, hint: string) {
  el.innerHTML = '';
  const head = h('div', { class: 'widget-head' }, h('span', { class: 'widget-title' }, title), h('span', { class: 'widget-hint' }, hint));
  const body = h('div', { class: 'widget-body' });
  el.append(head, body);
  return body;
}

export function slider(label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onInput: (v: number) => void) {
  const out = h('output', {}, fmt(value));
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
  input.addEventListener('input', () => { const v = Number(input.value); out.textContent = fmt(v); onInput(v); });
  return { el: h('label', { class: 'widget-slider' }, h('span', {}, label), input, out), input, set(v: number) { input.value = String(v); out.textContent = fmt(v); } };
}

export function segmented(options: { id: string; label: string }[], value: string, onPick: (id: string) => void) {
  const wrap = h('div', { class: 'widget-seg', role: 'group' });
  const buttons = options.map((o) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(o.id === value) }, o.label);
    b.addEventListener('click', () => { buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b))); onPick(o.id); });
    wrap.append(b);
    return b;
  });
  return { el: wrap, set(id: string) { buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i].id === id))); } };
}

/** A canvas that tracks its CSS size at device pixel ratio. Returns a getter for the 2D context and size. */
export function canvas(parent: HTMLElement, aspect: number) {
  const c = h('canvas', { class: 'widget-canvas' });
  c.style.aspectRatio = String(aspect);
  parent.append(c);
  const g = c.getContext('2d')!;
  const fit = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = c.clientWidth, hh = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hh * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h: hh };
  };
  return { el: c, g, fit };
}

/** Runs `frame` on animation frames only while the element is on screen. */
export function whileVisible(el: HTMLElement, frameFn: (t: number, dt: number) => void) {
  let visible = false, raf = 0, last = 0;
  const loop = (now: number) => {
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
    last = now;
    frameFn(now / 1000, dt);
    if (visible) raf = requestAnimationFrame(loop);
  };
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    cancelAnimationFrame(raf);
    last = 0;
    if (visible) raf = requestAnimationFrame(loop);
  }).observe(el);
}

export const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
