// Spare thrust for Sesame Drone: a side view of a quad holding a hover while gusts knock it over. The flight
// controller is a plain PD loop with a Betaflight-style mixer: when a motor is already at full power it lowers both
// sides to keep the correction, so a drone with little spare thrust sinks while it catches itself.
// Mass and arm length are Sesame Drone's (264 g, 10 cm), the thrust-to-weight ratio is the slider.

import { canvas, frame, h, slider, whileVisible } from './ui';

const M = 0.264, G = 9.81, L = 0.1, I = (M * L * L) / 3;
const HOVER_Y = 1.0; // metres
const KP_A = 150, KD_A = 18, KP_Y = 9, KD_Y = 4.5, KP_X = 0.9, KD_X = 1.1;
const SUB = 8; // physics steps per frame

export default function thrustMargin(el: HTMLElement) {
  const body = frame(el, 'Spare thrust: how hard it is to catch itself', 'Drag the ratio, then push it');
  const cv = canvas(body, 2.4);
  const controls = h('div', { class: 'widget-controls' });
  const stats = h('div', { class: 'widget-stats' });
  body.append(controls, stats);

  let tw = 2.5;
  const twS = slider('Thrust-to-weight ratio', 0.8, 8, 0.01, tw, (v) => `${v.toFixed(2)} : 1`, (v) => { tw = v; reset(false); });
  const push = h('button', { type: 'button', class: 'widget-btn' }, 'Push it');
  push.addEventListener('click', () => gust(1.25));
  const over = h('button', { type: 'button', class: 'widget-btn' }, '+14 g over budget');
  over.addEventListener('click', () => { tw = Math.max(0.8, tw * (250 / 264)); twS.set(tw); reset(false); });
  const presets = h('div', { class: 'widget-row' },
    h('span', { class: 'widget-label' }, 'Try'),
    ...([['Racing quad', 8], ['Camera drone', 2.5], ['Right around 1', 1.15], ['Not enough', 0.92]] as const).map(([label, v]) => {
      const b = h('button', { type: 'button', class: 'widget-btn' }, label);
      b.addEventListener('click', () => { tw = v; twS.set(tw); reset(true); });
      return b;
    }),
    over, push,
  );
  controls.append(twS.el, presets);

  // state: position (m), tilt (rad, + leans right), velocities; motor thrusts as a fraction of their maximum
  const s = { x: 0, y: HOVER_Y, a: 0, vx: 0, vy: 0, w: 0, tl: 0, tr: 0, crashed: 0, nextGust: 2.5, minY: HOVER_Y, sat: 0 };
  const trail: number[] = [];
  function reset(toAir: boolean) {
    if (toAir || s.crashed) Object.assign(s, { x: 0, y: tw >= 1 ? HOVER_Y : 0, a: 0, vx: 0, vy: 0, w: 0, crashed: 0 });
    s.minY = s.y;
    s.nextGust = 1.5;
  }
  function gust(k: number) {
    if (s.crashed || s.y <= 0.001) return;
    const dir = Math.random() < 0.5 ? -1 : 1;
    s.w += dir * 5.5 * k;
    s.vx += dir * 0.5 * k;
    s.minY = s.y;
  }

  function physics(dt: number) {
    const tmax = (tw * M * G) / 2; // per motor
    if (s.crashed) { s.crashed -= dt; if (s.crashed <= 0) reset(true); return; }
    // outer loops: hold x = 0 by leaning, hold the hover height with collective thrust
    const aWant = -Math.max(-0.35, Math.min(0.35, KP_X * s.x + KD_X * s.vx));
    const accA = KP_A * (aWant - s.a) - KD_A * s.w;
    const col = (M * (G + KP_Y * (HOVER_Y - s.y) - KD_Y * s.vy)) / Math.max(0.5, Math.cos(s.a));
    // mixer: right motor higher -> the right side lifts -> leans left (a decreases)
    const diff = (-accA * I) / (2 * L);
    let tr = col / 2 + diff, tl = col / 2 - diff;
    const top = Math.max(tr, tl);
    if (top > tmax) { tr -= top - tmax; tl -= top - tmax; } // keep the correction, give up height
    tr = Math.max(0, Math.min(tmax, tr));
    tl = Math.max(0, Math.min(tmax, tl));
    s.tr = tr / tmax; s.tl = tl / tmax;
    s.sat = Math.max(s.sat * 0.98, top > tmax ? 1 : 0);
    const f = tr + tl;
    s.vx += (f * Math.sin(s.a) / M) * dt;
    s.vy += (f * Math.cos(s.a) / M - G) * dt;
    s.w += (-(tr - tl) * L / I) * dt;
    s.x += s.vx * dt; s.y += s.vy * dt; s.a += s.w * dt;
    s.minY = Math.min(s.minY, s.y);
    if (s.y <= 0) {
      if (s.vy < -1.4 || Math.abs(s.a) > 0.6) s.crashed = 1.6;
      s.y = 0; s.vy = Math.max(0, s.vy); s.vx *= 0.8; s.a *= 0.85; s.w *= 0.5;
    }
    if (Math.abs(s.x) > 1.6) s.crashed = 1.2;
  }

  function draw() {
    const { w: W, h: H } = cv.fit();
    const g = cv.g;
    g.clearRect(0, 0, W, H);
    const ppm = H / 1.75; // pixels per metre
    const gy = H - 22;
    const X = (m: number) => W / 2 + m * ppm, Y = (m: number) => gy - m * ppm;
    // ground and hover line
    g.strokeStyle = '#2a2c31';
    g.beginPath(); g.moveTo(0, gy); g.lineTo(W, gy); g.stroke();
    g.setLineDash([5, 5]);
    g.beginPath(); g.moveTo(0, Y(HOVER_Y)); g.lineTo(W, Y(HOVER_Y)); g.stroke();
    g.setLineDash([]);
    g.font = '11px ui-monospace, Consolas, monospace';
    g.fillStyle = '#6f7580';
    g.fillText('target height', 8, Y(HOVER_Y) - 6);
    // altitude trail
    g.strokeStyle = 'rgba(74,155,255,0.35)';
    g.beginPath();
    trail.forEach((y, i) => { const px = W - (trail.length - i) * 2.2, py = Y(y); i ? g.lineTo(px, py) : g.moveTo(px, py); });
    g.stroke();
    // the drone: body, arms, motors, props, thrust bars
    g.save();
    g.translate(X(s.x), Y(s.y) - 8);
    g.rotate(s.a);
    const arm = L * ppm * 1.6;
    g.fillStyle = '#3a3f48';
    g.fillRect(-arm, -3, arm * 2, 6);
    g.fillStyle = '#5b616c';
    g.fillRect(-18, -14, 36, 16);
    g.fillStyle = '#cdefff';
    g.fillRect(-9, -10, 18, 7);
    for (const [side, t] of [[-1, s.tl], [1, s.tr]] as const) {
      const mx = side * arm;
      g.fillStyle = '#8a929e';
      g.fillRect(mx - 4, -10, 8, 8);
      g.strokeStyle = s.crashed ? '#6f7580' : 'rgba(205,215,228,0.7)';
      g.beginPath(); g.moveTo(mx - 24, -12); g.lineTo(mx + 24, -12); g.stroke();
      // thrust: arrow length is this motor's output, the tick is its maximum
      const full = 46;
      g.strokeStyle = t > 0.985 ? '#ff6b5a' : '#f2b84b';
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(mx, -16); g.lineTo(mx, -16 - full * t); g.stroke();
      g.lineWidth = 1;
      g.strokeStyle = '#6f7580';
      g.beginPath(); g.moveTo(mx - 6, -16 - full); g.lineTo(mx + 6, -16 - full); g.stroke();
    }
    g.restore();
    if (s.crashed) { g.fillStyle = '#ff6b5a'; g.fillText('crashed', X(s.x) - 24, gy - 40); }
  }

  let frames = 0;
  whileVisible(cv.el, (_t, dt) => {
    for (let k = 0; k < SUB; k++) physics(dt / SUB);
    s.nextGust -= dt;
    if (s.nextGust <= 0) { gust(0.8 + Math.random() * 0.5); s.nextGust = 3.2 + Math.random() * 1.5; }
    if (++frames % 2 === 0) { trail.push(s.y); if (trail.length > 400) trail.shift(); }
    draw();
    if (frames % 6 === 0) {
      const hoverPct = Math.round(100 / tw);
      const state = tw < 1 ? 'can’t lift off' : s.crashed ? 'crashed' : s.sat > 0.5 ? 'out of spare thrust, sinking' : HOVER_Y - s.minY > 0.25 ? 'caught itself, barely' : 'snaps back';
      stats.innerHTML = `<span><b>${Math.min(100, hoverPct)}%</b> throttle just to hover</span><span><b>${Math.max(0, 100 - hoverPct)}%</b> left for corrections</span>`
        + `<span><b>${Math.max(0, (HOVER_Y - s.minY) * 100).toFixed(0)} cm</b> lost on the last push</span><span>${state}</span>`;
    }
  });
}
