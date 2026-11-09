// Does cutting holes in a 3D print save weight? One layer of a printed bar, sliced the way a slicer does it:
// a solid wall (two 0.45 mm perimeters) around every edge, sparse infill inside. Each hex hole removes some
// infill but gets a brand new wall of its own. In a thin shell the holes cut straight through what is all wall
// anyway, so they only remove plastic. The plastic is counted on a 0.1 mm grid.

import { canvas, frame, h, slider } from './ui';

const LEN = 60; // bar length, mm
const WALL = 0.9; // two perimeters
const LINE = 0.45; // extrusion width
const RES = 0.1; // mm per sample

/** Distance from p to the edge of a flat-topped hexagon with flat-to-flat size d (negative inside). */
function hexSdf(px: number, py: number, d: number) {
  const x = Math.abs(px), y = Math.abs(py);
  const r = d / 2;
  return Math.max(y - r, x * 0.8660254 + y * 0.5 - r);
}

export default function infillHoles(el: HTMLElement) {
  const body = frame(el, 'Do holes save plastic? One layer of a printed bar', 'Drag the sliders');
  const cv = canvas(body, 3);
  const controls = h('div', { class: 'widget-controls' });
  const stats = h('div', { class: 'widget-stats' });
  body.append(controls, stats);

  const st = { thick: 12, infill: 15, holes: 4, size: 6 };
  const redraw = () => draw();
  const thickS = slider('Part thickness', 1.6, 20, 0.1, st.thick, (v) => `${v.toFixed(1)} mm`, (v) => { st.thick = v; redraw(); });
  const infillS = slider('Infill', 5, 100, 1, st.infill, (v) => `${v}%`, (v) => { st.infill = v; redraw(); });
  const holesS = slider('Hex holes', 0, 6, 1, st.holes, (v) => String(v), (v) => { st.holes = v; redraw(); });
  const sizeS = slider('Hole size', 2, 14, 0.5, st.size, (v) => `${v.toFixed(1)} mm`, (v) => { st.size = v; redraw(); });
  const presets = h('div', { class: 'widget-row' },
    h('span', { class: 'widget-label' }, 'Try'),
    ...([['Chunky part, 15%', 12, 15, 6], ['Thin shell', 2.2, 15, 6], ['Solid part, 100%', 12, 100, 6]] as const).map(([label, t, f, d]) => {
      const b = h('button', { type: 'button', class: 'widget-btn' }, label);
      b.addEventListener('click', () => {
        st.thick = t; st.infill = f; st.size = d;
        thickS.set(t); infillS.set(f); sizeS.set(d);
        redraw();
      });
      return b;
    }),
  );
  controls.append(thickS.el, infillS.el, holesS.el, sizeS.el, presets);

  /** Hole centres along the bar, spaced evenly; big holes shrink so neighbours keep a wall between them. */
  const layout = () => {
    const d = Math.min(st.size, LEN / (st.holes + 1) - 2 * WALL - 0.4);
    if (st.holes === 0 || d < 0.8) return { d: 0, xs: [] as number[] };
    const xs = Array.from({ length: st.holes }, (_, i) => (LEN * (i + 1)) / (st.holes + 1));
    return { d, xs };
  };

  /** Plastic area of the layer in mm^2, with and without the holes. */
  const plastic = (withHoles: boolean) => {
    const { d, xs } = withHoles ? layout() : { d: 0, xs: [] as number[] };
    const f = st.infill / 100;
    let area = 0;
    for (let y = RES / 2; y < st.thick; y += RES) {
      for (let x = RES / 2; x < LEN; x += RES) {
        let edge = Math.min(x, LEN - x, y, st.thick - y);
        let inHole = false;
        for (const cx of xs) {
          const sd = hexSdf(x - cx, y - st.thick / 2, d);
          if (sd < 0) { inHole = true; break; }
          edge = Math.min(edge, sd);
        }
        if (inHole) continue;
        area += (edge < WALL ? 1 : f) * RES * RES;
      }
    }
    return area;
  };

  function draw() {
    const { w: W, h: H } = cv.fit();
    const g = cv.g;
    g.clearRect(0, 0, W, H);
    const pad = 16;
    const k = Math.min((W - pad * 2) / LEN, (H - pad * 2) / 20); // px per mm, fixed so thickness reads true
    const ox = (W - LEN * k) / 2, oy = (H - st.thick * k) / 2;
    const { d, xs } = layout();
    const f = st.infill / 100;

    // the bar filled with the infill grid, walls drawn as solid bands, then the holes erased
    g.save();
    g.beginPath();
    g.rect(ox, oy, LEN * k, st.thick * k);
    g.clip();
    // infill: a grid of 0.45 mm lines whose spacing gives the density (two directions)
    const pitch = Math.min(60, (2 * LINE) / Math.max(f, 0.01));
    g.strokeStyle = 'rgba(74,155,255,0.7)';
    g.lineWidth = Math.max(1, LINE * k * 0.8);
    g.beginPath();
    if (f >= 0.999) g.rect(ox, oy, LEN * k, st.thick * k);
    else {
      for (let t = -st.thick; t < LEN + st.thick; t += pitch) {
        g.moveTo(ox + t * k, oy); g.lineTo(ox + (t + st.thick) * k, oy + st.thick * k);
        g.moveTo(ox + (t + st.thick) * k, oy); g.lineTo(ox + t * k, oy + st.thick * k);
      }
    }
    if (f >= 0.999) { g.fillStyle = 'rgba(74,155,255,0.7)'; g.fill(); } else g.stroke();
    // walls: stroke each outline twice the wall width, clipped to the material
    g.strokeStyle = '#f2b84b';
    g.lineWidth = WALL * k * 2;
    g.beginPath();
    g.rect(ox, oy, LEN * k, st.thick * k);
    g.stroke();
    for (const cx of xs) { g.beginPath(); hexPath(g, ox + cx * k, oy + (st.thick / 2) * k, (d / 2) * k); g.stroke(); }
    g.globalCompositeOperation = 'destination-out';
    for (const cx of xs) { g.beginPath(); hexPath(g, ox + cx * k, oy + (st.thick / 2) * k, (d / 2) * k); g.fill(); }
    g.restore();

    g.font = '11px ui-monospace, Consolas, monospace';
    g.fillStyle = '#6f7580';
    g.fillText(`${LEN} x ${st.thick.toFixed(1)} mm, one layer`, ox, oy - 7);

    const before = plastic(false), after = plastic(true);
    const change = ((after - before) / before) * 100;
    const verdict = xs.length === 0 ? 'no holes' : Math.abs(change) < 0.5 ? 'about the same plastic' : change > 0 ? 'the holes add plastic' : 'the holes save plastic';
    stats.innerHTML = `<span><span class="legend"><i style="background:#f2b84b"></i></span>walls <span class="legend"><i style="background:#4a9bff"></i></span>infill</span>`
      + `<span><b>${before.toFixed(0)} mm²</b> plastic without holes</span><span><b>${after.toFixed(0)} mm²</b> with them</span>`
      + `<span><b style="color:${change > 0.5 ? '#ff6b5a' : change < -0.5 ? '#4fd18b' : 'inherit'}">${change > 0 ? '+' : ''}${change.toFixed(1)}%</b> ${verdict}</span>`;
  }
  new ResizeObserver(redraw).observe(cv.el);
  draw();
}

function hexPath(g: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  // flat-to-flat 2r: the vertices sit at r / cos(30 deg), flat top and bottom
  const R = r / 0.8660254;
  const pts = [0, 1, 2, 3, 4, 5].map((i) => [cx + R * Math.cos((Math.PI / 3) * i), cy + R * Math.sin((Math.PI / 3) * i)]);
  g.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) g.lineTo(x, y);
  g.closePath();
}
