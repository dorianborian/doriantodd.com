// Foraging arena: food becomes senses the fly understands. Bearing recruits left or right LLPC1
// motion neurons, food ahead recruits LC9, distance drives vinegar smell, arrival triggers sugar.
// Click the field to drop food. Swap the eyes or blind the fly to reproduce the controls.

import { canvas, frame, h, segmented, whileVisible } from './ui';

const FIELD = { w: 121.92, h: 60.96 }; // cm, same field as the project config

export default function forage(el: HTMLElement) {
  const body = frame(el, 'Foraging arena, steered only by the brain', 'Click the field to drop food');
  const top = h('div', { class: 'widget-row' });
  const cv = canvas(body, FIELD.w / FIELD.h);
  const senses = h('div', { class: 'forage-senses' });
  body.prepend(top);
  body.append(senses);
  let mode = 'normal';
  const modePick = segmented([{ id: 'normal', label: 'Normal' }, { id: 'blind', label: 'Blind' }, { id: 'swapped', label: 'Eyes swapped' }], mode, (id) => { mode = id; eaten = 0; });
  const reset = h('button', { type: 'button', class: 'widget-btn' }, 'Reset');
  top.append(modePick.el, reset);

  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  const newFood = () => ({ x: rnd(-50, 50), y: rnd(-22, 22), cool: 0 });
  let foods = [newFood(), newFood(), newFood()];
  const bot = { x: -40, y: 0, yaw: 0, speed: 0, turn: 0 };
  let eaten = 0, sugar = 0;
  const trail: [number, number][] = [];
  reset.addEventListener('click', () => { foods = [newFood(), newFood(), newFood()]; Object.assign(bot, { x: -40, y: 0, yaw: 0 }); eaten = 0; trail.length = 0; });

  cv.el.addEventListener('click', (e) => {
    const r = cv.el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width - 0.5) * FIELD.w;
    const y = (0.5 - (e.clientY - r.top) / r.height) * FIELD.h;
    foods.push({ x, y, cool: 0 });
    if (foods.length > 6) foods.shift();
  });

  const bars = ['LLPC1 left', 'LLPC1 right', 'LC9 ahead', 'Vinegar ORNs', 'Sugar GRNs', 'DNa02 left', 'DNa02 right', 'Walk DNs'].map((label) => {
    const fill = h('i');
    senses.append(h('div', { class: 'forage-bar' }, h('span', {}, label), h('b', {}, fill)));
    return fill;
  });

  whileVisible(el, (_t, dt) => {
    // nearest available food, bearing relative to heading (positive = left)
    let target: (typeof foods)[number] | null = null, best = Infinity;
    for (const f of foods) { f.cool = Math.max(0, f.cool - dt); const d = Math.hypot(f.x - bot.x, f.y - bot.y); if (!f.cool && d < best) { best = d; target = f; } }
    let left = 0, right = 0, ahead = 0, smell = 0;
    if (target && mode !== 'blind') {
      const bearing = Math.atan2(Math.sin(Math.atan2(target.y - bot.y, target.x - bot.x) - bot.yaw), Math.cos(Math.atan2(target.y - bot.y, target.x - bot.x) - bot.yaw)) * (180 / Math.PI);
      const frac = (a: number) => Math.min(1, Math.max(0, (Math.abs(a) - 12) / (70 - 12)));
      if (bearing > 12) left = Math.ceil(frac(bearing) * 10) / 10;
      if (bearing < -12) right = Math.ceil(frac(bearing) * 10) / 10;
      if (Math.abs(bearing) < 30) ahead = Math.round((1 - Math.abs(bearing) / 30) * 10) / 10;
      smell = Math.exp(-best / 45);
      if (mode === 'swapped') [left, right] = [right, left];
      if (best < 12) { target.cool = 30; eaten++; sugar = 2.5; }
    }
    sugar = Math.max(0, sugar - dt);
    // descending neurons: same-side motion neurons drive same-side DNa02, LC9 drives walking
    const dnaL = left, dnaR = right, walkDN = Math.max(ahead, (left + right) * 0.35);
    const feeding = sugar > 0;
    const turn = feeding ? 0 : (dnaL - dnaR) * 1.4;
    const speed = feeding ? 0 : walkDN * 9;
    bot.turn += (turn - bot.turn) * Math.min(1, dt * 4);
    bot.speed += (speed - bot.speed) * Math.min(1, dt * 3);
    bot.yaw += bot.turn * dt;
    bot.x = Math.max(-FIELD.w / 2 + 5, Math.min(FIELD.w / 2 - 5, bot.x + Math.cos(bot.yaw) * bot.speed * dt));
    bot.y = Math.max(-FIELD.h / 2 + 5, Math.min(FIELD.h / 2 - 5, bot.y + Math.sin(bot.yaw) * bot.speed * dt));
    if (!trail.length || Math.hypot(trail[trail.length - 1][0] - bot.x, trail[trail.length - 1][1] - bot.y) > 0.8) trail.push([bot.x, bot.y]);
    if (trail.length > 300) trail.shift();
    [left, right, ahead, smell, feeding ? 1 : 0, dnaL, dnaR, walkDN].forEach((v, i) => (bars[i].style.width = `${Math.round(v * 100)}%`));

    const { w, h: H } = cv.fit();
    const g = cv.g;
    const X = (x: number) => (x / FIELD.w + 0.5) * w, Y = (y: number) => (0.5 - y / FIELD.h) * H, S = w / FIELD.w;
    g.clearRect(0, 0, w, H);
    g.strokeStyle = '#2a2c31';
    for (let x = -60; x <= 60; x += 10) { g.beginPath(); g.moveTo(X(x), 0); g.lineTo(X(x), H); g.stroke(); }
    for (let y = -30; y <= 30; y += 10) { g.beginPath(); g.moveTo(0, Y(y)); g.lineTo(w, Y(y)); g.stroke(); }
    // corner markers
    g.fillStyle = '#dfe3e8';
    for (const [cx, cy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.fillRect(X(cx * (FIELD.w / 2 - 3)) - 5, Y(cy * (FIELD.h / 2 - 3)) - 5, 10, 10);
    // food
    for (const f of foods) {
      g.fillStyle = f.cool ? 'rgba(111,117,128,0.5)' : '#57ab5a';
      g.beginPath(); g.arc(X(f.x), Y(f.y), 6, 0, Math.PI * 2); g.fill();
      if (!f.cool) { g.strokeStyle = 'rgba(87,171,90,0.25)'; g.beginPath(); g.arc(X(f.x), Y(f.y), 12 * S, 0, Math.PI * 2); g.stroke(); }
    }
    g.strokeStyle = 'rgba(74,155,255,0.45)';
    g.lineWidth = 2;
    g.beginPath();
    trail.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
    g.stroke();
    g.lineWidth = 1;
    // robot with its view cone
    g.save();
    g.translate(X(bot.x), Y(bot.y));
    g.rotate(-bot.yaw);
    g.fillStyle = mode === 'blind' ? 'rgba(111,117,128,0.08)' : 'rgba(242,184,75,0.1)';
    g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, 26 * S, -Math.PI / 6, Math.PI / 6); g.closePath(); g.fill();
    g.fillStyle = feeding ? '#57ab5a' : '#4a9bff';
    g.fillRect(-10, -7, 20, 14);
    g.fillStyle = '#16171a';
    g.fillRect(5, -4, 4, 8);
    g.restore();
    g.fillStyle = '#9aa3b0';
    g.font = '12px ui-monospace, Consolas, monospace';
    g.fillText(`${eaten} eaten${feeding ? '  feeding' : ''}`, 10, 18);
  });
}
