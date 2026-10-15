// Shared parts of the two PenBot scenes: the line art library, a pen path follower (travel, lower, draw, raise),
// the paper sheets with their ink canvases, and the pile the finished drawings are tossed onto.
//
// Everything here works in a "desk" frame: x/y is the drawing plane, +z points up, units are metres.

import * as THREE from '../three-lite';
import { rand } from './shared';

type Pt = [number, number];

/** Catmull-Rom through the points, `n` samples per span. */
function smooth(pts: Pt[], n = 8, closed = false): Pt[] {
  const out: Pt[] = [];
  const P = closed ? [pts[pts.length - 1], ...pts, pts[0], pts[1]] : [pts[0], ...pts, pts[pts.length - 1]];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(closed ? out[0] : pts[pts.length - 1]);
  return out;
}

const curve = (n: number, f: (t: number) => Pt, t0 = 0, t1 = Math.PI * 2): Pt[] => {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) out.push(f(t0 + ((t1 - t0) * i) / n));
  return out;
};
const circle = (cx: number, cy: number, r: number, n = 40, rx = r): Pt[] => curve(n, (t) => [cx + Math.cos(t) * rx, cy + Math.sin(t) * r]);
const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
function roundRect(x0: number, y0: number, x1: number, y1: number, r: number): Pt[] {
  const out: Pt[] = [];
  const corners: [number, number, number][] = [[x1 - r, y0 + r, -Math.PI / 2], [x1 - r, y1 - r, 0], [x0 + r, y1 - r, Math.PI / 2], [x0 + r, y0 + r, Math.PI]];
  for (const [cx, cy, a] of corners) for (let k = 0; k <= 6; k++) out.push([cx + Math.cos(a + (k / 6) * (Math.PI / 2)) * r, cy + Math.sin(a + (k / 6) * (Math.PI / 2)) * r]);
  out.push(out[0]);
  return out;
}

/** The line art, as strokes in any units with y up (fitted to the drawing box later). */
const ART: Record<string, () => Pt[][]> = {
  star: () => [curve(5, (t) => [Math.cos(Math.PI / 2 + t), Math.sin(Math.PI / 2 + t)], 0, Math.PI * 4)],
  spiral: () => [curve(260, (t) => { const r = 0.06 + (t / (Math.PI * 2)) * 0.19; return [Math.cos(t) * r, Math.sin(t) * r]; }, 0, Math.PI * 2 * 5)],
  flower: () => [
    curve(220, (t) => [Math.cos(5 * t) * Math.cos(t), Math.cos(5 * t) * Math.sin(t) + 0.6], 0, Math.PI),
    circle(0, 0.6, 0.16, 24),
    smooth([[0, -0.42], [0.06, -0.9], [-0.02, -1.4], [0.04, -1.9]]),
    smooth([[0.02, -1.25], [0.3, -1.05], [0.62, -1.0], [0.42, -1.22], [0.02, -1.25]]),
  ],
  house: () => [
    rect(-1, -1, 1, 0.35),
    [[-1.2, 0.2], [0, 1.25], [1.2, 0.2]],
    [[-0.28, -1], [-0.28, -0.25], [0.28, -0.25], [0.28, -1]],
    rect(0.45, -0.4, 0.82, -0.03),
    [[0.635, -0.4], [0.635, -0.03]],
    [[0.48, 0.83], [0.48, 1.15], [0.74, 1.15], [0.74, 0.6]],
  ],
  // Sesame's OLED face
  sesame: () => [
    roundRect(-1.1, -0.75, 1.1, 0.75, 0.32),
    roundRect(-0.68, -0.12, -0.28, 0.36, 0.14),
    roundRect(0.28, -0.12, 0.68, 0.36, 0.14),
    smooth([[-0.36, -0.36], [-0.12, -0.52], [0.12, -0.52], [0.36, -0.36]]),
    [[-0.1, 0.75], [-0.1, 1.0]], circle(-0.1, 1.08, 0.08, 16),
  ],
  gear: () => {
    const pts: Pt[] = [];
    const n = 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, s = (Math.PI * 2) / n;
      pts.push([Math.cos(a) * 0.78, Math.sin(a) * 0.78], [Math.cos(a + s * 0.12) * 1, Math.sin(a + s * 0.12) * 1],
        [Math.cos(a + s * 0.38) * 1, Math.sin(a + s * 0.38) * 1], [Math.cos(a + s * 0.5) * 0.78, Math.sin(a + s * 0.5) * 0.78]);
    }
    pts.push(pts[0]);
    return [pts, circle(0, 0, 0.3, 28), circle(0.52, 0, 0.09, 12), circle(-0.52, 0, 0.09, 12), circle(0, 0.52, 0.09, 12), circle(0, -0.52, 0.09, 12)];
  },
  heart: () => [curve(120, (t) => [16 * Math.sin(t) ** 3, 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)])],
  lissajous: () => [curve(300, (t) => [Math.sin(3 * t + Math.PI / 2) * 1.5, Math.sin(4 * t)])],
  // cursive "hello", one stroke
  hello: () => [smooth([
    [0, 0.05], [0.3, 0.5], [0.55, 1.2], [0.58, 1.68], [0.46, 1.8], [0.34, 1.58], [0.32, 0.9], [0.3, 0.02],
    [0.42, 0.5], [0.62, 0.72], [0.8, 0.62], [0.82, 0.3], [0.84, 0.06], [1.0, 0.02], [1.22, 0.24],
    [1.46, 0.46], [1.44, 0.7], [1.28, 0.7], [1.18, 0.44], [1.24, 0.1], [1.44, 0.0], [1.66, 0.16],
    [1.92, 0.75], [2.04, 1.45], [1.98, 1.78], [1.84, 1.72], [1.8, 1.3], [1.84, 0.5], [1.94, 0.06], [2.1, 0.02], [2.24, 0.18],
    [2.48, 0.75], [2.6, 1.45], [2.54, 1.78], [2.4, 1.72], [2.36, 1.3], [2.4, 0.5], [2.5, 0.06], [2.66, 0.02], [2.82, 0.22],
    [2.96, 0.58], [3.16, 0.68], [3.3, 0.46], [3.22, 0.1], [3.02, 0.02], [2.94, 0.3], [3.12, 0.62], [3.4, 0.7], [3.62, 0.62],
  ], 6)],
};
export const ART_NAMES = Object.keys(ART);

export type Drawing = { name: string; strokes: Float32Array[]; length: number };

/** Fits a drawing into a w x h box centred on (cx, cy), returned as flat x,y arrays. */
export function layout(name: string, cx: number, cy: number, w: number, h: number): Drawing {
  const raw = ART[name]();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of raw) for (const [x, y] of s) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const k = Math.min(w / (x1 - x0), h / (y1 - y0));
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  let length = 0;
  const strokes = raw.map((s) => {
    const a = new Float32Array(s.length * 2);
    s.forEach(([x, y], i) => {
      a[i * 2] = cx + (x - mx) * k;
      a[i * 2 + 1] = cy + (y - my) * k;
      if (i) length += Math.hypot(a[i * 2] - a[i * 2 - 2], a[i * 2 + 1] - a[i * 2 - 1]);
    });
    return a;
  });
  return { name, strokes, length };
}

const ease = (t: number) => t * t * (3 - 2 * t);

/**
 * Walks the pen through a drawing: travel to a stroke with the pen up, lower, draw at constant speed, raise.
 * `x, y` is the pen target, `lift` 0 (on the paper) .. 1 (fully up).
 */
export class PenPath {
  x = 0;
  y = 0;
  lift = 1;
  phase: 'idle' | 'travel' | 'lower' | 'draw' | 'raise' | 'done' = 'idle';
  /** distance drawn along the current drawing (for wobble noise) */
  drawn = 0;
  private d: Drawing | null = null;
  private stroke = 0;
  private seg = 0;
  private segT = 0;
  private t = 0;
  private dur = 0;
  private fx = 0;
  private fy = 0;
  private tx = 0;
  private ty = 0;
  constructor(public speed: number, public travelSpeed: number, public liftTime: number) {}

  start(d: Drawing, speed: number) {
    this.d = d;
    this.speed = speed;
    this.stroke = 0;
    this.drawn = 0;
    this.goTo(d.strokes[0][0], d.strokes[0][1]);
  }

  /** Pen-up move to a point (also used to park). */
  goTo(x: number, y: number) {
    this.fx = this.x; this.fy = this.y; this.tx = x; this.ty = y;
    this.t = 0;
    this.dur = Math.max(0.15, Math.hypot(x - this.x, y - this.y) / this.travelSpeed);
    this.phase = this.lift < 1 ? 'raise' : 'travel';
  }

  step(dt: number) {
    switch (this.phase) {
      case 'raise':
        this.lift = Math.min(1, this.lift + dt / this.liftTime);
        if (this.lift >= 1) {
          if (this.d && this.stroke < this.d.strokes.length) this.phase = 'travel';
          else if (this.d) { this.phase = 'done'; this.d = null; } else this.phase = 'travel';
        }
        break;
      case 'travel': {
        this.t = Math.min(1, this.t + dt / this.dur);
        const e = ease(this.t);
        this.x = this.fx + (this.tx - this.fx) * e;
        this.y = this.fy + (this.ty - this.fy) * e;
        if (this.t >= 1) this.phase = this.d ? 'lower' : 'idle';
        break;
      }
      case 'lower':
        this.lift = Math.max(0, this.lift - dt / this.liftTime);
        if (this.lift <= 0) { this.phase = 'draw'; this.seg = 0; this.segT = 0; }
        break;
      case 'draw': {
        const s = this.d!.strokes[this.stroke];
        let left = this.speed * dt;
        while (left > 0 && this.seg < s.length / 2 - 1) {
          const i = this.seg * 2;
          const len = Math.hypot(s[i + 2] - s[i], s[i + 3] - s[i + 1]) || 1e-9;
          const take = Math.min(left, len - this.segT);
          this.segT += take;
          left -= take;
          this.drawn += take;
          const f = this.segT / len;
          this.x = s[i] + (s[i + 2] - s[i]) * f;
          this.y = s[i + 1] + (s[i + 3] - s[i + 1]) * f;
          if (this.segT >= len - 1e-9) { this.seg++; this.segT = 0; }
        }
        if (this.seg >= s.length / 2 - 1) {
          this.stroke++;
          this.phase = 'raise';
          const next = this.d!.strokes[this.stroke];
          if (next) { this.fx = this.x; this.fy = this.y; this.tx = next[0]; this.ty = next[1]; this.t = 0; this.dur = Math.max(0.08, Math.hypot(this.tx - this.x, this.ty - this.y) / this.travelSpeed); }
        }
        break;
      }
      default:
    }
  }
}

type Sheet = {
  mesh: THREE.Mesh;
  top: THREE.MeshStandardMaterial;
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
  // pose in the desk frame and where it is heading
  from: THREE.Vector3;
  to: THREE.Vector3;
  yaw0: number;
  yaw1: number;
  spin: number;
  t: number;
  dur: number;
  arc: number;
  flying: boolean;
};

export type SheetOptions = {
  /** sheet size (m) */
  w: number;
  h: number;
  /** drawn thickness of one sheet (exaggerated so the pile reads) */
  thick: number;
  /** centre of the paper while it is being drawn on, z = surface under it */
  paper: THREE.Vector3;
  /** centre of the pile base */
  pile: THREE.Vector3;
  /** sheets kept on the pile before the oldest are recycled */
  cap: number;
  /** pixels per metre of the drawing canvas */
  ppm: number;
  /** ink line width (m) */
  ink: number;
  /** where new sheets come from (offset from the paper spot) and how high the toss arcs */
  arc: number;
};

const PILE_RES = 0.5; // pile copies are stored at half the drawing resolution

/** The sheet being drawn on, the throws and the growing pile. */
export class Sheets {
  readonly group = new THREE.Group();
  active!: Sheet;
  private pile: Sheet[] = [];
  private free: Sheet[] = [];
  private flying: Sheet[] = [];
  private big: HTMLCanvasElement;
  private bigCtx: CanvasRenderingContext2D;
  private bigTex: THREE.CanvasTexture;
  private dirty = false;
  private geo: THREE.BoxGeometry;
  private edge = new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.95 });
  private lastX = 0;
  private lastY = 0;
  private penOn = false;
  private sinceUpload = 0;

  constructor(parent: THREE.Object3D, readonly o: SheetOptions) {
    parent.add(this.group);
    this.geo = new THREE.BoxGeometry(o.w, o.h, o.thick);
    this.big = document.createElement('canvas');
    this.big.width = Math.round(o.w * o.ppm);
    this.big.height = Math.round(o.h * o.ppm);
    this.bigCtx = this.big.getContext('2d')!;
    this.bigTex = new THREE.CanvasTexture(this.big);
    this.bigTex.colorSpace = THREE.SRGBColorSpace;
    this.bigTex.anisotropy = 4;
    this.active = this.make();
    this.clearBig();
    this.attachBig(this.active);
    this.active.mesh.position.copy(o.paper).setZ(o.paper.z + o.thick / 2);
    this.active.mesh.rotation.z = 0;
  }

  private make(): Sheet {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(this.big?.width * PILE_RES || 64);
    canvas.height = Math.round(this.big?.height * PILE_RES || 64);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const top = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, roughness: 0.92 });
    const e = this.edge;
    const mesh = new THREE.Mesh(this.geo, [e, e, e, e, top, e]);
    this.group.add(mesh);
    return { mesh, top, canvas, tex, from: new THREE.Vector3(), to: new THREE.Vector3(), yaw0: 0, yaw1: 0, spin: 0, t: 0, dur: 1, arc: 0, flying: false };
  }

  private clearBig() {
    const g = this.bigCtx;
    g.fillStyle = '#f7f5ef';
    g.fillRect(0, 0, this.big.width, this.big.height);
    this.bigTex.needsUpdate = true;
  }

  private attachBig(s: Sheet) {
    s.top.map = this.bigTex;
    s.top.needsUpdate = true;
  }

  /** Pen tip at desk (x, y); draws ink when `down`. */
  pen(x: number, y: number, down: boolean) {
    const p = this.active.mesh.position;
    const W = this.big.width, H = this.big.height;
    const cx = ((x - p.x) / this.o.w + 0.5) * W;
    const cy = (0.5 - (y - p.y) / this.o.h) * H;
    if (down && this.penOn) {
      const g = this.bigCtx;
      g.beginPath();
      g.moveTo(this.lastX, this.lastY);
      g.lineTo(cx, cy);
      g.stroke();
      this.dirty = true;
    } else if (down) {
      // a dot where the pen touches down
      this.bigCtx.beginPath();
      this.bigCtx.arc(cx, cy, this.bigCtx.lineWidth * 0.5, 0, Math.PI * 2);
      this.bigCtx.fill();
      this.dirty = true;
    }
    this.penOn = down;
    this.lastX = cx;
    this.lastY = cy;
  }

  /** Ink style for the next drawing. */
  setInk() {
    const g = this.bigCtx;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = this.o.ink * this.o.ppm;
    g.strokeStyle = 'rgba(22, 24, 30, 0.92)';
    g.fillStyle = 'rgba(22, 24, 30, 0.92)';
  }

  /** Throw the finished sheet onto the pile and bring a fresh one. Returns when the new sheet will be settled. */
  toss(newSheetDelay = 0.35) {
    const s = this.active;
    // keep the drawing on the sheet as a small copy, the big canvas goes to the next sheet
    const g = s.canvas.getContext('2d')!;
    g.drawImage(this.big, 0, 0, s.canvas.width, s.canvas.height);
    s.tex.needsUpdate = true;
    s.top.map = s.tex;
    s.top.needsUpdate = true;
    const level = this.pile.length + this.flying.length;
    s.from.copy(s.mesh.position);
    s.to.set(this.o.pile.x + rand(-1, 1) * this.o.w * 0.04, this.o.pile.y + rand(-1, 1) * this.o.h * 0.05, this.o.pile.z + this.o.thick * (level + 0.5));
    s.yaw0 = s.mesh.rotation.z;
    s.yaw1 = rand(-0.22, 0.22);
    // half or whole turns, so the sheet lands square with the pile
    s.spin = (Math.random() < 0.5 ? -1 : 1) * Math.PI * (Math.random() < 0.4 ? 1 : 2);
    s.t = 0;
    s.dur = 1.05;
    s.arc = this.o.arc;
    s.flying = true;
    this.flying.push(s);

    // a fresh sheet floats down onto the paper spot
    const n = this.free.pop() ?? this.make();
    n.mesh.visible = true;
    n.from.copy(this.o.paper).setZ(this.o.paper.z + this.o.arc * 0.9);
    n.to.copy(this.o.paper).setZ(this.o.paper.z + this.o.thick / 2);
    n.yaw0 = rand(-0.5, 0.5);
    n.yaw1 = 0;
    n.spin = 0;
    n.t = -newSheetDelay / 0.7;
    n.dur = 0.7;
    n.arc = 0;
    n.flying = true;
    n.mesh.position.copy(n.from);
    n.mesh.visible = false;
    this.flying.push(n);
    this.clearBig();
    this.attachBig(n);
    this.active = n;
    this.penOn = false;
    return newSheetDelay + 0.7;
  }

  update(dt: number) {
    if (this.dirty) {
      // the drawing canvas is re-uploaded at most ~30 times a second
      this.sinceUpload += dt;
      if (this.sinceUpload > 1 / 31) { this.bigTex.needsUpdate = true; this.dirty = false; this.sinceUpload = 0; }
    }
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const s = this.flying[i];
      s.t += dt / s.dur;
      if (s.t < 0) continue;
      s.mesh.visible = true;
      const t = Math.min(1, s.t);
      const m = s.mesh;
      if (s === this.active) {
        // fall with a little sway
        const e = 1 - (1 - t) * (1 - t);
        m.position.lerpVectors(s.from, s.to, e);
        m.position.x += Math.sin(t * 7) * (1 - t) * this.o.w * 0.06;
        m.rotation.set(Math.sin(t * 9) * (1 - t) * 0.25, Math.cos(t * 7) * (1 - t) * 0.2, s.yaw0 + (s.yaw1 - s.yaw0) * e);
      } else {
        // thrown: up and over in an arc, spinning, then settle flat
        const e = ease(t);
        m.position.lerpVectors(s.from, s.to, e);
        m.position.z += Math.sin(Math.PI * t) * s.arc;
        const flutter = Math.sin(Math.PI * t);
        m.rotation.set(flutter * 0.5 * Math.sin(t * 11), flutter * 0.35, s.yaw0 + (s.yaw1 + s.spin - s.yaw0) * (1 - (1 - t) ** 3));
      }
      if (t >= 1) {
        s.flying = false;
        this.flying.splice(i, 1);
        m.rotation.set(0, 0, s === this.active ? s.yaw1 : s.yaw1 + s.spin);
        if (s !== this.active) this.land(s);
      }
    }
    // the pile settles toward its stacking heights (after recycling the bottom sheet)
    for (let i = 0; i < this.pile.length; i++) {
      const p = this.pile[i].mesh.position;
      const z = this.o.pile.z + this.o.thick * (i + 0.5);
      p.z += (z - p.z) * Math.min(1, dt * 6);
    }
  }

  /** true while sheets are still moving */
  get busy() {
    return this.flying.length > 0;
  }

  private land(s: Sheet) {
    this.pile.push(s);
    if (this.pile.length > this.o.cap) {
      const old = this.pile.shift()!;
      old.mesh.visible = false;
      this.free.push(old);
    }
  }
}

/** Joins geometries (same material) into one, so a small prop is a single draw call. */
export function mergeGeometries(geos: THREE.BufferGeometry[]) {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  for (const g0 of geos) {
    const g = g0;
    const base = pos.length / 3;
    const p = g.getAttribute('position'), n = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i));
    else for (let i = 0; i < p.count; i++) idx.push(base + i);
    g0.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}

/** Smooth wobble noise from a few detuned sines (cheap, no allocation). */
export class Wobble {
  private ph = [rand(0, 6), rand(0, 6), rand(0, 6), rand(0, 6)];
  private fr = [rand(0.7, 1.1), rand(1.7, 2.4), rand(3.1, 4.3), rand(5.5, 7)];
  reseed() { for (let i = 0; i < 4; i++) { this.ph[i] = rand(0, 6); this.fr[i] = this.fr[i] * rand(0.9, 1.1); } }
  at(s: number, k: number) {
    return (Math.sin(s * this.fr[0] + this.ph[0] + k) * 0.5 + Math.sin(s * this.fr[1] + this.ph[1] - k * 2) * 0.3
      + Math.sin(s * this.fr[2] + this.ph[2] + k * 3) * 0.15 + Math.sin(s * this.fr[3] + this.ph[3]) * 0.05);
  }
}

/**
 * Follows rest-pose points (CAD frame) on a part as it moves. Create it while the rig is still in its rest pose.
 * (The glb nodes carry quantisation transforms, so a part's matrix is not identity at rest.)
 */
export class Carrier {
  private rest = new THREE.Matrix4();
  private m = new THREE.Matrix4();
  private inv = new THREE.Matrix4();
  constructor(private scene: THREE.Object3D, private part: THREE.Object3D) {
    scene.updateMatrixWorld(true);
    this.rest.multiplyMatrices(this.inv.copy(scene.matrixWorld).invert(), part.matrixWorld).invert();
  }
  /** Current position (scene frame) of a point given in the rest pose. Call scene.updateMatrixWorld first. */
  at(pt: number[], out: THREE.Vector3) {
    this.inv.copy(this.scene.matrixWorld).invert();
    return out.fromArray(pt).applyMatrix4(this.m.multiplyMatrices(this.inv, this.part.matrixWorld).multiply(this.rest));
  }
}

/**
 * ?pendebug check: every pin is a rest point that two parts share. Carried by both parts it must stay one point
 * if the chain is closed. Returns the worst gap (m) in the drawing plane (`drop` = index of the plane normal).
 */
export function pinCheck(scene: THREE.Object3D, part: (id: string) => THREE.Object3D | undefined, pins: [string, string, number[]][], drop: number) {
  const list = pins.map(([p, q, pt]) => [new Carrier(scene, part(p)!), new Carrier(scene, part(q)!), pt] as const);
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  return () => {
    scene.updateMatrixWorld(true);
    let worst = 0;
    for (const [p, q, pt] of list) {
      p.at(pt, a).setComponent(drop, 0);
      q.at(pt, b).setComponent(drop, 0);
      worst = Math.max(worst, a.distanceTo(b));
    }
    return worst;
  };
}
