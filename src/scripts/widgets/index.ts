// Interactive article widgets: <div class="widget" data-widget="name"></div> in Markdown.
// Each widget is its own chunk and only loads when it scrolls near the viewport.

const loaders: Record<string, () => Promise<{ default: (el: HTMLElement) => void | Promise<void> }>> = {
  flybrain: () => import('./flybrain-hero'),
  lif: () => import('./lif'),
  calibration: () => import('./calibration'),
  forage: () => import('./forage'),
};

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    io.unobserve(e.target);
    const el = e.target as HTMLElement;
    const load = loaders[el.dataset.widget ?? ''];
    load?.().then((m) => m.default(el)).catch((err) => console.error('widget', el.dataset.widget, err));
  }
}, { rootMargin: '300px' });

document.querySelectorAll<HTMLElement>('.widget[data-widget]').forEach((el) => io.observe(el));
