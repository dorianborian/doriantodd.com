// Things for the Executioner to destroy: household appliances with nerd-culture easter eggs mixed in.
// Each is built from separate pieces (bevelled, segmented panels that can dent and hinge, plus inner parts)
// so it can come apart hit by hit. Small details (labels, vents, screens) are tiny canvas textures.
// Everything is original modelling with no real brand names or logos. Materials and textures are cached
// and shared between spawns; geometry is per spawn because dents deform it.

import * as THREE from '../three-lite';
import { glowMaterial, rand } from './shared';

export type Kind =
  | 'washer' | 'stove' | 'fridge' | 'microwave' | 'toaster' | 'crt' | 'arcade' | 'vending' | 'printer' | 'heater'
  | 'trash' | 'lava' | 'tower' | 'tank' | 'cube' | 'policebox' | 'astromech' | 'cylon' | 'handheld' | 'd20'
  | 'creeper' | 'turret' | 'floppy' | 'rubik' | 'saber' | 'ghost' | 'hal' | 'duck' | 'cone' | 'gnome' | 'miku';

// appliances, with an easter egg after every one or two
export const LINEUP: Kind[] = [
  'washer', 'cube', 'stove', 'duck', 'crt', 'policebox', 'fridge', 'creeper', 'microwave', 'd20', 'toaster', 'astromech',
  'arcade', 'ghost', 'heater', 'turret', 'tower', 'handheld', 'vending', 'cone', 'printer', 'rubik', 'lava', 'floppy',
  'trash', 'cylon', 'tank', 'saber', 'gnome', 'hal', 'miku',
];

export type Piece = {
  mesh: THREE.Mesh;
  /** Pose in the appliance frame when assembled. */
  home: THREE.Vector3;
  homeQ: THREE.Quaternion;
  /** Half extents of the piece's own box, centred on the mesh origin. */
  half: THREE.Vector3;
  mass: number;
  /** Panels dent and bend on a hinge before they tear off. */
  panel: boolean;
  /** Preferred hinge edge in piece space (doors), otherwise the edge away from the hit. */
  hinge: THREE.Vector3 | null;
  /** Screws that pop out when it bends or tears. */
  screws: number;
  /** Disappears instead of flying (a light-sword blade switching off). */
  vanish: boolean;
  /** 0 attached, 1 bent on its hinge, 2 loose */
  state: number;
};

export type Build = {
  kind: Kind;
  pieces: Piece[];
  /** The piece that stays with the chassis to the end. */
  core: Piece;
  half: THREE.Vector3;
  /** What a hit throws: sparks off metal, chips off plastic, fluff off plush. */
  matter: 'metal' | 'plastic' | 'soft';
  /** How readily it catches fire, 0..1. */
  fuel: number;
  /** Paint chip colour. */
  chip: THREE.Color;
  /** Per-frame animation (lights, scanners); power drops to 0 as it gets wrecked. */
  tick: (t: number, power: number) => void;
};

/** Scale from the authoring units below to the arena. */
const K = 1.3;

// ------------------------------------------------------------------ materials and textures (cached)
const matCache = new Map<string, THREE.Material>();
function cached<T extends THREE.Material>(key: string, make: () => T): T {
  let m = matCache.get(key) as T | undefined;
  if (!m) { m = make(); matCache.set(key, m); }
  return m;
}
const std = (color: number, roughness = 0.45, metalness = 0.05) =>
  cached(`s${color}|${roughness}|${metalness}`, () => new THREE.MeshStandardMaterial({ color, roughness, metalness }));
const dbl = (color: number, roughness = 0.6, metalness = 0) =>
  cached(`d${color}|${roughness}|${metalness}`, () => new THREE.MeshStandardMaterial({ color, roughness, metalness, side: THREE.DoubleSide }));
/** Self-lit (screens, LEDs). Its colour is scaled by power in tick(), base kept in userData. */
const lit = (color: number) => cached(`l${color}`, () => {
  const m = new THREE.MeshBasicMaterial({ color, toneMapped: false });
  m.userData.base = new THREE.Color(color);
  return m;
});
const glass = (color: number, opacity = 0.35) => cached(`g${color}|${opacity}`, () => new THREE.MeshStandardMaterial({
  color, roughness: 0.04, metalness: 0.2, transparent: true, opacity, depthWrite: false,
}));
const texCache = new Map<string, THREE.CanvasTexture>();
function tex(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, pixel = false) {
  let t = texCache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!, w, h);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (pixel) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; }
  texCache.set(key, t);
  return t;
}
type DecalOpts = { glow?: boolean; transparent?: boolean; pixel?: boolean; rough?: number; metal?: number; color?: number };
function decalMat(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, o: DecalOpts = {}) {
  return cached(`t${key}`, () => {
    const map = tex(key, w, h, draw, o.pixel);
    if (o.glow) {
      const m = new THREE.MeshBasicMaterial({ map, toneMapped: false, transparent: !!o.transparent });
      m.userData.base = new THREE.Color(0xffffff);
      return m;
    }
    return new THREE.MeshStandardMaterial({ map, roughness: o.rough ?? 0.5, metalness: o.metal ?? 0.05, transparent: !!o.transparent, color: o.color ?? 0xffffff });
  });
}
/** Soft additive halo around lights. */
const halo = (color: number) => cached(`h${color}`, () => {
  const c = new THREE.Color(color);
  const m = glowMaterial({
    uniforms: { uColor: { value: c }, uPower: { value: 1 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `uniform vec3 uColor; uniform float uPower; varying vec2 vUv;
      void main() { float r = length(vUv * 2.0 - 1.0); float a = pow(max(0.0, 1.0 - r), 2.2) * uPower; gl_FragColor = vec4(uColor * a, 0.0); }`,
  });
  m.userData.halo = true;
  return m;
});
/** Set a self-lit or halo material's brightness. */
function power(mat: THREE.Material, k: number) {
  if (mat.userData.halo) (mat as THREE.ShaderMaterial).uniforms.uPower.value = k;
  else if (mat.userData.base) (mat as THREE.MeshBasicMaterial).color.copy(mat.userData.base).multiplyScalar(k);
}

const font = (px: number, weight = 'bold', family = 'Arial, Helvetica, sans-serif') => `${weight} ${px}px ${family}`;
function rrect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function vents(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, n: number, color = 'rgba(0,0,0,0.55)') {
  g.fillStyle = color;
  const step = h / n;
  for (let i = 0; i < n; i++) { rrect(g, x, y + i * step + step * 0.25, w, step * 0.5, step * 0.25); g.fill(); }
}
function heart(g: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  g.beginPath();
  g.moveTo(cx, cy + s * 0.9);
  g.bezierCurveTo(cx - s * 1.3, cy, cx - s * 0.7, cy - s * 0.95, cx, cy - s * 0.35);
  g.bezierCurveTo(cx + s * 0.7, cy - s * 0.95, cx + s * 1.3, cy, cx, cy + s * 0.9);
  g.fill();
}

// ------------------------------------------------------------------ geometry
/**
 * Box with chamfered edges, subdivided so it can be dented. Built from a segmented unit box whose outer
 * vertex ring is pulled in by `r` and pushed back out along the corner/edge normal.
 */
export function rbox(w: number, h: number, d: number, r = Math.min(0.01, Math.min(w, h, d) * 0.3), dense = true) {
  const hs = [w / 2, h / 2, d / 2];
  r = Math.min(r, Math.min(...hs) * 0.95);
  const ns = hs.map((x) => (dense ? THREE.MathUtils.clamp(Math.round((x * 2) / 0.045) + 2, 3, 10) : 3));
  const g = new THREE.BoxGeometry(2, 2, 2, ns[0], ns[1], ns[2]);
  const p = g.attributes.position as THREE.BufferAttribute;
  const orig = (p.array as Float32Array).slice();
  const v = [0, 0, 0];
  const c = [0, 0, 0];
  for (let i = 0; i < p.count; i++) {
    const t = [p.getX(i), p.getY(i), p.getZ(i)];
    for (let k = 0; k < 3; k++) {
      const n = ns[k];
      const idx = Math.round(((t[k] + 1) * n) / 2);
      const inner = Math.max(hs[k] - r, 1e-4);
      v[k] = idx === 0 ? -hs[k] : idx === n ? hs[k] : -inner + ((idx - 1) / (n - 2)) * 2 * inner;
      c[k] = THREE.MathUtils.clamp(v[k], -inner, inner);
    }
    const ox = v[0] - c[0], oy = v[1] - c[1], oz = v[2] - c[2];
    const l = Math.hypot(ox, oy, oz);
    if (l > 1e-6) p.setXYZ(i, c[0] + (ox / l) * r, c[1] + (oy / l) * r, c[2] + (oz / l) * r);
    else p.setXYZ(i, v[0], v[1], v[2]);
  }
  // the grid was squeezed toward the edges, so re-derive each face's UVs from the final positions
  // (keeping the box's own orientation of u and v per face) so decals and textures are not stretched
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (const grp of g.groups) {
    const mi = grp.materialIndex ?? 0;
    const ua = mi < 2 ? 2 : 0, va = mi === 2 || mi === 3 ? 2 : 1;
    for (let k = grp.start; k < grp.start + grp.count; k++) {
      const i = g.index!.getX(k);
      const tu = orig[i * 3 + ua], tv = orig[i * 3 + va];
      const su = Math.abs((tu + 1) / 2 - uv.getX(i)) < 1e-4 ? 1 : -1;
      const sv = Math.abs((tv + 1) / 2 - uv.getY(i)) < 1e-4 ? 1 : -1;
      const nu = p.getComponent(i, ua) / hs[ua], nv = p.getComponent(i, va) / hs[va];
      uv.setXY(i, (su * nu + 1) / 2, (sv * nv + 1) / 2);
    }
  }
  g.computeVertexNormals();
  return g;
}
const cyl = (rt: number, rb: number, h: number, n = 20, open = false) => new THREE.CylinderGeometry(rt, rb, h, n, 1, open);
/** Cylinder lying along z (knobs, lenses, wheels facing front). */
const disc = (r: number, h: number, n = 24) => new THREE.CylinderGeometry(r, r, h, n).rotateX(Math.PI / 2);
/** Cylinder lying along x. */
const axle = (r: number, h: number, n = 16) => new THREE.CylinderGeometry(r, r, h, n).rotateZ(Math.PI / 2);
const plane = (w: number, h: number) => new THREE.PlaneGeometry(w, h);

/** Icosahedron split into four solid wedges (top cap, two band halves, bottom cap) with numbered faces. */
function d20Pieces(radius: number) {
  const ico = new THREE.IcosahedronGeometry(radius, 0);
  const p = ico.attributes.position as THREE.BufferAttribute;
  const faces: THREE.Vector3[][] = [];
  for (let i = 0; i < p.count; i += 3) faces.push([0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(p, i + k)));
  ico.dispose();
  // sort faces by height of their centre: 5 top, 10 band, 5 bottom; split the band by side
  const cen = (f: THREE.Vector3[]) => f[0].clone().add(f[1]).add(f[2]).divideScalar(3);
  faces.sort((a, b) => cen(b).y - cen(a).y);
  const band = faces.slice(5, 15).sort((a, b) => Math.atan2(cen(a).z, cen(a).x) - Math.atan2(cen(b).z, cen(b).x));
  const groups = [faces.slice(0, 5), band.slice(0, 5), band.slice(5), faces.slice(15)];
  let number = 0;
  return groups.map((fs) => {
    const pos: number[] = [], uv: number[] = [];
    for (const f of fs) {
      const cell = number++;
      const cx = (cell % 5) / 5, cy = 1 - (Math.floor(cell / 5) + 1) / 4;
      // outer face with its number, then three inner faces to the centre (plain corner of the cell)
      const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, uvs: number[]) => { pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); uv.push(...uvs); };
      // keep the face winding outward
      const n = new THREE.Vector3().crossVectors(f[1].clone().sub(f[0]), f[2].clone().sub(f[0]));
      const [a, b, c] = n.dot(cen(f)) > 0 ? f : [f[0], f[2], f[1]];
      tri(a, b, c, [cx + 0.1 / 5 * 0 + 0.5 / 5, cy + 0.92 / 4, cx + 0.05 / 5, cy + 0.12 / 4, cx + 0.95 / 5, cy + 0.12 / 4]);
      const o = new THREE.Vector3();
      const plain = [cx + 0.01 / 5, cy + 0.01 / 4, cx + 0.02 / 5, cy + 0.01 / 4, cx + 0.01 / 5, cy + 0.02 / 4];
      tri(o, b, a, plain); tri(o, c, b, plain); tri(o, a, c, plain);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    return g;
  });
}

/** Rubik's cubie: bevelled black block with a sticker atlas cell on each outward face. */
function cubie(size: number, faces: number[]) {
  const g = rbox(size, size, size, size * 0.12, false);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  // BoxGeometry groups: +x, -x, +y, -y, +z, -z; atlas cells 0..5 colours, 6 black
  for (const grp of g.groups) {
    const cell = faces[grp.materialIndex ?? 0];
    const cx = (cell % 4) / 4, cy = Math.floor(cell / 4) / 2;
    const idx = g.index!;
    const seen = new Set<number>();
    for (let k = grp.start; k < grp.start + grp.count; k++) {
      const i = idx.getX(k);
      if (seen.has(i)) continue;
      seen.add(i);
      uv.setXY(i, cx + uv.getX(i) / 4, cy + uv.getY(i) / 2);
    }
  }
  g.clearGroups();
  return g;
}

// ------------------------------------------------------------------ building
type PieceOpts = { panel?: boolean; screws?: number; hinge?: [number, number, number]; vanish?: boolean; mass?: number };

export function buildAppliance(kind: Kind): Build {
  const pieces: Piece[] = [];
  const glows: THREE.Material[] = [];
  let anim: ((t: number, p: number) => void) | null = null;
  let matter: Build['matter'] = 'metal';
  let fuel = 0.5;
  let chip = 0xdddddd;
  /** The piece that stays to the end; defaults to the first one made (cabinets make their base first). */
  let coreMesh: THREE.Mesh | null = null;

  const piece = (geo: THREE.BufferGeometry, mat: THREE.Material, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0], o: PieceOpts = {}) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(...pos);
    mesh.rotation.set(...rot);
    pieces.push({
      mesh, home: new THREE.Vector3(), homeQ: new THREE.Quaternion(), half: new THREE.Vector3(), mass: o.mass ?? 0,
      panel: o.panel ?? false, hinge: o.hinge ? new THREE.Vector3(...o.hinge) : null, screws: o.screws ?? (o.panel ? 2 : 0),
      vanish: o.vanish ?? false, state: 0,
    });
    return mesh;
  };
  const panel = (w: number, h: number, d: number, mat: THREE.Material, pos: [number, number, number], o: PieceOpts = {}, rot?: [number, number, number]) =>
    piece(rbox(w, h, d), mat, pos, rot, { panel: true, screws: 2, ...o });
  const deco = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0]) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...pos);
    m.rotation.set(...rot);
    parent.add(m);
    if (mat.userData.base || mat.userData.halo) glows.push(mat);
    return m;
  };
  /** A decal plane on a piece's face (+z unless rotated). */
  const label = (parent: THREE.Object3D, mat: THREE.Material, w: number, h: number, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0]) => deco(parent, plane(w, h), mat, pos, rot);
  const glowHalo = (parent: THREE.Object3D, color: number, size: number, pos: [number, number, number]) => {
    const m = deco(parent, plane(size, size), halo(color), pos);
    m.renderOrder = 6;
    return m;
  };

  /**
   * Open-fronted cabinet from y = 0: core (base plate, feet, corner posts) + top, sides and back panels.
   * Returns the y of the top surface.
   */
  const cabinet = (W: number, H: number, D: number, mat: THREE.Material, o: { top?: THREE.Material; foot?: number; frame?: THREE.Material } = {}) => {
    const T = 0.016, f = o.foot ?? 0.014;
    const frame = o.frame ?? std(0x34373c, 0.55, 0.6);
    const core = piece(rbox(W - 2 * T, 0.02, D - 2 * T), frame, [0, f + 0.01, 0]);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      deco(core, cyl(0.012, 0.014, f, 10), std(0x151515, 0.8), [x * (W / 2 - 0.03), -0.01 - f / 2, z * (D / 2 - 0.03)]);
      deco(core, rbox(0.012, H - f - 0.03, 0.012, 0.002, false), frame, [x * (W / 2 - T - 0.008), (H - f) / 2 - 0.01, z * (D / 2 - T - 0.008)]);
    }
    panel(T, H - f, D, mat, [-W / 2 + T / 2, f + (H - f) / 2, 0], { hinge: [0, -1, 0] });
    panel(T, H - f, D, mat, [W / 2 - T / 2, f + (H - f) / 2, 0], { hinge: [0, -1, 0] });
    panel(W - 2 * T, H - f, T, mat, [0, f + (H - f) / 2, -D / 2 + T / 2]);
    panel(W, T, D, o.top ?? mat, [0, H + T / 2, 0], { hinge: [0, 0, -1] });
    return H + T;
  };

  switch (kind) {
    case 'washer': {
      const W = 0.3, H = 0.36, D = 0.3;
      const white = std(0xf1f2f4, 0.3, 0.05);
      cabinet(W, H, D, white);
      // control strip: drawer, programme dial, display, buttons
      const strip = panel(W, 0.07, 0.02, white, [0, H - 0.035, D / 2 - 0.01], { screws: 2 });
      label(strip, decalMat('washer-strip', 256, 64, (g, w, h) => {
        g.fillStyle = '#e9ecef'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#d5d9de'; rrect(g, 6, 8, 70, 48, 6); g.fill();
        g.fillStyle = '#9aa1a9'; rrect(g, 14, 40, 54, 8, 4); g.fill();
        // programme marks around the dial
        g.fillStyle = '#5c6670';
        for (let i = 0; i < 12; i++) { const a = -2.6 + i * 0.47; g.beginPath(); g.arc(128 + Math.cos(a) * 24, 32 + Math.sin(a) * 24, i % 3 ? 1.6 : 2.6, 0, 7); g.fill(); }
        g.fillStyle = '#c3c9cf'; [0, 1, 2].forEach((i) => { rrect(g, 196 + i * 18, 40, 13, 8, 3); g.fill(); });
      }), W * 0.98, 0.066, [0, 0, 0.0105]);
      deco(strip, disc(0.018, 0.016), std(0xdfe3e7, 0.25, 0.4), [0, 0, 0.016]);
      deco(strip, rbox(0.004, 0.014, 0.004, 0.001, false), std(0x5c6670), [0, 0.008, 0.025]);
      label(strip, decalMat('washer-lcd', 64, 32, (g, w, h) => { g.fillStyle = '#0d1a14'; g.fillRect(0, 0, w, h); g.fillStyle = '#5dff9a'; g.font = font(22, 'bold', 'monospace'); g.textAlign = 'center'; g.fillText('1:24', w / 2, 24); }, { glow: true }), 0.05, 0.022, [0.075, 0.012, 0.0115]);
      // front panel and the round door
      const front = panel(W, H - 0.085, 0.016, white, [0, 0.014 + (H - 0.085) / 2, D / 2 - 0.008], { screws: 3 });
      label(front, decalMat('washer-kick', 128, 32, (g, w, h) => { g.fillStyle = '#e4e7ea'; g.fillRect(0, 0, w, h); vents(g, 8, 6, w - 16, h - 12, 3, 'rgba(60,70,80,0.35)'); }), W * 0.9, 0.03, [0, -(H - 0.085) / 2 + 0.022, 0.0085]);
      const door = piece(new THREE.TorusGeometry(0.098, 0.017, 12, 40), std(0xd7dce1, 0.15, 0.95), [0, 0.17, D / 2 + 0.012], [0, 0, 0], { panel: false, hinge: [-1, 0, 0], screws: 1 });
      deco(door, disc(0.088, 0.008, 40), glass(0x2a4a6a, 0.55), [0, 0, 0]);
      deco(door, new THREE.TorusGeometry(0.084, 0.006, 8, 40), std(0x2d3238, 0.6), [0, 0, 0.002]);
      deco(door, rbox(0.016, 0.05, 0.016, 0.004, false), std(0xb8bfc6, 0.25, 0.8), [0.1, 0, 0.012]);
      // the drum with a sock in it, the concrete counterweight, the motor
      const drum = piece(disc(0.12, 0.2, 28), decalMat('washer-drum', 128, 64, (g, w, h) => {
        g.fillStyle = '#b9c0c7'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#6c737a'; for (let y = 6; y < h; y += 10) for (let x = (y / 10) % 2 ? 4 : 9; x < w; x += 10) { g.beginPath(); g.arc(x, y, 2.2, 0, 7); g.fill(); }
      }, { metal: 0.8, rough: 0.3 }), [0, 0.17, -0.01]);
      deco(drum, rbox(0.06, 0.02, 0.09, 0.008, false), std(0xd8344a, 0.9), [0.02, -0.095, 0.05], [0, 0.4, 0.2]);
      piece(rbox(0.2, 0.045, 0.05, 0.006, false), std(0x8e8c86, 0.95), [0, H - 0.06, 0.06]);
      piece(axle(0.032, 0.08), std(0x2c2f33, 0.5, 0.6), [0.05, 0.05, -0.08]);
      chip = 0xf1f2f4;
      break;
    }
    case 'stove': {
      const W = 0.32, H = 0.34, D = 0.3;
      const steel = std(0xc7ccd2, 0.28, 0.85), black = std(0x141518, 0.35, 0.2);
      cabinet(W, H, D, steel, { top: black });
      const top = pieces[pieces.length - 1].mesh;
      // gas grates over four burners
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        deco(top, cyl(0.038, 0.042, 0.012, 18), std(0x2a2b2e, 0.5, 0.6), [x * 0.075, 0.012, z * 0.07]);
        deco(top, cyl(0.02, 0.02, 0.008, 14), std(0x0d0d0e, 0.4, 0.4), [x * 0.075, 0.02, z * 0.07]);
        for (const a of [0, Math.PI / 2]) deco(top, rbox(0.11, 0.008, 0.008, 0.002, false), std(0x1b1c1e, 0.6, 0.5), [x * 0.075, 0.024, z * 0.07], [0, a, 0]);
      }
      // backguard with knobs and a clock
      const back = panel(W, 0.08, 0.03, steel, [0, H + 0.056, -D / 2 + 0.015], { screws: 2 });
      label(back, decalMat('stove-clock', 64, 32, (g, w, h) => { g.fillStyle = '#05070a'; g.fillRect(0, 0, w, h); g.fillStyle = '#4fd1ff'; g.font = font(22, 'bold', 'monospace'); g.textAlign = 'center'; g.fillText('12:00', w / 2, 24); }, { glow: true }), 0.06, 0.026, [0, 0.01, 0.0155]);
      for (const x of [-0.12, -0.075, 0.075, 0.12]) {
        const k = deco(back, disc(0.014, 0.014), black, [x, 0.005, 0.02]);
        deco(k, rbox(0.004, 0.018, 0.006, 0.001, false), std(0xe2e5e8, 0.3, 0.7), [0, 0, 0.008]);
      }
      // oven door with a window and a bar handle
      const door = panel(W - 0.004, H * 0.6, 0.02, steel, [0, 0.014 + 0.065 + H * 0.3, D / 2 - 0.01], { hinge: [0, -1, 0], screws: 2 });
      deco(door, rbox(W * 0.62, H * 0.3, 0.004, 0.003, false), glass(0x1a1a1a, 0.8), [0, -0.01, 0.011]);
      deco(door, axle(0.007, W * 0.8), std(0xe6e9ec, 0.12, 1), [0, H * 0.25, 0.03]);
      for (const x of [-1, 1]) deco(door, rbox(0.01, 0.01, 0.022, 0.003, false), std(0xe6e9ec, 0.12, 1), [x * W * 0.36, H * 0.25, 0.019]);
      // storage drawer
      const drawer = panel(W - 0.004, 0.06, 0.02, steel, [0, 0.014 + 0.032, D / 2 - 0.01], { screws: 1 });
      deco(drawer, rbox(W * 0.4, 0.01, 0.012, 0.003, false), black, [0, 0.008, 0.014]);
      // oven rack and a casserole dish
      const rack = piece(rbox(W - 0.05, 0.006, D - 0.06, 0.002, false), std(0x9ba1a8, 0.3, 0.9), [0, 0.15, 0]);
      deco(rack, cyl(0.06, 0.05, 0.04, 18), std(0xd9622b, 0.35), [0, 0.023, 0]);
      chip = 0xc7ccd2;
      break;
    }
    case 'fridge': {
      const W = 0.3, H = 0.62, D = 0.3;
      const steel = std(0xc9ced4, 0.26, 0.8), chrome = std(0xeef1f4, 0.12, 1), inner = std(0xf4f7fb, 0.6);
      cabinet(W, H, D, steel);
      // coils on the back
      label(pieces[3].mesh, decalMat('fridge-coil', 64, 128, (g, w, h) => {
        g.fillStyle = '#b8bec5'; g.fillRect(0, 0, w, h); g.strokeStyle = '#2b2e33'; g.lineWidth = 3;
        g.beginPath(); for (let y = 8; y < h - 8; y += 10) { g.moveTo(8, y); g.lineTo(w - 8, y); } g.stroke();
        g.lineWidth = 2; for (const x of [12, 32, 52]) { g.beginPath(); g.moveTo(x, 4); g.lineTo(x, h - 4); g.stroke(); }
      }, { metal: 0.6 }), W * 0.75, H * 0.8, [0, 0, -0.0085], [0, Math.PI, 0]);
      const doorT = 0.024;
      const up = panel(W, H * 0.34, doorT, steel, [0, H * 0.82, D / 2 + doorT / 2], { hinge: [-1, 0, 0], screws: 1 });
      const lo = panel(W, H * 0.6, doorT, steel, [0, 0.014 + H * 0.31, D / 2 + doorT / 2], { hinge: [-1, 0, 0], screws: 1 });
      for (const [door, y, len] of [[up, -0.03, H * 0.18], [lo, 0.07, H * 0.32]] as const) {
        deco(door, cyl(0.007, 0.007, len, 10), chrome, [W * 0.4, y, 0.032]);
        for (const s of [-1, 1]) deco(door, rbox(0.01, 0.01, 0.022, 0.003, false), chrome, [W * 0.4, y + s * len * 0.42, 0.021]);
      }
      // water and ice dispenser
      const disp = deco(up, rbox(0.08, 0.11, 0.006, 0.006, false), std(0x1c1f24, 0.4, 0.3), [-0.04, -0.01, 0.013]);
      label(disp, decalMat('fridge-disp', 64, 32, (g, w, h) => { g.fillStyle = '#0a0d12'; g.fillRect(0, 0, w, h); g.fillStyle = '#7cd5ff'; g.font = font(14, 'bold', 'monospace'); g.textAlign = 'center'; g.fillText('-18°', w / 2, 21); }, { glow: true }), 0.05, 0.022, [0, 0.035, 0.0035]);
      deco(disp, rbox(0.03, 0.012, 0.012, 0.003, false), std(0x3c4048, 0.5, 0.5), [0, -0.02, 0.008]);
      // shelves with a milk carton, a bottle and leftovers
      const s1 = piece(rbox(W - 0.04, 0.008, D - 0.05, 0.002, false), glass(0xcfe8ff, 0.5), [0, 0.2, 0.0]);
      deco(s1, rbox(0.05, 0.1, 0.05, 0.004, false), decalMat('fridge-milk', 64, 128, (g, w, h) => { g.fillStyle = '#f7f7f2'; g.fillRect(0, 0, w, h); g.fillStyle = '#3d7bd9'; g.fillRect(0, 50, w, 40); g.fillStyle = '#fff'; g.font = font(18); g.textAlign = 'center'; g.fillText('MILK', w / 2, 77); }), [-0.07, 0.055, 0.02]);
      deco(s1, cyl(0.022, 0.025, 0.11, 14), glass(0x5ab55a, 0.8), [0.06, 0.06, -0.03]);
      const s2 = piece(rbox(W - 0.04, 0.008, D - 0.05, 0.002, false), glass(0xcfe8ff, 0.5), [0, 0.36, 0.0]);
      deco(s2, cyl(0.05, 0.045, 0.04, 16), std(0xe0a03a, 0.6), [0.03, 0.024, 0]);
      piece(rbox(W - 0.05, 0.06, D - 0.08, 0.006, false), inner, [0, 0.08, 0]); // crisper drawer
      chip = 0xc9ced4;
      break;
    }
    case 'microwave': {
      const W = 0.34, H = 0.2, D = 0.24;
      const body = std(0x1b1c20, 0.35, 0.3), steel = std(0xb9c0c8, 0.3, 0.85);
      cabinet(W, H, D, steel, { foot: 0.01 });
      const door = panel(W * 0.7, H - 0.012, 0.02, body, [-W * 0.15, 0.01 + (H - 0.012) / 2, D / 2 + 0.01], { hinge: [-1, 0, 0], screws: 1 });
      label(door, decalMat('micro-window', 128, 64, (g, w, h) => {
        g.fillStyle = '#0d0f12'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#27303a'; rrect(g, 8, 6, w - 16, h - 12, 6); g.fill();
        g.fillStyle = 'rgba(0,0,0,0.6)'; for (let y = 8; y < h - 6; y += 3) for (let x = 10; x < w - 8; x += 3) g.fillRect(x, y, 1.5, 1.5);
      }, { rough: 0.1, metal: 0.4 }), W * 0.6, H * 0.7, [0, 0, 0.0105]);
      deco(door, rbox(0.012, H * 0.7, 0.02, 0.004, false), steel, [W * 0.33, 0, 0.018]);
      const ctl = panel(W * 0.3 - 0.004, H - 0.012, 0.02, body, [W * 0.35, 0.01 + (H - 0.012) / 2, D / 2 + 0.01], { screws: 1 });
      label(ctl, decalMat('micro-keys', 64, 128, (g, w, h) => {
        g.fillStyle = '#1b1c20'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#3a3d44';
        for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) { rrect(g, 8 + c * 17, 42 + r * 15, 13, 11, 3); g.fill(); }
        g.fillStyle = '#cfd3d8'; g.font = font(8); g.textAlign = 'center';
        for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) g.fillText(String(r * 3 + c + 1).replace('10', '*').replace('11', '0').replace('12', '#'), 14.5 + c * 17, 50 + r * 15);
        g.fillStyle = '#2e7d4f'; rrect(g, 8, 104, 48, 14, 4); g.fill();
        g.fillStyle = '#fff'; g.fillText('START', 32, 114);
      }), W * 0.26, H * 0.85, [0, -0.005, 0.0105]);
      label(ctl, decalMat('micro-lcd', 64, 24, (g, w, h) => { g.fillStyle = '#04120a'; g.fillRect(0, 0, w, h); g.fillStyle = '#45ff7a'; g.font = font(18, 'bold', 'monospace'); g.textAlign = 'center'; g.fillText('0:30', w / 2, 19); }, { glow: true }), W * 0.24, 0.022, [0, H * 0.36, 0.0115]);
      const plate = piece(cyl(0.1, 0.1, 0.008, 28), glass(0xe8f2ff, 0.45), [-0.04, 0.03, 0]);
      deco(plate, cyl(0.028, 0.022, 0.05, 16), std(0xd23c3c, 0.4), [0, 0.03, 0]); // a mug
      deco(plate, new THREE.TorusGeometry(0.014, 0.004, 6, 12, Math.PI), std(0xd23c3c, 0.4), [0.03, 0.03, 0], [0, 0, -Math.PI / 2]);
      piece(rbox(0.06, 0.07, 0.08, 0.005, false), std(0x6a6f76, 0.4, 0.7), [W * 0.36, 0.06, -0.03]); // magnetron
      chip = 0x1b1c20;
      break;
    }
    case 'toaster': case 'cylon': {
      const W = 0.28, H = 0.2, D = 0.17;
      const chrome = std(0xdde2e7, 0.1, 1), black = std(0x1a1b1e, 0.6);
      const base = piece(rbox(W, 0.025, D, 0.008), black, [0, 0.0125, 0]);
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) deco(base, cyl(0.01, 0.012, 0.008, 10), std(0x0b0b0b, 0.9), [x * (W / 2 - 0.03), -0.015, z * (D / 2 - 0.025)]);
      const shellF = panel(W, H - 0.02, D / 2, chrome, [0, 0.025 + (H - 0.02) / 2, D / 4], { hinge: [0, -1, 0], screws: 2 });
      const shellB = panel(W, H - 0.02, D / 2, chrome, [0, 0.025 + (H - 0.02) / 2, -D / 4], { hinge: [0, -1, 0], screws: 2 });
      for (const [s, z] of [[shellF, -D / 4 + 0.03], [shellB, D / 4 - 0.03]] as const) deco(s, rbox(W * 0.7, 0.004, 0.02, 0.002, false), black, [0, (H - 0.02) / 2 + 0.001, z]);
      deco(shellF, rbox(0.03, 0.03, 0.02, 0.006, false), black, [W / 2 + 0.012, 0.03, -D / 4 + 0.02]); // lever
      const dial = deco(shellF, disc(0.014, 0.01), black, [W * 0.32, -0.04, D / 4 + 0.005]);
      deco(dial, rbox(0.003, 0.012, 0.004, 0.001, false), std(0xf5f5f5), [0, 0.004, 0.006]);
      for (const z of [-0.03, 0.03]) piece(rbox(W * 0.62, 0.11, 0.014, 0.008), decalMat('toast', 64, 64, (g, w, h) => {
        g.fillStyle = '#b8742f'; rrect(g, 0, 0, w, h, 14); g.fill(); g.fillStyle = '#e9c48a'; rrect(g, 6, 8, w - 12, h - 14, 10); g.fill();
        g.fillStyle = 'rgba(120,70,20,0.25)'; for (let i = 0; i < 40; i++) g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }, { rough: 0.95 }), [0, H + 0.03, z], [0, 0, 0], { mass: 0.06 });
      if (kind === 'cylon') {
        // the toaster that turned out to be a robot: dark visor with a red eye sweeping side to side
        const visor = deco(shellF, rbox(W * 0.78, 0.03, 0.012, 0.005, false), std(0x08090a, 0.25, 0.4), [0, 0.03, D / 4 + 0.004]);
        const eye = deco(visor, rbox(0.03, 0.012, 0.004, 0.002, false), lit(0xff2020), [0, 0, 0.006]);
        const glow = glowHalo(visor, 0xff2a1a, 0.08, [0, 0, 0.009]);
        for (const x of [-1, 1]) deco(shellF, rbox(0.012, 0.06, 0.012, 0.004, false), chrome, [x * (W / 2 + 0.01), -0.02, 0], [0, 0, x * 0.3]); // little arms
        anim = (t, p) => { const x = Math.sin(t * 2.6) * W * 0.33; eye.position.x = x; glow.position.x = x; };
        chip = 0xdde2e7;
      }
      fuel = 0.7;
      break;
    }
    case 'crt': {
      const W = 0.32, H = 0.27, D = 0.3;
      const beige = std(0xd9d0b8, 0.7), dark = std(0x2a2a2a, 0.6);
      cabinet(W, H, D, beige, { foot: 0.01 });
      const front = panel(W, H - 0.01, 0.03, beige, [0, 0.01 + (H - 0.01) / 2, D / 2 + 0.015], { screws: 2 });
      const screen = deco(front, rbox(W * 0.72, H * 0.66, 0.012, 0.03, false), decalMat('crt-screen', 128, 96, (g, w, h) => {
        const gr = g.createRadialGradient(w / 2, h / 2, 5, w / 2, h / 2, w * 0.6); gr.addColorStop(0, '#3a6bb8'); gr.addColorStop(1, '#0b1a33'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
        g.fillStyle = 'rgba(255,255,255,0.18)'; for (let y = 0; y < h; y += 3) g.fillRect(0, y, w, 1);
        g.fillStyle = '#ffffff'; g.font = font(12, 'bold', 'monospace'); g.fillText('CH 03', 8, 18);
        g.fillStyle = 'rgba(255,255,255,0.25)'; g.beginPath(); g.ellipse(w * 0.3, h * 0.25, 30, 10, -0.4, 0, 7); g.fill();
      }, { glow: true }), [-W * 0.08, 0.02, 0.016]);
      screen.scale.set(1, 1, 0.5);
      const side = deco(front, rbox(0.05, H * 0.66, 0.006, 0.004, false), std(0xc9bfa6, 0.7), [W * 0.38, 0.02, 0.016]);
      for (const y of [0.06, 0.02]) { const k = deco(side, disc(0.012, 0.014), dark, [0, y, 0.008]); deco(k, rbox(0.003, 0.012, 0.004, 0.001, false), std(0xeeeeee), [0, 0, 0.008]); }
      label(side, decalMat('crt-grille', 32, 64, (g, w, h) => { g.fillStyle = '#c9bfa6'; g.fillRect(0, 0, w, h); vents(g, 4, 4, w - 8, h - 8, 8, 'rgba(40,35,25,0.6)'); }), 0.04, 0.07, [0, -0.06, 0.0035]);
      deco(front, rbox(0.012, 0.008, 0.004, 0.002, false), lit(0x3dff6a), [W * 0.38, -H * 0.42, 0.016]);
      // tube, and the rabbit-ear antenna
      piece(cyl(0.05, 0.12, 0.16, 20).rotateX(Math.PI / 2), dark, [0, H * 0.5, -0.02]);
      const ears = piece(rbox(0.06, 0.02, 0.05, 0.008), dark, [0, H + 0.026, -0.04]);
      for (const s of [-1, 1]) deco(ears, cyl(0.0025, 0.0025, 0.2, 6), std(0xd5d9de, 0.2, 1), [s * 0.05, 0.09, 0], [0, 0, -s * 0.5]);
      anim = (t, p) => { (screen.material as THREE.MeshBasicMaterial).map!.offset.y = (t * 0.7) % 1 * 0.02; };
      chip = 0xd9d0b8; matter = 'plastic';
      break;
    }
    case 'arcade': {
      const W = 0.28, H = 0.64, D = 0.3;
      const side = decalMat('arcade-side', 64, 128, (g, w, h) => {
        g.fillStyle = '#24124a'; g.fillRect(0, 0, w, h);
        const cols = ['#ff3da5', '#ffd23f', '#29f0ff'];
        cols.forEach((c, i) => { g.fillStyle = c; g.beginPath(); g.moveTo(0, 70 + i * 12); g.lineTo(w, 30 + i * 12); g.lineTo(w, 38 + i * 12); g.lineTo(0, 78 + i * 12); g.fill(); });
      }, { rough: 0.5 });
      const black = std(0x111214, 0.5);
      cabinet(W, H, D, side, { top: black });
      const marquee = panel(W, 0.07, 0.04, black, [0, H - 0.02, D / 2 - 0.02], { screws: 2 });
      label(marquee, decalMat('arcade-marquee', 128, 32, (g, w, h) => {
        g.fillStyle = '#0b0420'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#29f0ff'; g.font = font(18, 'bold', 'monospace'); g.textAlign = 'center'; g.fillText('HI-SCORE', w / 2, 23);
        g.fillStyle = '#ff3da5'; g.fillRect(4, 27, w - 8, 2);
      }, { glow: true }), W * 0.92, 0.06, [0, 0, 0.0205]);
      const bezel = panel(W - 0.03, 0.2, 0.02, black, [0, H - 0.17, D / 2 - 0.04], { screws: 2 }, [-0.18, 0, 0]);
      label(bezel, decalMat('arcade-game', 96, 96, (g, w, h) => {
        g.fillStyle = '#020210'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#fff'; for (let i = 0; i < 30; i++) g.fillRect(Math.random() * w, Math.random() * h, 1, 1);
        // original pixel invaders and a little ship
        const inv = ['0100010', '0011100', '0111110', '1101011', '1111111', '1010101'];
        ['#ff3da5', '#ffd23f', '#29f0ff'].forEach((c, r) => { g.fillStyle = c; for (let k = 0; k < 4; k++) inv.forEach((row, y) => [...row].forEach((b, x) => { if (b === '1') g.fillRect(10 + k * 20 + x * 2, 10 + r * 16 + y * 2, 2, 2); })); });
        g.fillStyle = '#45ff7a'; g.fillRect(42, 82, 12, 4); g.fillRect(46, 78, 4, 4);
        g.fillStyle = '#fff'; g.fillRect(47.5, 60, 1, 8);
      }, { glow: true, pixel: true }), W * 0.78, 0.17, [0, 0, 0.0105]);
      const deck = panel(W, 0.03, 0.12, black, [0, H * 0.53, D / 2 + 0.03], { screws: 2 }, [0.25, 0, 0]);
      deco(deck, cyl(0.004, 0.004, 0.045, 6), black, [-0.06, 0.03, 0]);
      deco(deck, new THREE.SphereGeometry(0.014, 12, 8), std(0xe5484d, 0.35), [-0.06, 0.055, 0]);
      [[0.01, 0xffd23f], [0.045, 0x29f0ff], [0.08, 0xff3da5]].forEach(([x, c]) => deco(deck, cyl(0.011, 0.011, 0.01, 14), std(c, 0.35), [x, 0.018, 0]));
      const coin = panel(W - 0.03, H * 0.42, 0.02, black, [0, 0.014 + H * 0.21, D / 2 - 0.01], { hinge: [-1, 0, 0] });
      deco(coin, rbox(0.08, 0.09, 0.008, 0.004, false), std(0x6b6f76, 0.3, 0.9), [0, 0.06, 0.012]);
      for (const x of [-0.02, 0.02]) deco(coin, rbox(0.01, 0.022, 0.004, 0.002, false), lit(0xff4a3d), [x, 0.07, 0.017]);
      chip = 0x24124a; matter = 'plastic'; fuel = 0.8;
      break;
    }
    case 'vending': {
      const W = 0.34, H = 0.66, D = 0.28;
      const red = std(0xc1121f, 0.35, 0.2), dark = std(0x1a1a1a, 0.5);
      cabinet(W, H, D, red);
      // rows of drinks and snacks behind a glass door, keypad column, header and pickup flap
      const midY = 0.014 + H * 0.2 + H * 0.33;
      piece(rbox(W * 0.64, H * 0.66, 0.03, 0.004, false), decalMat('vend-goods', 128, 192, (g, w, h) => {
        g.fillStyle = '#20252b'; g.fillRect(0, 0, w, h);
        const cols = ['#e63946', '#2a9d8f', '#f4a261', '#3d5afe', '#ffd166', '#8338ec'];
        for (let r = 0; r < 5; r++) {
          g.fillStyle = '#9aa3ad'; g.fillRect(0, 32 + r * 38, w, 3);
          for (let c = 0; c < 5; c++) {
            g.fillStyle = cols[(r * 2 + c) % cols.length]; rrect(g, 6 + c * 24, 6 + r * 38, 18, 26, 4); g.fill();
            g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(9 + c * 24, 9 + r * 38, 4, 20);
          }
        }
      }), [-W * 0.16, midY, D / 2 - 0.03]);
      const door = piece(rbox(W * 0.68, H * 0.7, 0.01, 0.003, false), glass(0xbfe2ff, 0.22), [-W * 0.16, midY, D / 2 + 0.005], [0, 0, 0], { hinge: [-1, 0, 0], screws: 2 });
      for (const y of [-1, 1]) deco(door, rbox(W * 0.68, 0.012, 0.012, 0.003, false), std(0xd9dde2, 0.2, 0.9), [0, y * H * 0.35, 0]);
      const keys = panel(W * 0.3, H * 0.86, 0.02, red, [W * 0.35, midY - H * 0.08, D / 2 + 0.01], { screws: 2 });
      label(keys, decalMat('vend-keys', 64, 192, (g, w, h) => {
        g.fillStyle = '#c1121f'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#1a1a1a'; rrect(g, 8, 20, 48, 110, 5); g.fill();
        g.fillStyle = '#7cff9a'; g.fillRect(13, 26, 38, 14);
        g.fillStyle = '#d9dde2'; for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) { rrect(g, 13 + c * 13, 50 + r * 17, 10, 12, 2); g.fill(); }
        g.fillStyle = '#111'; rrect(g, 24, 140, 16, 26, 3); g.fill(); g.fillStyle = '#555'; g.fillRect(30, 144, 4, 18);
      }), W * 0.26, H * 0.8, [0, 0, 0.0105]);
      const header = panel(W * 0.7, H * 0.08, 0.02, red, [-W * 0.15, H - H * 0.04, D / 2 + 0.01], { screws: 2 });
      label(header, decalMat('vend-header', 128, 24, (g, w) => {
        g.fillStyle = '#c1121f'; g.fillRect(0, 0, w, 24);
        g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, 14); g.bezierCurveTo(40, 2, 80, 26, w, 8); g.lineTo(w, 14); g.bezierCurveTo(80, 32, 40, 8, 0, 20); g.fill();
      }, { glow: true }), W * 0.68, H * 0.075, [0, 0, 0.0105]);
      const flap = panel(W * 0.7, H * 0.18, 0.02, red, [-W * 0.15, 0.014 + H * 0.09, D / 2 + 0.01], { screws: 2, hinge: [0, -1, 0] });
      deco(flap, rbox(W * 0.5, 0.05, 0.012, 0.004, false), dark, [0, 0.01, 0.012]);
      piece(rbox(0.08, 0.1, 0.1, 0.006, false), std(0x5c636b, 0.4, 0.8), [W * 0.3, 0.1, -0.05]); // compressor
      chip = 0xc1121f; fuel = 0.6;
      break;
    }
    case 'printer': {
      const W = 0.34, H = 0.17, D = 0.28;
      const grey = std(0xe7e7e4, 0.55), dark = std(0x2f3135, 0.5);
      cabinet(W, H, D, grey, { foot: 0.006 });
      const front = panel(W - 0.004, H - 0.01, 0.02, grey, [0, 0.006 + (H - 0.01) / 2, D / 2 + 0.01], { hinge: [0, -1, 0] });
      deco(front, rbox(W * 0.7, 0.03, 0.01, 0.004, false), dark, [0, -0.02, 0.01]);
      const lcd = deco(front, rbox(0.07, 0.03, 0.006, 0.003, false), dark, [W * 0.3, 0.035, 0.01]);
      label(lcd, decalMat('printer-lcd', 64, 24, (g, w, h) => { g.fillStyle = '#0a1a26'; g.fillRect(0, 0, w, h); g.fillStyle = '#ffb347'; g.font = font(11, 'bold', 'monospace'); g.fillText('PC LOAD', 4, 10); g.fillText('LETTER', 4, 21); }, { glow: true }), 0.06, 0.022, [0, 0, 0.0035]);
      deco(front, rbox(0.012, 0.006, 0.004, 0.002, false), lit(0x45ff7a), [W * 0.42, 0.01, 0.011]);
      const tray = piece(rbox(W * 0.72, 0.008, 0.16, 0.003, false), grey, [0, H + 0.06, -0.06], [-0.7, 0, 0]);
      deco(tray, rbox(W * 0.62, 0.006, 0.14, 0.001, false), std(0xffffff, 0.9), [0, 0.006, 0]);
      piece(rbox(W * 0.6, 0.003, 0.15, 0.001, false), decalMat('printer-page', 64, 80, (g, w, h) => { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = '#8a9099'; for (let y = 10; y < h - 6; y += 6) g.fillRect(6, y, w - 12 - (y % 18 ? 0 : 20), 2); }, { rough: 0.95 }), [0, H * 0.6, D / 2 + 0.07], [0.1, 0, 0], { mass: 0.03 });
      piece(rbox(0.08, 0.05, 0.03, 0.006, false), std(0x111111, 0.4), [-0.06, H * 0.5, 0]); // toner
      chip = 0xe7e7e4; matter = 'plastic';
      break;
    }
    case 'heater': {
      const R = 0.12, H = 0.56;
      const white = std(0xeef0f2, 0.4, 0.05), copper = std(0xb87333, 0.3, 0.9);
      const core = piece(cyl(R * 0.98, R, 0.03, 24), std(0x3a3d42, 0.6, 0.5), [0, 0.015, 0]);
      for (let k = 0; k < 3; k++) { const a = (k / 3) * Math.PI * 2; deco(core, cyl(0.01, 0.012, 0.015, 8), std(0x111111, 0.8), [Math.cos(a) * R * 0.7, -0.02, Math.sin(a) * R * 0.7]); }
      // outer jacket in two halves around the inner tank
      for (const s of [0, 1]) {
        const half = piece(new THREE.CylinderGeometry(R, R, H - 0.06, 24, 4, true, s * Math.PI - Math.PI / 2, Math.PI), dbl(0xeef0f2, 0.4, 0.05), [0, 0.03 + (H - 0.06) / 2, 0], [0, 0, 0], { panel: true, screws: 2, hinge: [0, -1, 0] });
        if (!s) {
          label(half, decalMat('heater-label', 64, 96, (g, w, h) => {
            g.fillStyle = '#f8f6ee'; g.fillRect(0, 0, w, h);
            g.fillStyle = '#ffcf33'; g.beginPath(); g.moveTo(w / 2, 6); g.lineTo(w - 6, 46); g.lineTo(6, 46); g.closePath(); g.fill();
            g.fillStyle = '#111'; g.font = font(26); g.textAlign = 'center'; g.fillText('!', w / 2, 42);
            g.fillStyle = '#555'; for (let y = 56; y < h - 6; y += 7) g.fillRect(8, y, w - 16, 3);
          }), 0.07, 0.1, [0, 0.05, R + 0.002]);
        }
      }
      piece(cyl(R * 0.85, R * 0.85, H - 0.1, 20), std(0x7d8691, 0.35, 0.75), [0, 0.03 + (H - 0.1) / 2, 0]);
      piece(cyl(R, R, 0.03, 24), white, [0, H - 0.015, 0], [0, 0, 0], { panel: false, screws: 2 });
      for (const x of [-0.045, 0.045]) {
        const pipe = piece(cyl(0.012, 0.012, 0.14, 10), copper, [x, H + 0.06, 0]);
        deco(pipe, new THREE.TorusGeometry(0.03, 0.012, 8, 12, Math.PI / 2), copper, [x > 0 ? -0.03 : 0.03, 0.07, 0], [0, x > 0 ? Math.PI : 0, 0]);
      }
      const ctl = piece(rbox(0.07, 0.07, 0.05, 0.008), std(0x2d2f33, 0.4, 0.5), [0, 0.1, R + 0.02]);
      deco(ctl, disc(0.018, 0.016), std(0xc8202a, 0.4), [0, 0.008, 0.03]);
      deco(ctl, rbox(0.01, 0.006, 0.004, 0.002, false), lit(0xff7a1a), [0.022, -0.022, 0.026]);
      chip = 0xeef0f2;
      break;
    }
    case 'trash': {
      const W = 0.24, H = 0.36, D = 0.26;
      const green = std(0x2f6b45, 0.55, 0.05), dark = std(0x1d3d2a, 0.6);
      const core = piece(rbox(W - 0.03, 0.03, D - 0.03, 0.01), dark, [0, 0.015, 0]);
      for (const x of [-1, 1]) deco(core, axle(0.035, 0.025, 16), std(0x121212, 0.8), [x * (W / 2 - 0.01), 0.02, -D / 2 + 0.03]);
      // tapered walls
      const front = panel(W, H - 0.02, 0.014, green, [0, 0.02 + (H - 0.02) / 2, D / 2 - 0.007], { hinge: [0, -1, 0] }, [0.05, 0, 0]);
      label(front, decalMat('trash-front', 64, 96, (g, w, h) => {
        g.fillStyle = '#2f6b45'; g.fillRect(0, 0, w, h);
        g.fillStyle = 'rgba(0,0,0,0.18)'; for (let x = 6; x < w; x += 12) g.fillRect(x, 0, 4, h);
        g.fillStyle = 'rgba(255,255,255,0.85)'; g.font = font(30); g.textAlign = 'center'; g.fillText('07', w / 2, 44);
        g.fillStyle = '#e8c547'; g.fillRect(0, h - 14, w, 6);
      }), W * 0.96, (H - 0.02) * 0.96, [0, 0, 0.0075]);
      panel(W, H - 0.02, 0.014, green, [0, 0.02 + (H - 0.02) / 2, -D / 2 + 0.007], { hinge: [0, -1, 0] }, [-0.05, 0, 0]);
      panel(0.014, H - 0.02, D - 0.03, green, [-W / 2 + 0.007, 0.02 + (H - 0.02) / 2, 0], { hinge: [0, -1, 0] }, [0, 0, 0.05]);
      panel(0.014, H - 0.02, D - 0.03, green, [W / 2 - 0.007, 0.02 + (H - 0.02) / 2, 0], { hinge: [0, -1, 0] }, [0, 0, -0.05]);
      const lid = panel(W + 0.03, 0.02, D + 0.03, dark, [0, H + 0.01, 0], { hinge: [0, 0, -1], screws: 1 });
      deco(lid, rbox(W * 0.7, 0.02, 0.02, 0.006, false), dark, [0, 0, -D / 2 - 0.005]);
      const bag = piece(new THREE.IcosahedronGeometry(0.09, 1).scale(1, 1.1, 1), std(0x17181b, 0.3, 0.1), [0, H * 0.45, 0]);
      deco(bag, rbox(0.03, 0.03, 0.03, 0.006, false), std(0xf2c14e, 0.6), [0.06, 0.07, 0.03]);
      piece(new THREE.SphereGeometry(0.035, 10, 8), std(0xe9e4d8, 0.95), [-0.05, H * 0.75, 0.05], [0, 0, 0], { mass: 0.03 });
      piece(cyl(0.02, 0.02, 0.06, 12), std(0xc0c4c9, 0.25, 0.9), [0.06, H * 0.76, -0.04], [0.3, 0, 1.2], { mass: 0.03 });
      chip = 0x2f6b45; matter = 'plastic'; fuel = 0.9;
      break;
    }
    case 'lava': {
      // retro lava lamp: metal base cone, glowing glass vessel with wax blobs, metal cap
      const metal = std(0x9aa3ae, 0.25, 0.9);
      const core = piece(cyl(0.05, 0.1, 0.14, 24), metal, [0, 0.07, 0]);
      deco(core, rbox(0.03, 0.012, 0.004, 0.002, false), std(0x1a1a1a, 0.4), [0, -0.03, 0.078], [0.3, 0, 0]);
      const vessel = piece(cyl(0.035, 0.07, 0.32, 24), glass(0xff5a1f, 0.45), [0, 0.14 + 0.16, 0], [0, 0, 0], { mass: 0.2 });
      const blobs: THREE.Mesh[] = [];
      for (let k = 0; k < 4; k++) blobs.push(deco(vessel, new THREE.SphereGeometry(0.022 + k * 0.004, 12, 10), lit(0xffb020), [0, 0, 0]) as THREE.Mesh);
      deco(vessel, cyl(0.03, 0.06, 0.3, 16), lit(0xff4a10), [0, 0, 0]).scale.set(0.95, 1, 0.95);
      glowHalo(vessel, 0xff6a1a, 0.5, [0, 0, 0.08]);
      piece(cyl(0.022, 0.036, 0.07, 20), metal, [0, 0.46 + 0.035, 0]);
      anim = (t, p) => blobs.forEach((b, k) => { b.position.set(Math.sin(t * 0.7 + k * 2) * 0.012, Math.sin(t * 0.45 + k * 1.7) * 0.11, Math.cos(t * 0.6 + k) * 0.01); b.scale.set(1, 1 + 0.25 * Math.sin(t + k), 1); });
      chip = 0xff5a1f; matter = 'plastic'; fuel = 0.6;
      break;
    }
    case 'tower': {
      const W = 0.15, H = 0.38, D = 0.32;
      const black = std(0x141518, 0.45, 0.4), rgbA = lit(0xff3df2), rgbB = lit(0x29f0ff);
      cabinet(W, H, D, black, { foot: 0.012 });
      label(pieces[pieces.length - 1].mesh, decalMat('tower-mesh', 64, 128, (g, w, h) => { g.fillStyle = '#141518'; g.fillRect(0, 0, w, h); g.fillStyle = '#05060a'; for (let y = 3; y < h; y += 6) for (let x = (y / 6) % 2 ? 3 : 6; x < w; x += 6) { g.beginPath(); g.arc(x, y, 2, 0, 7); g.fill(); } }), D * 0.85, W * 0.8, [0, 0.0085, 0], [-Math.PI / 2, 0, Math.PI / 2]);
      // tempered glass side, front with RGB fans
      const glassSide = piece(rbox(0.006, H - 0.03, D - 0.03, 0.002, false), glass(0x6f8aa6, 0.25), [W / 2 + 0.004, 0.012 + (H - 0.012) / 2, 0], [0, 0, 0], { screws: 4, hinge: [0, -1, 0] });
      deco(glassSide, rbox(0.002, 0.004, D * 0.8, 0.001, false), rgbA, [-0.006, H * 0.42, 0]);
      const front = panel(W, H - 0.012, 0.02, black, [0, 0.012 + (H - 0.012) / 2, D / 2 + 0.01], { screws: 2 });
      for (const y of [0.08, -0.04]) {
        deco(front, new THREE.TorusGeometry(0.04, 0.005, 8, 28), y > 0 ? rgbA : rgbB, [0, y, 0.012]);
        const hub = deco(front, disc(0.012, 0.006), std(0x222222, 0.5), [0, y, 0.012]);
        for (let b = 0; b < 5; b++) deco(hub, rbox(0.03, 0.012, 0.002, 0.001, false), std(0x2a2a2e, 0.5), [Math.cos(b * 1.257) * 0.02, Math.sin(b * 1.257) * 0.02, 0], [0, 0.4, b * 1.257]);
      }
      deco(front, disc(0.006, 0.006), lit(0x29f0ff), [0, H * 0.43, 0.012]);
      const gpu = piece(rbox(0.04, 0.05, 0.22, 0.006), std(0x26282c, 0.4, 0.6), [0, 0.15, 0]);
      for (const z of [-0.06, 0.04]) deco(gpu, axle(0.02, 0.004, 16), std(0x111111, 0.6), [0.022, -0.002, z]);
      deco(gpu, rbox(0.002, 0.006, 0.18, 0.001, false), rgbB, [0.022, 0.024, 0]);
      const cooler = piece(rbox(0.06, 0.08, 0.06, 0.004), std(0xb5bcc4, 0.3, 0.9), [0, 0.27, -0.03]);
      deco(cooler, axle(0.026, 0.01, 16), rgbA, [0.032, 0, 0]);
      piece(rbox(0.06, 0.07, 0.1, 0.006), std(0x1e1f23, 0.5, 0.4), [0, 0.06, -0.08]); // PSU
      chip = 0x141518;
      break;
    }
    case 'tank': {
      // the autonomous fridge tank, googly eyes and all
      const W = 0.24, H = 0.26, D = 0.3;
      const red = std(0xd62828, 0.35, 0.1), black = std(0x151515, 0.75), white = std(0xffffff, 0.3);
      cabinet(W, H, D, red, { foot: 0.06 });
      const door = panel(W, H - 0.07, 0.02, red, [0, 0.06 + (H - 0.06) / 2, D / 2 + 0.01], { hinge: [-1, 0, 0] });
      for (const x of [-0.05, 0.05]) {
        deco(door, new THREE.SphereGeometry(0.032, 16, 12), white, [x, 0.04, 0.012]);
        deco(door, new THREE.SphereGeometry(0.015, 12, 8), black, [x + rand(-0.01, 0.01), 0.035, 0.04]);
      }
      deco(door, rbox(0.012, 0.08, 0.016, 0.004, false), std(0xdddddd, 0.2, 0.8), [W * 0.4, -0.02, 0.016]);
      for (const x of [-1, 1]) {
        const tread = piece(rbox(0.045, 0.07, D * 1.08, 0.02), decalMat('tank-tread', 32, 128, (g, w, h) => { g.fillStyle = '#121212'; g.fillRect(0, 0, w, h); g.fillStyle = '#2b2b2b'; for (let y = 0; y < h; y += 8) g.fillRect(0, y, w, 4); }, { rough: 0.9 }), [x * (W / 2 + 0.025), 0.035, 0]);
        for (const z of [-0.1, 0, 0.1]) deco(tread, axle(0.026, 0.05, 14), std(0x3c3c3c, 0.6, 0.6), [0, 0, z]);
      }
      chip = 0xd62828;
      break;
    }
    case 'cube': {
      // companion-cube-style crate: grey faces with a pink heart in a ring, light corner caps
      const S = 0.34, F = S * 0.86;
      const face = decalMat('cube-face', 128, 128, (g, w, h) => {
        g.fillStyle = '#c9ccd0'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#8e939a'; g.fillRect(0, 56, w, 16); g.fillRect(56, 0, 16, h);
        g.fillStyle = '#e9eaec'; g.beginPath(); g.arc(64, 64, 34, 0, 7); g.fill();
        g.strokeStyle = '#8e939a'; g.lineWidth = 4; g.beginPath(); g.arc(64, 64, 34, 0, 7); g.stroke();
        g.fillStyle = '#f06aa8'; heart(g, 64, 62, 18);
      }, { rough: 0.45, metal: 0.2 });
      piece(rbox(S * 0.8, S * 0.8, S * 0.8, 0.01, false), std(0x5a5f66, 0.5, 0.5), [0, S / 2, 0]);
      const sides: [number, number, number, [number, number, number]][] = [[0, 0, 1, [0, 0, 0]], [0, 0, -1, [0, Math.PI, 0]], [1, 0, 0, [0, Math.PI / 2, 0]], [-1, 0, 0, [0, -Math.PI / 2, 0]], [0, 1, 0, [-Math.PI / 2, 0, 0]]];
      for (const [x, y, z, rot] of sides) {
        const p = piece(rbox(F, F, 0.03), std(0xc9ccd0, 0.45, 0.2), [x * (S / 2 - 0.015), S / 2 + y * (S / 2 - 0.015), z * (S / 2 - 0.015)], rot, { panel: true, screws: 2 });
        label(p, face, F * 0.98, F * 0.98, [0, 0, 0.0152]);
      }
      // corner caps
      for (const [x, y, z] of [[-1, 1, 1], [1, 1, 1], [-1, 1, -1], [1, 1, -1], [-1, -1, 1], [1, -1, 1], [-1, -1, -1], [1, -1, -1]]) {
        const cap = piece(rbox(0.09, 0.09, 0.09, 0.02), std(0xe8e9eb, 0.4, 0.1), [x * (S / 2 - 0.035), S / 2 + y * (S / 2 - 0.035), z * (S / 2 - 0.035)], [0, 0, 0], { mass: 0.08 });
        deco(cap, rbox(0.03, 0.03, 0.03, 0.006, false), std(0x8e939a, 0.5, 0.4), [x * 0.035, y * 0.035, z * 0.035]);
      }
      chip = 0xc9ccd0;
      break;
    }
    case 'policebox': {
      const W = 0.26, H = 0.62, blue = std(0x1f3f8f, 0.6, 0.05), dark = std(0x16306e, 0.6);
      const core = piece(rbox(W + 0.03, 0.03, W + 0.03, 0.006), dark, [0, 0.015, 0]);
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) deco(core, rbox(0.03, H - 0.03, 0.03, 0.005, false), dark, [x * (W / 2), (H - 0.03) / 2 + 0.015, z * (W / 2)]);
      const doorTex = decalMat('pbox-door', 64, 256, (g, w, h) => {
        g.fillStyle = '#1f3f8f'; g.fillRect(0, 0, w, h);
        g.strokeStyle = '#16306e'; g.lineWidth = 4;
        for (let r = 0; r < 4; r++) { g.strokeRect(6, 8 + r * 62, w - 12, 54); }
        g.fillStyle = '#f2f2ea'; g.fillRect(9, 11, w - 18, 48);
        g.fillStyle = '#16306e'; g.fillRect(w / 2 - 1.5, 11, 3, 48); g.fillRect(9, 26, w - 18, 3); g.fillRect(9, 42, w - 18, 3);
      }, { rough: 0.6 });
      const sign = decalMat('pbox-sign', 256, 32, (g, w, h) => { g.fillStyle = '#0b0b0d'; g.fillRect(0, 0, w, h); g.fillStyle = '#f2f2ea'; g.font = font(20); g.textAlign = 'center'; g.fillText('POLICE        BOX', w / 2, 23); }, { glow: true });
      // four faces: the front pair are doors that swing on their outer edge
      const faceY = 0.03 + (H - 0.11) / 2, faceH = H - 0.11;
      for (const [rotY, dx, dz] of [[0, 0, 1], [Math.PI, 0, -1], [Math.PI / 2, 1, 0], [-Math.PI / 2, -1, 0]] as const) {
        if (dz === 1) {
          for (const s of [-1, 1]) {
            const d = panel(W / 2 - 0.004, faceH, 0.016, blue, [s * (W / 4), faceY, W / 2 - 0.004], { hinge: [s, 0, 0], screws: 1 });
            label(d, doorTex, W / 2 - 0.012, faceH - 0.01, [0, 0, 0.0085]);
          }
          continue;
        }
        const p = panel(W - 0.006, faceH, 0.016, blue, [dx * (W / 2 - 0.004), faceY, dz * (W / 2 - 0.004)], { screws: 2 }, [0, rotY, 0]);
        for (const s of [-1, 1]) label(p, doorTex, W / 2 - 0.012, faceH - 0.01, [s * W / 4, 0, 0.0085]);
      }
      const roof = piece(rbox(W + 0.05, 0.05, W + 0.05, 0.006), dark, [0, H - 0.05, 0], [0, 0, 0], { screws: 2 });
      for (const [rotY, dx, dz] of [[0, 0, 1], [Math.PI, 0, -1], [Math.PI / 2, 1, 0], [-Math.PI / 2, -1, 0]] as const) label(roof, sign, W + 0.03, 0.036, [dx * (W / 2 + 0.0255), 0, dz * (W / 2 + 0.0255)], [0, rotY, 0]);
      const top = piece(rbox(W, 0.03, W, 0.01), dark, [0, H - 0.01, 0]);
      const lamp = deco(top, cyl(0.022, 0.026, 0.05, 14), lit(0xdff4ff), [0, 0.04, 0]);
      deco(top, cyl(0.03, 0.03, 0.01, 14), dark, [0, 0.07, 0]);
      const lampGlow = glowHalo(top, 0xbfe6ff, 0.18, [0, 0.04, 0.03]);
      anim = (t, p) => { const k = p * (0.6 + 0.4 * Math.max(0, Math.sin(t * 2.2))); power(lamp.material as THREE.Material, 0.4 + k); (lampGlow.material as THREE.ShaderMaterial).uniforms.uPower.value = k; };
      chip = 0x1f3f8f; matter = 'plastic'; fuel = 0.8;
      break;
    }
    case 'astromech': {
      // white and blue astromech: domed head, cylindrical body, two side legs and a centre foot
      const R = 0.11;
      const white = std(0xf1f2f4, 0.35, 0.1), blue = std(0x2456c6, 0.4, 0.2), silver = std(0xc6ccd3, 0.2, 0.95);
      const core = piece(cyl(R * 0.7, R * 0.75, 0.05, 20), std(0x7b828b, 0.4, 0.8), [0, 0.06, 0]);
      deco(core, rbox(0.06, 0.04, 0.08, 0.008, false), white, [0, -0.04, 0]);
      const bodyTex = decalMat('astro-body', 256, 128, (g, w, h) => {
        g.fillStyle = '#f1f2f4'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#2456c6';
        for (const [x, y, ww, hh] of [[20, 12, 30, 40], [60, 12, 14, 70], [150, 10, 40, 22], [150, 40, 18, 50], [176, 40, 14, 50], [210, 14, 26, 30], [96, 70, 30, 40]]) g.fillRect(x, y, ww, hh);
        g.fillStyle = '#9aa3ad'; for (let x = 0; x < w; x += 16) g.fillRect(x, h - 10, 8, 4);
        g.strokeStyle = '#b5bcc4'; g.lineWidth = 2; g.strokeRect(84, 10, 50, 50);
      }, { rough: 0.35 });
      for (const s of [0, 1]) piece(new THREE.CylinderGeometry(R, R, 0.22, 24, 4, true, s * Math.PI, Math.PI), cached('astro-body-dbl', () => { const m = (bodyTex as THREE.MeshStandardMaterial).clone(); m.side = THREE.DoubleSide; return m; }), [0, 0.09 + 0.11, 0], [0, 0, 0], { panel: true, screws: 2 });
      piece(cyl(R * 0.92, R * 0.92, 0.2, 18), std(0x5a6068, 0.5, 0.7), [0, 0.2, 0]);
      const dome = piece(new THREE.SphereGeometry(R, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), silver, [0, 0.31, 0], [0, 0, 0], { mass: 0.15 });
      deco(dome, rbox(0.05, 0.04, 0.02, 0.005, false), blue, [0, 0.06, R * 0.78], [-0.6, 0, 0]);
      deco(dome, rbox(0.03, 0.03, 0.02, 0.005, false), blue, [-0.06, 0.05, R * 0.6], [-0.5, -0.6, 0]);
      const eye = deco(dome, disc(0.016, 0.02), std(0x111111, 0.1, 0.5), [0.03, 0.035, R * 0.9], [-0.35, 0.3, 0]);
      deco(eye, disc(0.008, 0.004), lit(0xff2a2a), [0, 0, 0.011]);
      const holo = deco(dome, disc(0.008, 0.01), lit(0x4aa8ff), [-0.05, 0.075, R * 0.65], [-0.8, -0.5, 0]);
      for (const x of [-1, 1]) {
        const leg = piece(rbox(0.035, 0.27, 0.06, 0.01), white, [x * (R + 0.022), 0.17, 0], [0.12, 0, 0], { screws: 2 });
        deco(leg, rbox(0.006, 0.12, 0.04, 0.003, false), blue, [x * 0.018, 0.02, 0]);
        deco(leg, rbox(0.05, 0.03, 0.09, 0.008, false), white, [0, -0.135, 0.01]);
        deco(leg, axle(0.024, 0.044, 14), silver, [0, 0.11, 0]);
      }
      anim = (t, p) => { dome.rotation.y = Math.sin(t * 0.8) * 0.6 * p; power(holo.material as THREE.Material, p * (0.5 + 0.5 * Math.sin(t * 9))); };
      chip = 0xf1f2f4;
      break;
    }
    case 'handheld': {
      // brick-style handheld console standing upright: grey shell, green dot-matrix screen, D-pad, two buttons
      const W = 0.26, H = 0.42, D = 0.08;
      const shell = std(0xc9c7bf, 0.55), darkg = std(0x3e3f47, 0.5);
      const core = piece(rbox(W - 0.02, 0.03, D - 0.02, 0.006), std(0x1f6e43, 0.6, 0.2), [0, 0.015, 0]); // the green PCB
      deco(core, rbox(W - 0.03, H - 0.06, 0.004, 0.002, false), std(0x1f6e43, 0.6, 0.2), [0, (H - 0.06) / 2, 0]);
      const front = panel(W, H, D / 2, shell, [0, H / 2, D / 4], { hinge: [0, -1, 0], screws: 3 }, [0, 0, 0]);
      const bezel = deco(front, rbox(W * 0.82, H * 0.38, 0.006, 0.012, false), std(0x5b5c66, 0.5), [0, H * 0.2, D / 4 + 0.002]);
      label(bezel, decalMat('handheld-screen', 64, 56, (g, w, h) => {
        g.fillStyle = '#9bb86a'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#2f4a1e';
        // falling block puzzle in progress
        const grid = ['..........', '..........', '....##....', '.....#....', '..........', '#........#', '##..#....#', '###.##.###', '####.#####'];
        grid.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') g.fillRect(8 + x * 4.8, 4 + y * 5.6, 4, 4.8); }));
        g.fillRect(6, 2, 1, h - 4); g.fillRect(57, 2, 1, h - 4);
      }, { pixel: true, rough: 0.6 }), W * 0.6, H * 0.28, [0, -0.005, 0.0035]);
      deco(bezel, disc(0.005, 0.004, 10), lit(0xff2a2a), [-W * 0.36, 0.02, 0.003]);
      const dpad = deco(front, rbox(0.075, 0.025, 0.012, 0.004, false), darkg, [-W * 0.24, -H * 0.12, D / 4 + 0.006]);
      deco(dpad, rbox(0.025, 0.075, 0.012, 0.004, false), darkg, [0, 0, 0]);
      for (const [x, y] of [[0.075, -0.1], [0.025, -0.125]]) deco(front, disc(0.018, 0.014, 18), std(0x9b2b55, 0.45), [x + 0.02, y * H * 2.4 * 0.4, D / 4 + 0.006]);
      for (const x of [-0.035, 0.015]) deco(front, rbox(0.032, 0.01, 0.008, 0.004, false), std(0x8a8b94, 0.5), [x, -H * 0.31, D / 4 + 0.004], [0, 0, 0.45]);
      label(front, decalMat('handheld-speaker', 32, 32, (g, w, h) => { g.fillStyle = '#c9c7bf'; g.fillRect(0, 0, w, h); g.strokeStyle = '#6d6c66'; g.lineWidth = 2.5; for (let i = 0; i < 6; i++) { g.beginPath(); g.moveTo(4 + i * 5, 28); g.lineTo(4 + i * 5 + 12, 4); g.stroke(); } }), 0.06, 0.06, [W * 0.3, -H * 0.4, D / 4 + 0.001]);
      const back = panel(W, H, D / 2, shell, [0, H / 2, -D / 4], { hinge: [0, -1, 0], screws: 2 });
      deco(back, rbox(W * 0.6, H * 0.3, 0.006, 0.006, false), std(0xbab8b0, 0.6), [0, -H * 0.22, -D / 4 - 0.002]); // battery cover
      for (const x of [-0.035, 0.035]) piece(cyl(0.016, 0.016, 0.1, 14), std(0xe8b423, 0.4, 0.4), [x, H * 0.22, -0.005], [0, 0, Math.PI / 2], { mass: 0.03 }); // AA cells
      chip = 0xc9c7bf; matter = 'plastic'; fuel = 0.5;
      break;
    }
    case 'd20': {
      const R = 0.22;
      const mat = decalMat('d20', 320, 256, (g, w, h) => {
        const cw = w / 5, ch = h / 4;
        for (let i = 0; i < 20; i++) {
          const x = (i % 5) * cw, y = Math.floor(i / 5) * ch;
          g.fillStyle = '#5a2db5'; g.fillRect(x, y, cw, ch);
          g.fillStyle = '#f2e7ff'; g.font = font(17); g.textAlign = 'center';
          // 20 opposite 1 and so on: numbers ordered so caps hold the extremes
          const n = [20, 2, 18, 4, 16, 6, 14, 8, 12, 10, 11, 9, 13, 7, 15, 5, 17, 3, 19, 1][i];
          g.fillText(String(n), x + cw / 2, y + ch * 0.613 + 6);
          if (n === 6 || n === 9) g.fillRect(x + cw / 2 - 5, y + ch * 0.613 + 9, 10, 2);
        }
        g.fillStyle = '#3f1d86'; g.fillRect(0, 0, 3, 3);
      }, { rough: 0.25, metal: 0.05 });
      const parts = d20Pieces(R);
      parts.forEach((geo, i) => piece(geo, mat, [0, R * 0.8, 0], [0, 0, 0], { mass: 0.3 }));
      // a dark core holds the last wedges together; it goes last
      coreMesh = piece(new THREE.IcosahedronGeometry(R * 0.55, 0), std(0x2a1260, 0.5), [0, R * 0.8, 0]);
      chip = 0x5a2db5; matter = 'plastic'; fuel = 0.2;
      break;
    }
    case 'creeper': {
      // a green pixel block mob: head with a face, body, four stubby feet
      const px = (key: string, face: boolean) => decalMat(`creeper-${key}`, 8, 8, (g) => {
        const greens = ['#5daa3c', '#4b9a2c', '#76c44e', '#3f8a26', '#8ad65f'];
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { g.fillStyle = greens[(x * 7 + y * 13 + (x * y) % 5) % greens.length]; g.fillRect(x, y, 1, 1); }
        if (face) {
          g.fillStyle = '#101410';
          g.fillRect(1, 2, 2, 2); g.fillRect(5, 2, 2, 2); g.fillRect(3, 4, 2, 3); g.fillRect(2, 5, 1, 3); g.fillRect(5, 5, 1, 3);
        }
      }, { pixel: true, rough: 0.9 });
      const S = 0.16;
      const core = piece(new THREE.BoxGeometry(S * 0.9, S * 1.5, S * 0.6), px('body', false), [0, S * 0.5 + S * 0.75, 0]);
      const head = piece(new THREE.BoxGeometry(S * 1.1, S * 1.1, S * 1.1), px('side', false), [0, S * 0.5 + S * 1.5 + S * 0.55, 0], [0, 0, 0], { mass: 0.3 });
      deco(head, plane(S * 1.1, S * 1.1), px('face', true), [0, 0, S * 0.551]);
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) piece(new THREE.BoxGeometry(S * 0.45, S * 0.5, S * 0.4), px('foot', false), [x * S * 0.23, S * 0.25, z * S * 0.31]);
      // the core goes last
      chip = 0x5daa3c; matter = 'soft'; fuel = 1;
      break;
    }
    case 'turret': {
      // white egg-shaped sentry on three thin legs, with one red eye
      const white = dbl(0xf4f5f7, 0.3, 0.05), dark = std(0x24262b, 0.5, 0.4);
      const R = 0.1, Y = 0.3;
      const core = piece(new THREE.SphereGeometry(R * 0.8, 16, 12).scale(0.75, 1.35, 0.95), dark, [0, Y, 0]);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + Math.PI / 2;
        deco(core, cyl(0.006, 0.004, 0.28, 6), dark, [Math.cos(a) * 0.08, -0.15, Math.sin(a) * 0.08], [Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4]);
      }
      for (const s of [-1, 1]) {
        // the two shell halves are the gun wings
        const half = piece(new THREE.SphereGeometry(R, 20, 16, s > 0 ? 0 : Math.PI, Math.PI).rotateY(Math.PI / 2).scale(1, 1.6, 1.15), white, [s * 0.006, Y, 0], [0, 0, 0], { panel: true, screws: 2, hinge: [0, -1, 0] });
        for (const y of [-0.03, 0.03]) deco(half, axle(0.006, 0.03, 8), dark, [s * 0.09, y, 0.04]);
      }
      const eye = piece(disc(0.03, 0.02, 24), std(0x101114, 0.2, 0.6), [0, Y + 0.04, R * 1.08]);
      const lens = deco(eye, disc(0.016, 0.006, 20), lit(0xff1a1a), [0, 0, 0.011]);
      const eyeGlow = glowHalo(eye, 0xff2020, 0.12, [0, 0, 0.016]);
      const beam = deco(eye, cyl(0.0012, 0.0012, 0.9, 4).rotateX(Math.PI / 2), lit(0xff3030), [0, 0, 0.46]);
      anim = (t, p) => { power(lens.material as THREE.Material, 0.3 + 0.7 * p); (eyeGlow.material as THREE.ShaderMaterial).uniforms.uPower.value = p * (0.8 + 0.2 * Math.sin(t * 6)); beam.visible = p > 0.5; };
      chip = 0xf4f5f7; matter = 'plastic';
      break;
    }
    case 'floppy': {
      // a giant 3.5" disk standing on its edge
      const S = 0.42, T = 0.04;
      const navy = std(0x1d2230, 0.45, 0.05);
      piece(rbox(S * 0.9, 0.03, T * 0.8, 0.006), navy, [0, 0.015, 0]);
      const front = panel(S, S, T / 2, navy, [0, S / 2, T / 4], { hinge: [0, -1, 0], screws: 2 });
      deco(front, plane(S * 0.74, S * 0.5), decalMat('floppy-label', 128, 96, (g, w, h) => {
        g.fillStyle = '#f5f3ea'; g.fillRect(0, 0, w, h); g.fillStyle = '#c94b4b'; g.fillRect(0, 0, w, 10);
        g.strokeStyle = '#9fb3d1'; g.lineWidth = 1; for (let y = 24; y < h; y += 12) { g.beginPath(); g.moveTo(6, y); g.lineTo(w - 6, y); g.stroke(); }
        g.fillStyle = '#23305a'; g.font = font(13, 'normal', '"Comic Sans MS", "Segoe Print", cursive'); g.fillText('backup_FINAL_v2', 8, 34); g.fillText('do not erase!!', 8, 58);
      }, { rough: 0.9 }), [0, -S * 0.2, T / 4 + 0.001]);
      const shutter = piece(rbox(S * 0.48, S * 0.34, T + 0.008, 0.004), std(0xc5cbd2, 0.2, 0.95), [-S * 0.04, S - S * 0.17 + 0.004, 0], [0, 0, 0], { mass: 0.05 });
      deco(shutter, rbox(S * 0.12, S * 0.24, T + 0.01, 0.003, false), std(0x0e1016, 0.5), [S * 0.06, 0, 0]);
      deco(front, rbox(0.03, 0.03, 0.006, 0.003, false), std(0x0e1016, 0.5), [S * 0.4, -S * 0.42, T / 4 + 0.001]); // write protect
      panel(S, S, T / 2, navy, [0, S / 2, -T / 4], { hinge: [0, -1, 0], screws: 2 });
      const disk = piece(disc(S * 0.4, 0.004, 40), std(0x4a3426, 0.3, 0.3), [0, S / 2, 0], [0, 0, 0], { mass: 0.05 });
      deco(disk, disc(S * 0.08, 0.008, 20), std(0xc5cbd2, 0.2, 0.95), [0, 0, 0]);
      chip = 0x1d2230; matter = 'plastic'; fuel = 0.6;
      break;
    }
    case 'rubik': {
      const atlas = decalMat('rubik', 256, 128, (g) => {
        const cols = ['#c41e3a', '#ff5800', '#ffffff', '#ffd500', '#009e60', '#0051ba', '#111111'];
        cols.forEach((c, i) => {
          const x = (i % 4) * 64, y = Math.floor(i / 4) * 64;
          g.fillStyle = '#111111'; g.fillRect(x, y, 64, 64);
          if (i < 6) { g.fillStyle = c; rrect(g, x + 6, y + 6, 52, 52, 8); g.fill(); }
        });
        g.fillStyle = '#111111'; g.fillRect(192, 64, 64, 64);
      }, { rough: 0.25 });
      const C = 0.12;
      // atlas rows count from the bottom in UV space: cells 0..3 on the bottom row of the canvas image
      const cell = (i: number) => (i < 4 ? i + 4 : i - 4); // canvas row 0 is UV row 1
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue;
        // +x red, -x orange, +y white, -y yellow, +z green, -z blue, inside black
        const faces = [x > 0 ? 0 : 6, x < 0 ? 1 : 6, y > 0 ? 2 : 6, y < 0 ? 3 : 6, z > 0 ? 4 : 6, z < 0 ? 5 : 6].map(cell);
        const m = piece(cubie(C * 0.98, faces), atlas, [x * C, C * 1.5 + y * C, z * C], [0, 0, 0], { mass: 0.05 });
        if (!x && y === -1 && !z) coreMesh = m;
      }
      chip = 0xffd500; matter = 'plastic'; fuel = 0.3;
      break;
    }
    case 'saber': {
      // a light-sword hilt resting on a display stand, blade lit
      const chrome = std(0xdfe4ea, 0.15, 1), black = std(0x141414, 0.7), wood = std(0x5a3a22, 0.6);
      const Y = 0.16, X = -0.2;
      const stand = piece(rbox(0.3, 0.035, 0.14, 0.012), wood, [X, 0.0175, 0]);
      for (const x of [-0.07, 0.07]) {
        deco(stand, rbox(0.025, Y - 0.04, 0.03, 0.006, false), wood, [x, (Y - 0.04) / 2, 0]);
        deco(stand, rbox(0.03, 0.02, 0.06, 0.006, false), wood, [x, Y - 0.05, 0]);
      }
      const hilt = piece(axle(0.02, 0.2, 18), black, [X, Y, 0], [0, 0, 0], { mass: 0.08 });
      for (let k = 0; k < 6; k++) deco(hilt, axle(0.022, 0.008, 18), std(0x2a2a2a, 0.8), [-0.05 + k * 0.016, 0, 0]);
      deco(hilt, rbox(0.03, 0.012, 0.016, 0.003, false), chrome, [0.04, 0.022, 0]);
      deco(hilt, rbox(0.008, 0.006, 0.006, 0.002, false), lit(0xff2020), [0.045, 0.03, 0]);
      piece(axle(0.024, 0.05, 18), chrome, [X + 0.125, Y, 0], [0, 0, 0], { mass: 0.04 }); // emitter
      piece(axle(0.02, 0.035, 18), chrome, [X - 0.1175, Y, 0], [0, 0, 0], { mass: 0.04 }); // pommel
      const blade = piece(axle(0.012, 0.44, 12), lit(0xeaf6ff), [X + 0.15 + 0.22, Y, 0], [0, 0, 0], { vanish: true, mass: 0.02 });
      const bladeGlow = deco(blade, new THREE.CylinderGeometry(0.032, 0.032, 0.46, 12, 1, true).rotateZ(Math.PI / 2), cached('saber-glow', () => glowMaterial({
        uniforms: { uPower: { value: 1 } },
        vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vV; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
        fragmentShader: /* glsl */ `uniform float uPower; varying vec3 vN; varying vec3 vV; void main() { float f = pow(abs(dot(normalize(vN), normalize(vV))), 2.5); gl_FragColor = vec4(vec3(0.25, 0.6, 1.0) * f * 1.4 * uPower, 0.0); }`,
      })), [0, 0, 0]);
      bladeGlow.renderOrder = 6;
      anim = (t) => { (bladeGlow.material as THREE.ShaderMaterial).uniforms.uPower.value = 0.85 + 0.15 * Math.sin(t * 40) * Math.sin(t * 17); };
      chip = 0x141414; fuel = 0.2;
      break;
    }
    case 'ghost': {
      // round-topped arcade ghost with a wavy hem and big eyes
      const colors = [0xff2a2a, 0xffb8ff, 0x29e6ff, 0xffb852];
      const c = colors[Math.floor(Math.random() * colors.length)];
      const R = 0.17, Hb = 0.16;
      const mat = dbl(c, 0.45, 0.05);
      piece(cyl(R * 0.7, R * 0.7, 0.03, 20), std(0x0b0b10, 0.6), [0, 0.015, 0]);
      for (const s of [0, 1]) {
        const g = new THREE.CylinderGeometry(R, R, Hb, 24, 6, true, s * Math.PI, Math.PI);
        const p = g.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < p.count; i++) {
          if (p.getY(i) > -Hb / 2 + 1e-4) continue;
          const a = Math.atan2(p.getX(i), p.getZ(i));
          p.setY(i, p.getY(i) + Math.cos(a * 4) * 0.025);
        }
        g.computeVertexNormals();
        piece(g, mat, [0, 0.04 + Hb / 2, 0], [0, 0, 0], { panel: true, screws: 0, hinge: [0, 1, 0] });
        piece(new THREE.SphereGeometry(R, 24, 12, s * Math.PI, Math.PI, 0, Math.PI / 2), mat, [0, 0.04 + Hb, 0], [0, 0, 0], { mass: 0.15 });
      }
      for (const x of [-0.065, 0.065]) {
        const white = piece(new THREE.SphereGeometry(0.045, 16, 12).scale(0.85, 1.1, 0.5), std(0xffffff, 0.3), [x, 0.04 + Hb + 0.04, R * 0.9], [0, 0, 0], { mass: 0.03 });
        deco(white, new THREE.SphereGeometry(0.022, 12, 8), std(0x2040d0, 0.3), [0.012, -0.004, 0.02]);
      }
      chip = c; matter = 'soft'; fuel = 0.7;
      break;
    }
    case 'hal': {
      // a ship computer's wall panel: brushed black, a chrome-rimmed lens with a red eye and a yellow centre
      const W = 0.24, H = 0.6, D = 0.12;
      const black = std(0x15161a, 0.35, 0.6), brushed = std(0x2a2c31, 0.3, 0.8), chrome = std(0xdfe4ea, 0.12, 1);
      cabinet(W, H, D, black, { foot: 0.01 });
      const front = panel(W, H - 0.01, 0.02, brushed, [0, 0.01 + (H - 0.01) / 2, D / 2 + 0.01], { screws: 4 });
      deco(front, rbox(W * 0.5, 0.035, 0.006, 0.003, false), std(0x8a9099, 0.25, 0.9), [0, H * 0.36, 0.012]);
      deco(front, rbox(W * 0.3, 0.012, 0.004, 0.002, false), std(0x0c0d10, 0.4), [0, H * 0.36, 0.016]);
      label(front, decalMat('hal-grille', 64, 64, (g, w, h) => { g.fillStyle = '#2a2c31'; g.fillRect(0, 0, w, h); g.fillStyle = '#0c0d10'; for (let y = 4; y < h; y += 6) for (let x = 4; x < w; x += 6) g.fillRect(x, y, 3, 3); }, { metal: 0.6 }), W * 0.5, W * 0.5, [0, -H * 0.3, 0.0105]);
      const lens = piece(disc(0.07, 0.03, 32), chrome, [0, H * 0.62, D / 2 + 0.035], [0, 0, 0], { mass: 0.1 });
      deco(lens, disc(0.058, 0.032, 32), std(0x050506, 0.05, 0.5), [0, 0, 0.002]);
      const red = deco(lens, disc(0.04, 0.004, 32), lit(0xc00000), [0, 0, 0.017]);
      const inner = deco(lens, disc(0.02, 0.004, 24), lit(0xff3020), [0, 0, 0.0185]);
      const pin = deco(lens, disc(0.006, 0.004, 12), lit(0xffe08a), [0, 0, 0.02]);
      const eyeGlow = glowHalo(lens, 0xff1a10, 0.26, [0, 0, 0.024]);
      anim = (t, p) => {
        const k = p * (0.85 + 0.15 * Math.sin(t * 1.3));
        power(red.material as THREE.Material, 0.2 + 0.8 * k); power(inner.material as THREE.Material, 0.2 + 0.8 * k); power(pin.material as THREE.Material, 0.2 + 0.8 * k);
        (eyeGlow.material as THREE.ShaderMaterial).uniforms.uPower.value = k;
      };
      chip = 0x15161a;
      break;
    }
    case 'duck': {
      const yellow = std(0xffd23f, 0.3), orange = std(0xff8c1a, 0.35), black = std(0x111111, 0.2);
      piece(new THREE.SphereGeometry(0.1, 16, 10).scale(1.2, 0.5, 1.3), yellow, [0, 0.05, 0]);
      for (const s of [-1, 1]) piece(new THREE.SphereGeometry(0.16, 20, 14, s > 0 ? 0 : Math.PI, Math.PI, 0, Math.PI * 0.62).scale(1, 0.95, 1.2), dbl(0xffd23f, 0.3), [0, 0.06, 0], [0, 0, 0], { panel: true, screws: 0 });
      for (const s of [-1, 1]) piece(new THREE.SphereGeometry(0.06, 14, 10).scale(0.4, 0.8, 1.3), yellow, [s * 0.15, 0.13, -0.01], [0, 0, s * 0.3], { mass: 0.04 }); // wings
      const head = piece(new THREE.SphereGeometry(0.095, 20, 16), yellow, [0, 0.27, 0.07], [0, 0, 0], { mass: 0.1 });
      deco(head, new THREE.SphereGeometry(0.045, 14, 10).scale(1.1, 0.45, 1.3), orange, [0, -0.02, 0.09]);
      for (const x of [-0.04, 0.04]) { const e = deco(head, new THREE.SphereGeometry(0.018, 10, 8), std(0xffffff, 0.3), [x, 0.025, 0.078]); deco(e, new THREE.SphereGeometry(0.01, 8, 6), black, [0, 0, 0.012]); }
      piece(new THREE.ConeGeometry(0.05, 0.08, 12).rotateX(-Math.PI / 2 - 0.6), yellow, [0, 0.17, -0.19], [0, 0, 0], { mass: 0.03 }); // tail
      chip = 0xffd23f; matter = 'soft'; fuel = 0.6;
      break;
    }
    case 'cone': {
      const orange = std(0xff5a10, 0.5), black = std(0x1a1a1a, 0.85);
      piece(rbox(0.26, 0.025, 0.26, 0.01), black, [0, 0.0125, 0]);
      piece(cyl(0.1, 0.125, 0.12, 24, true), dbl(0xff5a10, 0.5), [0, 0.025 + 0.06, 0], [0, 0, 0], { panel: true, screws: 0 });
      const mid = piece(cyl(0.065, 0.1, 0.13, 24, true), dbl(0xf6f6f6, 0.35, 0.1), [0, 0.145 + 0.065, 0], [0, 0, 0], { mass: 0.06 });
      deco(mid, cyl(0.084, 0.09, 0.03, 24, true), orange, [0, -0.035, 0]);
      piece(new THREE.ConeGeometry(0.065, 0.16, 24, 1, true), dbl(0xff5a10, 0.5), [0, 0.275 + 0.08, 0], [0, 0, 0], { mass: 0.05 });
      chip = 0xff5a10; matter = 'plastic'; fuel = 0.4;
      break;
    }
    case 'gnome': {
      const red = std(0xd62828, 0.6), blue = std(0x2b59c3, 0.6), skin = std(0xf1c6a7, 0.75), beard = std(0xf7f7f2, 0.95), brown = std(0x5b3a1e, 0.85), boot = std(0x2a1d14, 0.7);
      const core = piece(cyl(0.1, 0.11, 0.03, 18), std(0x6a7a52, 0.95), [0, 0.015, 0]); // grassy base
      for (const x of [-0.035, 0.035]) deco(core, new THREE.SphereGeometry(0.032, 12, 8).scale(1, 0.7, 1.4), boot, [x, 0.03, 0.02]);
      const body = piece(cyl(0.07, 0.09, 0.15, 18), blue, [0, 0.03 + 0.075, 0], [0, 0, 0], { mass: 0.15 });
      deco(body, cyl(0.075, 0.08, 0.02, 18), brown, [0, -0.02, 0]);
      deco(body, rbox(0.03, 0.022, 0.01, 0.004, false), std(0xe5c04a, 0.3, 0.8), [0, -0.02, 0.08]);
      for (const s of [-1, 1]) piece(new THREE.CapsuleGeometry(0.022, 0.07, 4, 10), blue, [s * 0.085, 0.13, 0.02], [0.5, 0, s * 0.4], { mass: 0.02 });
      const head = piece(new THREE.SphereGeometry(0.055, 16, 12), skin, [0, 0.215, 0.01], [0, 0, 0], { mass: 0.06 });
      deco(head, new THREE.SphereGeometry(0.018, 10, 8), std(0xe89a85, 0.6), [0, -0.005, 0.055]);
      for (const x of [-0.02, 0.02]) deco(head, new THREE.SphereGeometry(0.007, 8, 6), std(0x111111, 0.3), [x, 0.012, 0.05]);
      piece(new THREE.ConeGeometry(0.06, 0.13, 16).rotateX(Math.PI), beard, [0, 0.14, 0.05], [-0.25, 0, 0], { mass: 0.03 });
      piece(new THREE.ConeGeometry(0.068, 0.17, 18), red, [0, 0.32, -0.005], [-0.15, 0, 0], { mass: 0.03 });
      chip = 0xd62828; matter = 'plastic'; fuel = 0.4;
      break;
    }
    default: {
      // plush idol in a grey outfit with long teal twin tails, sitting
      const skin = std(0xf7e6d8, 0.9), teal = std(0x39c5bb, 0.85), grey = std(0x6b7078, 0.9), dark = std(0x24262b, 0.9), pink = std(0xe8457a, 0.8);
      const core = piece(rbox(0.16, 0.045, 0.13, 0.02), dark, [0, 0.0225, 0.02]);
      const body = piece(cyl(0.05, 0.075, 0.11, 16), grey, [0, 0.045 + 0.055, 0], [0, 0, 0], { mass: 0.06 });
      deco(body, rbox(0.018, 0.05, 0.01, 0.004, false), teal, [0, 0.01, 0.06]);
      const head = piece(new THREE.SphereGeometry(0.09, 20, 16), skin, [0, 0.24, 0], [0, 0, 0], { mass: 0.06 });
      deco(head, new THREE.SphereGeometry(0.096, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), teal, [0, 0, 0], [-0.35, 0, 0]);
      deco(head, rbox(0.12, 0.03, 0.02, 0.01, false), teal, [0, 0.055, 0.075], [0.3, 0, 0]); // fringe
      for (const x of [-0.032, 0.032]) {
        const e = deco(head, new THREE.SphereGeometry(0.016, 10, 8).scale(1, 1.25, 0.5), std(0x1f6f8b, 0.35), [x, -0.005, 0.083]);
        deco(e, new THREE.SphereGeometry(0.005, 6, 4), std(0xffffff, 0.2), [0.004, 0.006, 0.006]);
      }
      for (const side of [-1, 1]) {
        const tail = piece(new THREE.CapsuleGeometry(0.032, 0.24, 4, 12), teal, [side * 0.125, 0.15, -0.03], [0, 0, side * 0.3], { mass: 0.03 });
        deco(tail, rbox(0.05, 0.02, 0.04, 0.006, false), pink, [0, 0.13, 0]);
        piece(new THREE.CapsuleGeometry(0.022, 0.06, 4, 8), skin, [side * 0.07, 0.11, 0.035], [0.5, 0, side * 0.5], { mass: 0.02 });
      }
      chip = 0x39c5bb; matter = 'soft'; fuel = 0.6;
    }
  }

  const ci = coreMesh ? pieces.findIndex((p) => p.mesh === coreMesh) : 0;
  pieces.push(pieces.splice(ci, 1)[0]);
  return finish(kind, pieces, matter, fuel, new THREE.Color(chip), glows, anim);
}

const box = new THREE.Box3();
const tmp = new THREE.Vector3();

function finish(kind: Kind, pieces: Piece[], matter: Build['matter'], fuel: number, chip: THREE.Color, glows: THREE.Material[], anim: ((t: number, p: number) => void) | null): Build {
  // scale to arena size
  for (const p of pieces) {
    p.mesh.position.multiplyScalar(K);
    p.mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.scale(K, K, K);
      if (o !== p.mesh) o.position.multiplyScalar(K);
    });
  }
  // centre each piece's box on its origin so the physics box matches the mesh
  for (const p of pieces) {
    const pos = p.mesh.position.clone(), q = p.mesh.quaternion.clone();
    p.mesh.position.set(0, 0, 0); p.mesh.quaternion.identity(); p.mesh.updateMatrixWorld(true);
    box.setFromObject(p.mesh, true);
    const c = box.getCenter(new THREE.Vector3());
    p.half.copy(box.getSize(tmp).multiplyScalar(0.5));
    if (c.lengthSq() > 1e-8) {
      p.mesh.geometry.translate(-c.x, -c.y, -c.z);
      for (const ch of p.mesh.children) ch.position.sub(c);
      pos.add(c.applyQuaternion(q));
    }
    p.mesh.position.copy(pos); p.mesh.quaternion.copy(q);
    if (!p.mass) p.mass = THREE.MathUtils.clamp(p.half.x * p.half.y * p.half.z * 8 * 900, 0.04, 0.8);
  }
  // centre the whole thing on the appliance origin
  const all = new THREE.Box3();
  for (const p of pieces) { p.mesh.updateMatrixWorld(true); all.union(box.setFromObject(p.mesh, true)); }
  const c = all.getCenter(new THREE.Vector3());
  for (const p of pieces) {
    p.mesh.position.sub(c);
    p.home.copy(p.mesh.position);
    p.homeQ.copy(p.mesh.quaternion);
  }
  const half = all.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const core = pieces[pieces.length - 1];
  const uniqueGlows = [...new Set(glows)];
  return {
    kind, pieces, core, half, matter, fuel, chip,
    tick: (t, p) => {
      for (const m of uniqueGlows) power(m, (m.userData.halo ? p : 0.2 + 0.8 * p) * (p < 0.999 && p > 0.02 && Math.random() < 0.08 ? 0.3 : 1));
      anim?.(t, p);
    },
  };
}
