// Matrix Game Board: the nine 8x8 white LED matrices on the top of the model light up.
// The dots are located from the model's own LED mesh (material "Opaque(165,165,165)", 576 flat discs
// in 3 x 3 modules). Animations draw into a 24 x 24 framebuffer that maps onto the modules, with the
// real gap between modules skipped, so a pattern that crosses modules looks like the physical board.

import * as THREE from '../three-lite';
import { glowMaterial } from './shared';
import type { EffectContext, Effect } from './types';

const N = 24;
// dot centres along one axis, from the CAD: pitch 0.3975, 8 per module, 1.28 between module edges
const AXIS = (() => {
  const out: number[] = [];
  for (let m = 0; m < 3; m++) for (let k = 0; k < 8; k++) out.push(-5.45 + m * (7 * 0.3975 + 1.3025) + k * 0.3975);
  const span = out[out.length - 1] - out[0];
  return out.map((v) => (v - out[0]) / span); // 0..1
})();

// ---------------------------------------------------------------- tiny 5x7 font
const FONT: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'], E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'], I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'], O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'], R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'], U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'], X: ['10001', '01010', '00100', '00100', '00100', '01010', '10001'],
  Y: ['10001', '01010', '00100', '00100', '00100', '00100', '00100'], N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'], L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

type Frame = Float32Array; // N*N brightness 0..1, row 0 = far side, col 0 = left
type Show = { name: string; seconds: number; start: () => void; draw: (fb: Frame, t: number, dt: number) => void };

const idx = (x: number, y: number) => y * N + x;
const set = (fb: Frame, x: number, y: number, v = 1) => { if (x >= 0 && y >= 0 && x < N && y < N) fb[idx(x, y)] = Math.max(fb[idx(x, y)], v); };
const rand = (n: number) => Math.floor(Math.random() * n);

// ---------------------------------------------------------------- shows
function ticTacToe(): Show {
  let board: number[] = [], turn = 1, next = 0, winLine: number[] | null = null, doneAt = 0, placedAt: number[] = [];
  const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
  const winner = () => LINES.find((l) => board[l[0]] && board[l[0]] === board[l[1]] && board[l[1]] === board[l[2]]) ?? null;
  const pick = () => {
    const empty = board.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    // win if possible, block if needed, else centre, else random
    for (const who of [turn, 3 - turn]) for (const l of LINES) {
      const vals = l.map((i) => board[i]);
      if (vals.filter((v) => v === who).length === 2 && vals.includes(0) && Math.random() < 0.85) return l[vals.indexOf(0)];
    }
    if (!board[4] && Math.random() < 0.7) return 4;
    return empty[rand(empty.length)];
  };
  return {
    name: 'tic tac toe', seconds: 14,
    start() { board = Array(9).fill(0); turn = 1; next = 0.8; winLine = null; doneAt = 0; placedAt = Array(9).fill(0); },
    draw(fb, t) {
      if (!winLine && !doneAt && t > next && board.includes(0)) {
        const c = pick();
        board[c] = turn; placedAt[c] = t; turn = 3 - turn; next = t + 1.1;
        winLine = winner();
        if (winLine || !board.includes(0)) doneAt = t;
      }
      if (doneAt && t > doneAt + 3.2) this.start();
      for (let c = 0; c < 9; c++) {
        if (!board[c]) continue;
        const ox = (c % 3) * 8, oy = Math.floor(c / 3) * 8;
        const grow = Math.min(1, (t - placedAt[c]) / 0.45); // the mark draws itself in
        const flash = winLine?.includes(c) ? 0.55 + 0.45 * Math.sign(Math.sin((t - doneAt) * 14)) : 1;
        if (board[c] === 1) {
          const n = Math.ceil(grow * 6);
          for (let k = 0; k < n; k++) { set(fb, ox + 1 + k, oy + 1 + k, flash); set(fb, ox + 6 - k, oy + 1 + k, flash); }
        } else {
          const pts = [[2, 1], [3, 1], [4, 1], [5, 1], [6, 2], [6, 3], [6, 4], [6, 5], [5, 6], [4, 6], [3, 6], [2, 6], [1, 5], [1, 4], [1, 3], [1, 2]];
          pts.slice(0, Math.ceil(grow * pts.length)).forEach(([x, y]) => set(fb, ox + x, oy + y, flash));
        }
      }
    },
  };
}

function marquee(text: string): Show {
  const cols: number[][] = [];
  for (const ch of text) { const g = FONT[ch] ?? FONT[' ']; for (let x = 0; x < 5; x++) cols.push(g.map((r) => Number(r[x]))); cols.push([0, 0, 0, 0, 0, 0, 0]); }
  return {
    name: 'marquee', seconds: 11, start() {},
    draw(fb, t) {
      const off = Math.floor(t * 9) % (cols.length + N) - N;
      for (let x = 0; x < N; x++) {
        const col = cols[x + off];
        if (col) col.forEach((v, y) => v && set(fb, x, 8 + y));
      }
      // thin rails above and below the text
      for (let x = 0; x < N; x++) { if ((x + Math.floor(t * 9)) % 3 === 0) { set(fb, x, 6, 0.35); set(fb, x, 16, 0.35); } }
    },
  };
}

function silhouettes(): Show {
  // an original black and white shadow play across all nine modules: a falling apple that bounces,
  // splits into two, and a moon rising behind a hill
  return {
    name: 'silhouettes', seconds: 16, start() {},
    draw(fb, t) {
      const phase = t % 16;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        let on = 0;
        if (phase < 8) {
          // white sky, dark apple falling and bouncing
          const bounce = Math.abs(Math.cos(phase * 1.4)) * Math.exp(-phase * 0.35);
          const cy = 17 - bounce * 12, cx = 12 + Math.sin(phase * 0.6) * 4;
          const dx = x - cx, dy = (y - cy) * 1.1;
          const apple = dx * dx + dy * dy < 20 || (Math.abs(x - cx) < 1 && y < cy - 3 && y > cy - 7);
          const leaf = (x - cx - 2) ** 2 + (y - cy + 6) ** 2 < 2.5;
          const ground = y >= 22;
          on = apple || leaf || ground ? 0 : 1;
        } else {
          // night: dark sky, a moon rising, hills in white outline
          const p = phase - 8;
          const my = 18 - p * 1.8, mx = 16;
          const moon = (x - mx) ** 2 + (y - my) ** 2 < 14 && (x - mx - 2) ** 2 + (y - my + 1) ** 2 > 10;
          const hill = y > 17 + 3 * Math.sin(x * 0.35 + 1) ;
          const star = ((x * 7 + y * 13) % 29 === 0 && Math.sin(t * 3 + x) > 0) ? 0.5 : 0;
          on = moon ? 1 : hill ? 0.9 : star;
        }
        if (on) set(fb, x, y, on);
      }
    },
  };
}

function snake(): Show {
  let body: [number, number][] = [], dir = [1, 0], food: [number, number] = [0, 0], acc = 0;
  const place = () => { do { food = [rand(N), rand(N)]; } while (body.some(([x, y]) => x === food[0] && y === food[1])); };
  return {
    name: 'snake', seconds: 14,
    start() { body = [[4, 12], [3, 12], [2, 12]]; dir = [1, 0]; place(); acc = 0; },
    draw(fb, _t, dt) {
      acc += dt;
      while (acc > 0.09) {
        acc -= 0.09;
        const [hx, hy] = body[0];
        // steer toward the food, avoiding itself
        const options = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([x, y]) => !(x === -dir[0] && y === -dir[1]));
        options.sort((a, b) => Math.abs(hx + a[0] - food[0]) + Math.abs(hy + a[1] - food[1]) - (Math.abs(hx + b[0] - food[0]) + Math.abs(hy + b[1] - food[1])));
        const ok = options.find(([x, y]) => { const nx = (hx + x + N) % N, ny = (hy + y + N) % N; return !body.some(([bx, by]) => bx === nx && by === ny); });
        if (!ok) { this.start(); return; }
        dir = ok;
        const head: [number, number] = [(hx + dir[0] + N) % N, (hy + dir[1] + N) % N];
        body.unshift(head);
        if (head[0] === food[0] && head[1] === food[1]) place(); else body.pop();
        if (body.length > 60) this.start();
      }
      body.forEach(([x, y], i) => set(fb, x, y, i === 0 ? 1 : 0.75));
      if (Math.floor(_t * 6) % 2) set(fb, food[0], food[1], 1);
    },
  };
}

function life(): Show {
  let grid = new Uint8Array(N * N), acc = 0;
  return {
    name: 'life', seconds: 12,
    start() { grid = new Uint8Array(N * N).map(() => (Math.random() < 0.32 ? 1 : 0)); acc = 0; },
    draw(fb, _t, dt) {
      acc += dt;
      if (acc > 0.16) {
        acc = 0;
        const next = new Uint8Array(N * N);
        let alive = 0;
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
          let n = 0;
          for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (i || j) n += grid[idx((x + i + N) % N, (y + j + N) % N)];
          const v = n === 3 || (n === 2 && grid[idx(x, y)]) ? 1 : 0;
          next[idx(x, y)] = v;
          alive += v;
        }
        grid = alive < 12 ? new Uint8Array(N * N).map(() => (Math.random() < 0.32 ? 1 : 0)) : next;
      }
      for (let i = 0; i < N * N; i++) if (grid[i]) fb[i] = 1;
    },
  };
}

function pong(): Show {
  let bx = 12, by = 12, vx = 9, vy = 6, lp = 12, rp = 12;
  return {
    name: 'pong', seconds: 12,
    start() { bx = 12; by = 12; vx = 9 * (Math.random() < 0.5 ? 1 : -1); vy = 6 * (Math.random() < 0.5 ? 1 : -1); },
    draw(fb, _t, dt) {
      bx += vx * dt; by += vy * dt;
      if (by < 0 || by > N - 1) { vy = -vy; by = Math.max(0, Math.min(N - 1, by)); }
      lp += Math.sign(by - lp) * Math.min(Math.abs(by - lp), 14 * dt);
      rp += Math.sign(by - rp) * Math.min(Math.abs(by - rp), 12 * dt);
      if (bx < 1.5 && Math.abs(by - lp) < 3) { vx = Math.abs(vx) * 1.03; }
      if (bx > N - 2.5 && Math.abs(by - rp) < 3) { vx = -Math.abs(vx) * 1.03; }
      if (bx < -1 || bx > N) this.start();
      for (let k = -2; k <= 2; k++) { set(fb, 0, Math.round(lp) + k); set(fb, N - 1, Math.round(rp) + k); }
      for (let y = 0; y < N; y += 2) set(fb, 12, y, 0.25);
      set(fb, Math.round(bx), Math.round(by));
    },
  };
}

function rain(): Show {
  const drops = Array.from({ length: 18 }, () => ({ x: rand(N), y: Math.random() * N, v: 8 + Math.random() * 10 }));
  return {
    name: 'rain', seconds: 9, start() {},
    draw(fb, _t, dt) {
      for (const d of drops) {
        d.y += d.v * dt;
        if (d.y > N + 4) { d.y = -rand(8); d.x = rand(N); }
        for (let k = 0; k < 4; k++) set(fb, d.x, Math.floor(d.y) - k, 1 - k * 0.28);
      }
    },
  };
}

// ---------------------------------------------------------------- effect
export default function matrix(ctx: EffectContext): Effect {
  ctx.body.updateMatrixWorld(true);
  const toBody = new THREE.Matrix4().copy(ctx.body.matrixWorld).invert();
  // The LED dot field, in body space. Model optimisation merges similar greys, so instead of trusting one
  // material name, take the light grey part whose top-down footprint is the largest square.
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  let bestArea = 0;
  ctx.model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    if (!/^Opaque\((1[4-7]\d),(1[3-7]\d),(1[3-7]\d)\)/.test(mat.name)) return;
    const b = new THREE.Box3();
    const pos = mesh.geometry.attributes.position;
    const m = new THREE.Matrix4().multiplyMatrices(toBody, mesh.matrixWorld);
    for (let i = 0; i < pos.count; i++) b.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m));
    const w = b.max.x - b.min.x, d = b.max.z - b.min.z;
    if (Math.abs(w - d) / Math.max(w, d) < 0.08 && w * d > bestArea) { bestArea = w * d; box.copy(b); }
  });
  if (box.isEmpty()) return { update() {} };
  const size = box.getSize(new THREE.Vector3());
  const dot = Math.min(size.x, size.z) * (0.299 / 11.2); // disc diameter relative to the dot field
  const x0 = box.min.x + dot / 2, x1 = box.max.x - dot / 2, z0 = box.min.z + dot / 2, z1 = box.max.z - dot / 2;
  const top = box.max.y + dot * 0.08;

  const disc = new THREE.CircleGeometry(dot * 0.52, 14).rotateX(-Math.PI / 2);
  const halo = new THREE.PlaneGeometry(dot * 2.6, dot * 2.6).rotateX(-Math.PI / 2);
  const ledMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const haloMat = glowMaterial({
    vertexShader: /* glsl */ `varying vec2 vUv; varying vec3 vC; void main() { vUv = uv; vC = instanceColor; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `varying vec2 vUv; varying vec3 vC; void main() { float d = length(vUv - 0.5) * 2.0; gl_FragColor = vec4(vC * pow(max(0.0, 1.0 - d), 2.2) * 0.55, 0.0); }`,
  });
  const leds = new THREE.InstancedMesh(disc, ledMat, N * N);
  const glow = new THREE.InstancedMesh(halo, haloMat, N * N);
  const mtx = new THREE.Matrix4();
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    mtx.makeTranslation(THREE.MathUtils.lerp(x0, x1, AXIS[x]), top, THREE.MathUtils.lerp(z0, z1, AXIS[y]));
    leds.setMatrixAt(idx(x, y), mtx);
    mtx.elements[13] += dot * 0.02;
    glow.setMatrixAt(idx(x, y), mtx);
  }
  const off = new THREE.Color(0x16181c), c = new THREE.Color();
  for (let i = 0; i < N * N; i++) { leds.setColorAt(i, off); glow.setColorAt(i, off.clone().setScalar(0)); }
  glow.renderOrder = 6;
  ctx.body.add(leds, glow);

  const fb: Frame = new Float32Array(N * N);
  const shown: Frame = new Float32Array(N * N);
  const shows = [ticTacToe(), marquee('MATRIX GAME BOARD'), silhouettes(), snake(), life(), pong(), rain()];
  let current = -1, started = 0;

  return {
    update(t, dt) {
      if (current < 0 || t - started > shows[current].seconds) {
        current = (current + 1) % shows.length;
        started = t;
        shows[current].start();
      }
      fb.fill(0);
      shows[current].draw(fb, t - started, Math.min(dt, 0.1));
      // LEDs fade out quickly and switch on instantly, like the real matrices
      const fall = Math.exp(-Math.max(dt, 0) * 18);
      for (let i = 0; i < N * N; i++) {
        shown[i] = Math.max(fb[i], shown[i] * fall);
        const b = shown[i];
        c.copy(off).lerp(new THREE.Color(1, 1, 1), b);
        leds.setColorAt(i, c);
        glow.setColorAt(i, c.setScalar(b));
      }
      leds.instanceColor!.needsUpdate = true;
      glow.instanceColor!.needsUpdate = true;
    },
  };
}
