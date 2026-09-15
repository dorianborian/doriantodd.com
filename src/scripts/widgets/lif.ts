// One leaky integrate-and-fire neuron with the exact Shiu et al. parameters used in Fly Brain Bridge.
// Poisson spikes arrive from a presynaptic partner; drag the sliders and the trace re-simulates.

import { canvas, frame, h, slider } from './ui';

const V0 = -52, VTH = -45, TMBR = 20, TAU = 5, TRFC = 2.2, DT = 0.1, MS = 600;

function simulate(rate: number, synapses: number, wsyn: number, seed: number) {
  let x = seed || 1;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const aV = Math.exp(-DT / TMBR), aG = Math.exp(-DT / TAU), bVG = (TAU / (TAU - TMBR)) * (aG - aV);
  const steps = MS / DT;
  const v = new Float32Array(steps / 5);
  const inputs: number[] = [], spikes: number[] = [];
  let u = 0, g = 0, refr = 0;
  const w = Math.min(synapses, 100) * wsyn; // same cap of 100 synapses as the calibrated model
  for (let k = 0; k < steps; k++) {
    if (rnd() < rate * DT * 1e-3) { g += w; inputs.push(k * DT); }
    if (refr > 0) refr -= DT;
    else {
      u = u * aV + g * bVG;
      g *= aG;
      if (V0 + u > VTH) { spikes.push(k * DT); u = 0; g = 0; refr = TRFC; }
    }
    if (k % 5 === 0) v[k / 5] = V0 + u;
  }
  return { v, inputs, spikes };
}

export default function lif(el: HTMLElement) {
  const body = frame(el, 'Single LIF neuron, Shiu et al. parameters', 'Drag the sliders');
  const controls = h('div', { class: 'widget-controls' });
  const cv = canvas(body, 3.2);
  const stats = h('div', { class: 'widget-stats' });
  body.append(controls, stats);
  const state = { rate: 150, synapses: 80, wsyn: 0.15 };
  let seed = 7;
  const rateS = slider('Input rate', 0, 300, 5, state.rate, (v) => `${v} Hz`, (v) => { state.rate = v; draw(); });
  const synS = slider('Synapses in the connection', 1, 264, 1, state.synapses, (v) => (v > 100 ? `${v} (capped at 100)` : String(v)), (v) => { state.synapses = v; draw(); });
  const wS = slider('w_syn per synapse', 0.05, 0.4, 0.005, state.wsyn, (v) => `${v.toFixed(3)} mV`, (v) => { state.wsyn = v; draw(); });
  const reroll = h('button', { type: 'button', class: 'widget-btn' }, 'New random input');
  reroll.addEventListener('click', () => { seed = (seed * 48271) % 2147483647; draw(); });
  const presets = h('div', { class: 'widget-row' },
    h('span', { class: 'widget-label' }, 'Try'),
    ...[['Shiu default', 0.275], ['Calibrated', 0.15], ['Too weak', 0.1]].map(([label, w]) => {
      const b = h('button', { type: 'button', class: 'widget-btn' }, String(label));
      b.addEventListener('click', () => { state.wsyn = Number(w); wS.set(state.wsyn); draw(); });
      return b;
    }),
    reroll,
  );
  controls.append(rateS.el, synS.el, wS.el, presets);

  function draw() {
    const { v, inputs, spikes } = simulate(state.rate, state.synapses, state.wsyn, seed);
    const { w, h: H } = cv.fit();
    const g = cv.g;
    g.clearRect(0, 0, w, H);
    const pad = { l: 44, r: 12, t: 16, b: 26 };
    const vmin = -54, vmax = -38;
    const X = (ms: number) => pad.l + (ms / MS) * (w - pad.l - pad.r);
    const Y = (mv: number) => pad.t + (1 - (mv - vmin) / (vmax - vmin)) * (H - pad.t - pad.b);
    g.font = '11px ui-monospace, Consolas, monospace';
    g.fillStyle = '#6f7580';
    g.strokeStyle = '#2a2c31';
    for (const mv of [-52, -48, -44, -40]) { g.beginPath(); g.moveTo(pad.l, Y(mv)); g.lineTo(w - pad.r, Y(mv)); g.stroke(); g.fillText(String(mv), 6, Y(mv) + 4); }
    for (let ms = 0; ms <= MS; ms += 100) g.fillText(`${ms}`, X(ms) - 8, H - 8);
    // threshold
    g.strokeStyle = '#e5534b';
    g.setLineDash([5, 4]);
    g.beginPath(); g.moveTo(pad.l, Y(VTH)); g.lineTo(w - pad.r, Y(VTH)); g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#e5534b';
    g.fillText('threshold -45 mV', w - pad.r - 118, Y(VTH) - 6);
    // input ticks along the bottom
    g.strokeStyle = 'rgba(74,155,255,0.55)';
    for (const ms of inputs) { g.beginPath(); g.moveTo(X(ms), H - pad.b); g.lineTo(X(ms), H - pad.b - 6); g.stroke(); }
    // voltage
    g.strokeStyle = '#4a9bff';
    g.lineWidth = 1.6;
    g.beginPath();
    v.forEach((mv, k) => { const x = X(k * 5 * DT), y = Y(Math.min(mv, vmax)); k ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
    g.lineWidth = 1;
    // output spikes
    g.strokeStyle = '#f2b84b';
    g.lineWidth = 2;
    for (const ms of spikes) { g.beginPath(); g.moveTo(X(ms), Y(VTH)); g.lineTo(X(ms), pad.t); g.stroke(); }
    g.lineWidth = 1;
    const perSpike = Math.min(state.synapses, 100) * state.wsyn;
    stats.innerHTML = `<span><b>${(spikes.length / (MS / 1000)).toFixed(0)} Hz</b> output</span><span><b>${inputs.length}</b> input spikes</span>`
      + `<span><b>${perSpike.toFixed(1)} mV</b> kick per input spike, 7 mV to threshold</span>`;
  }
  new ResizeObserver(draw).observe(cv.el);
  draw();
}
