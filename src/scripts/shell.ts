// App chrome behaviour shared by every page: panels, search palette, video facades, outline tracking.

const shell = document.getElementById('shell')!;
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
};

// ?focus=<selector> scrolls to an element on load (used by scripts/shot.mjs checks)
const focusSel = new URLSearchParams(location.search).get('focus');
if (focusSel) for (const t of [0, 1500, 3000]) setTimeout(() => document.querySelector(focusSel)?.scrollIntoView({ block: 'center' }), t);

// ---------------------------------------------------------------- panels
function setPanel(side: 'left' | 'right', open: boolean) {
  shell.dataset[side] = open ? 'open' : 'closed';
  document.querySelector(`[data-action="toggle-${side}"]`)?.setAttribute('aria-pressed', String(open));
  store.set(`panel-${side}`, open ? 'open' : 'closed');
  window.dispatchEvent(new Event('resize'));
}
for (const side of ['left', 'right'] as const) {
  if (store.get(`panel-${side}`) === 'closed') setPanel(side, false);
}

document.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'toggle-left') setPanel('left', shell.dataset.left === 'closed');
  if (action === 'toggle-right') setPanel('right', shell.dataset.right === 'closed');
  if (action === 'drawer') shell.dataset.drawer = shell.dataset.drawer === 'open' ? '' : 'open';
  if (action === 'palette') openPalette();
});

// Close the mobile drawer after choosing something in it
document.querySelector('.panel-left')?.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('a')) shell.dataset.drawer = '';
});

// ---------------------------------------------------------------- search palette
type Item = { t: string; u: string; k: string; s?: string };
const index: Item[] = JSON.parse(document.getElementById('search-index')?.textContent || '[]');
const palette = document.getElementById('palette')!;
const input = palette.querySelector('input')!;
const list = palette.querySelector('ul')!;
let active = 0;
let results: Item[] = [];

function render() {
  const q = input.value.trim().toLowerCase();
  results = index
    .map((it) => {
      const hay = `${it.t} ${it.k} ${it.s ?? ''}`.toLowerCase();
      const score = !q ? 1 : it.t.toLowerCase().startsWith(q) ? 3 : it.t.toLowerCase().includes(q) ? 2 : hay.includes(q) ? 1 : 0;
      return { it, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.it)
    .slice(0, 12);
  active = Math.min(active, Math.max(results.length - 1, 0));
  list.replaceChildren(
    ...results.map((it, i) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = it.u;
      a.setAttribute('role', 'option');
      a.setAttribute('aria-selected', String(i === active));
      const name = document.createElement('span');
      name.textContent = it.t;
      const kind = document.createElement('small');
      kind.textContent = it.k;
      a.append(name, kind);
      a.addEventListener('mousemove', () => { if (active !== i) { active = i; render(); } });
      li.append(a);
      return li;
    }),
  );
}

function openPalette() {
  palette.hidden = false;
  input.value = '';
  active = 0;
  render();
  input.focus();
}
const closePalette = () => { palette.hidden = true; };

input.addEventListener('input', () => { active = 0; render(); });
palette.addEventListener('click', (e) => { if (e.target === palette) closePalette(); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { active = (active + 1) % Math.max(results.length, 1); render(); e.preventDefault(); }
  if (e.key === 'ArrowUp') { active = (active - 1 + results.length) % Math.max(results.length, 1); render(); e.preventDefault(); }
  if (e.key === 'Enter' && results[active]) location.href = results[active].u;
});

document.addEventListener('keydown', (e) => {
  const typing = (e.target as HTMLElement).closest('input, textarea, [contenteditable]');
  if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) { e.preventDefault(); openPalette(); }
  if (e.key === 'Escape' && !palette.hidden) closePalette();
});

// ---------------------------------------------------------------- YouTube facades
document.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.embed.yt button');
  if (!btn) return;
  const id = btn.parentElement!.dataset.yt;
  const iframe = document.createElement('iframe');
  iframe.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
  iframe.allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen';
  iframe.allowFullscreen = true;
  iframe.title = 'YouTube video';
  btn.replaceWith(iframe);
});

// Pause looping clips that are off screen
const clipObserver = new IntersectionObserver((entries) => {
  for (const { target, isIntersecting } of entries) {
    const v = target as HTMLVideoElement;
    if (isIntersecting) v.play().catch(() => {}); else v.pause();
  }
});
document.querySelectorAll<HTMLVideoElement>('video[autoplay]').forEach((v) => clipObserver.observe(v));

// ---------------------------------------------------------------- outline (feature tree tracks the heading in view)
const outline = [...document.querySelectorAll<HTMLAnchorElement>('[data-outline] a[href^="#"]')];
if (outline.length) {
  const scroller = document.querySelector('.main-scroll');
  const heads = outline.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter(Boolean) as HTMLElement[];
  const spy = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        outline.forEach((a) => a.setAttribute('aria-current', String(a.hash.slice(1) === en.target.id)));
      }
    },
    { root: window.matchMedia('(max-width: 860px)').matches ? null : scroller, rootMargin: '0px 0px -70% 0px' },
  );
  heads.forEach((h) => spy.observe(h));
}

// ---------------------------------------------------------------- carousels
document.querySelectorAll<HTMLElement>('.prose .carousel').forEach((c) => {
  const track = c.querySelector<HTMLElement>('.gallery-track')!;
  const items = [...track.children] as HTMLElement[];
  const nav = document.createElement('div');
  nav.className = 'carousel-nav';
  const arrow = (d: string, label: string) => Object.assign(document.createElement('button'), { type: 'button', ariaLabel: label, innerHTML: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="${d}"/></svg>` });
  const prev = arrow('M10 3 5 8l5 5', 'Previous image');
  const next = arrow('m6 3 5 5-5 5', 'Next image');
  const count = document.createElement('span');
  const dots = document.createElement('div');
  dots.className = 'carousel-dots';
  items.forEach(() => dots.append(document.createElement('span')));
  nav.append(prev, next, count, dots);
  c.append(nav);
  const current = () => {
    const mid = track.scrollLeft + track.clientWidth / 2;
    let best = 0;
    items.forEach((it, i) => { if (Math.abs(it.offsetLeft + it.offsetWidth / 2 - mid) < Math.abs(items[best].offsetLeft + items[best].offsetWidth / 2 - mid)) best = i; });
    return best;
  };
  const go = (i: number) => {
    const it = items[(i + items.length) % items.length];
    track.scrollTo({ left: it.offsetLeft - (track.clientWidth - it.offsetWidth) / 2 });
  };
  const sync = () => {
    const i = current();
    count.textContent = `${i + 1} / ${items.length}`;
    [...dots.children].forEach((d, k) => d.classList.toggle('is-active', k === i));
  };
  prev.addEventListener('click', () => go(current() - 1));
  next.addEventListener('click', () => go(current() + 1));
  track.addEventListener('scroll', () => requestAnimationFrame(sync), { passive: true });
  sync();
});

// ---------------------------------------------------------------- playlists: swap the stage video
document.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.playlist-list button');
  if (!btn) return;
  const list = btn.closest('.playlist')!;
  const id = btn.dataset.play!;
  list.querySelectorAll('.playlist-list button').forEach((b) => b.setAttribute('aria-current', String(b === btn)));
  const stage = list.querySelector('.playlist-stage')!;
  const iframe = document.createElement('iframe');
  iframe.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
  iframe.allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen';
  iframe.allowFullscreen = true;
  iframe.title = btn.textContent?.trim() || 'YouTube video';
  const wrap = document.createElement('div');
  wrap.className = 'embed yt';
  wrap.append(iframe);
  stage.replaceChildren(wrap);
});

// ---------------------------------------------------------------- lightbox for article images
document.addEventListener('click', (e) => {
  const img = (e.target as HTMLElement).closest<HTMLImageElement>('.prose img');
  if (!img || img.closest('a, .embed, .sponsor, .playlist')) return;
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Image');
  const big = document.createElement('img');
  big.src = img.currentSrc || img.src;
  big.alt = img.alt;
  box.append(big);
  const cap = img.closest('figure')?.querySelector('figcaption')?.textContent;
  if (cap) box.append(Object.assign(document.createElement('div'), { className: 'lightbox-caption', textContent: cap }));
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') close(); };
  box.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.append(box);
});
