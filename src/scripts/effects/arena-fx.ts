// Pooled effects for the combat arena: one instanced draw call per kind.
//   Sprites  camera-facing quads (sparks stretched along their velocity, flickering flames, embers, soft smoke)
//   Bits     tiny lit rigid bits (screws, bolts, paint chips) with gravity, bounces and rest
// All positions are in the cell body's local space; everything advances with the dt it is given.

import * as THREE from '../three-lite';
import { glowMaterial, rand } from './shared';

const VERT = /* glsl */ `
  attribute vec3 iPos;
  attribute vec3 iVel;
  attribute vec3 iCol;
  attribute vec4 iData; // size, age 0..1, seed, stretch
  varying vec2 vUv;
  varying vec3 vCol;
  varying vec2 vAgeSeed;
  void main() {
    vUv = uv;
    vCol = iCol;
    vAgeSeed = iData.yz;
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    vec2 q = position.xy;
    float size = iData.x;
    // streaks (stretch > 0) trail behind the particle along its projected velocity; branch-free on purpose
    vec2 d = (modelViewMatrix * vec4(iVel, 0.0)).xy;
    float l = length(d) + 1e-6;
    float streak = step(1e-6, iData.w);
    vec2 dir = mix(vec2(0.0, 1.0), d / l, streak);
    vec2 side = vec2(dir.y, -dir.x);
    mv.xy += side * q.x * size + dir * (q.y - 0.5 * streak) * (size + l * iData.w);
    gl_Position = projectionMatrix * mv;
  }
`;

const SPARK_FRAG = /* glsl */ `
  varying vec2 vUv; varying vec3 vCol; varying vec2 vAgeSeed;
  void main() {
    float age = vAgeSeed.x;
    float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
    float along = smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.85, vUv.y);
    float a = across * across * along * (1.0 - age);
    vec3 hot = mix(vec3(1.0, 0.96, 0.85), vCol, smoothstep(0.0, 0.5, age));
    hot = mix(hot, vCol * vec3(0.8, 0.3, 0.15), smoothstep(0.5, 1.0, age));
    gl_FragColor = vec4(hot * a * 1.6, 0.0);
  }
`;

const FLAME_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv; varying vec3 vCol; varying vec2 vAgeSeed;
  void main() {
    float age = vAgeSeed.x, seed = vAgeSeed.y;
    vec2 p = vUv * 2.0 - 1.0;
    // teardrop: wide and round at the bottom, licking to a point at the top, wobbling
    p.x += sin(p.y * 3.0 + uTime * 13.0 + seed * 40.0) * 0.12 * (p.y + 1.0);
    float w = mix(0.95, 0.15, smoothstep(-0.6, 1.0, p.y));
    float r = length(vec2(p.x / w, (p.y + 0.35) * 0.75));
    float body = smoothstep(1.0, 0.15, r);
    float flick = 0.75 + 0.25 * sin(uTime * 37.0 + seed * 91.0);
    vec3 core = vec3(1.0, 0.93, 0.62);
    vec3 col = mix(core, vCol, smoothstep(0.0, 0.55, age + r * 0.35));
    col = mix(col, vec3(0.55, 0.08, 0.02), smoothstep(0.55, 1.0, age));
    float a = body * flick * smoothstep(0.0, 0.12, age) * (1.0 - age);
    gl_FragColor = vec4(col * a * 1.3, 0.0);
  }
`;

const SMOKE_FRAG = /* glsl */ `
  varying vec2 vUv; varying vec3 vCol; varying vec2 vAgeSeed;
  float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    float age = vAgeSeed.x, seed = vAgeSeed.y;
    vec2 p = vUv * 2.0 - 1.0;
    float lumpy = n(p * 2.5 + seed * 17.0) * 0.5 + n(p * 5.0 - seed * 9.0) * 0.25;
    float r = length(p) + (lumpy - 0.37) * 0.55;
    float a = pow(smoothstep(1.0, 0.05, r), 1.6) * smoothstep(0.0, 0.12, age) * pow(1.0 - age, 1.3) * 0.42;
    // a little lighter on top, like it's lit from above
    vec3 col = vCol * (0.8 + 0.35 * vUv.y + lumpy * 0.25);
    gl_FragColor = vec4(col, a);
  }
`;

type SpriteOpts = { grow?: number; buoy?: number; drag?: number; stretch?: number };

export class Sprites {
  readonly mesh: THREE.InstancedMesh;
  private n: number;
  private cursor = 0;
  private pos: Float32Array; private vel: Float32Array; private col: Float32Array; private data: Float32Array;
  private age: Float32Array; private life: Float32Array; private size: Float32Array; private grow: Float32Array;
  private buoy: Float32Array; private drag: Float32Array;
  private aPos: THREE.InstancedBufferAttribute; private aVel: THREE.InstancedBufferAttribute;
  private aCol: THREE.InstancedBufferAttribute; private aData: THREE.InstancedBufferAttribute;
  live = 0;

  constructor(parent: THREE.Object3D, capacity: number, kind: 'spark' | 'flame' | 'smoke', uniforms: { uTime: { value: number } }) {
    this.n = capacity;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mk = (k: number) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * k), k); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.aPos = mk(3); this.aVel = mk(3); this.aCol = mk(3); this.aData = mk(4);
    geo.setAttribute('iPos', this.aPos); geo.setAttribute('iVel', this.aVel); geo.setAttribute('iCol', this.aCol); geo.setAttribute('iData', this.aData);
    this.pos = this.aPos.array as Float32Array; this.vel = this.aVel.array as Float32Array;
    this.col = this.aCol.array as Float32Array; this.data = this.aData.array as Float32Array;
    this.age = new Float32Array(capacity).fill(1); this.life = new Float32Array(capacity).fill(1);
    this.size = new Float32Array(capacity); this.grow = new Float32Array(capacity);
    this.buoy = new Float32Array(capacity); this.drag = new Float32Array(capacity);
    const mat = kind === 'smoke'
      ? new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: SMOKE_FRAG, transparent: true, depthWrite: false })
      : glowMaterial({ uniforms, vertexShader: VERT, fragmentShader: kind === 'spark' ? SPARK_FRAG : FLAME_FRAG });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = kind === 'smoke' ? 5 : 6;
    parent.add(this.mesh);
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, color: THREE.Color, o: SpriteOpts = {}) {
    const i = this.cursor++ % this.n;
    const j = i * 3;
    this.pos[j] = x; this.pos[j + 1] = y; this.pos[j + 2] = z;
    this.vel[j] = vx; this.vel[j + 1] = vy; this.vel[j + 2] = vz;
    this.col[j] = color.r; this.col[j + 1] = color.g; this.col[j + 2] = color.b;
    this.age[i] = 0; this.life[i] = life; this.size[i] = size;
    this.grow[i] = o.grow ?? 0; this.buoy[i] = o.buoy ?? -6; this.drag[i] = o.drag ?? 0;
    this.data[i * 4 + 2] = Math.random();
    this.data[i * 4 + 3] = o.stretch ?? 0;
  }

  update(dt: number, floor: number) {
    let live = 0;
    for (let i = 0; i < this.n; i++) {
      const k = i * 4;
      if (this.age[i] >= 1) { this.data[k] = 0; continue; }
      live++;
      const age = (this.age[i] = Math.min(1, this.age[i] + dt / this.life[i]));
      const j = i * 3;
      const dr = Math.exp(-this.drag[i] * dt);
      this.vel[j] *= dr; this.vel[j + 2] *= dr;
      this.vel[j + 1] = this.vel[j + 1] * dr + this.buoy[i] * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      if (this.pos[j + 1] < floor) { this.pos[j + 1] = floor; this.vel[j + 1] *= -0.35; this.vel[j] *= 0.55; this.vel[j + 2] *= 0.55; }
      this.data[k] = this.size[i] * (1 + this.grow[i] * age);
      this.data[k + 1] = age;
    }
    this.live = live;
    this.mesh.visible = live > 0;
    if (!live) return;
    this.aPos.needsUpdate = true; this.aVel.needsUpdate = true; this.aCol.needsUpdate = true; this.aData.needsUpdate = true;
  }

  clear() { this.age.fill(1); }
}

/** Index-concatenate simple geometries (all with position, normal, uv, index). */
function merge(list: THREE.BufferGeometry[]) {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  for (const g of list) {
    const base = pos.length / 3;
    pos.push(...(g.attributes.position.array as Float32Array));
    nor.push(...(g.attributes.normal.array as Float32Array));
    uv.push(...(g.attributes.uv.array as Float32Array));
    for (const k of g.index!.array as ArrayLike<number>) idx.push(base + k);
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  return out;
}

/** A hex-head bolt about 1 unit long along +y (scaled per instance). */
export function boltGeometry() {
  return merge([
    new THREE.CylinderGeometry(0.32, 0.32, 0.22, 6).translate(0, 0.39, 0),
    new THREE.CylinderGeometry(0.13, 0.13, 0.8, 6).translate(0, -0.1, 0),
  ]);
}

const m4 = new THREE.Matrix4();
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();
const va = new THREE.Vector3();
const vs = new THREE.Vector3();

/** Tiny lit rigid bits with point physics: they bounce, skid, tumble and come to rest. */
export class Bits {
  readonly mesh: THREE.InstancedMesh;
  private n: number;
  private cursor = 0;
  private pos: Float32Array; private vel: Float32Array; private ang: Float32Array;
  private quat: Float32Array; private size: Float32Array; private age: Float32Array; private life: Float32Array;
  private rest: Uint8Array;

  constructor(parent: THREE.Object3D, capacity: number, geo: THREE.BufferGeometry, mat: THREE.Material, private hx: number, private hz: number) {
    this.n = capacity;
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false;
    this.pos = new Float32Array(capacity * 3); this.vel = new Float32Array(capacity * 3); this.ang = new Float32Array(capacity * 3);
    this.quat = new Float32Array(capacity * 4); this.size = new Float32Array(capacity);
    this.age = new Float32Array(capacity).fill(1e9); this.life = new Float32Array(capacity).fill(1);
    this.rest = new Uint8Array(capacity);
    m4.makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, m4);
    parent.add(this.mesh);
  }

  spawn(at: THREE.Vector3, vel: THREE.Vector3, size: number, color?: THREE.Color, life = 9) {
    const i = this.cursor++ % this.n;
    const j = i * 3;
    this.pos[j] = at.x; this.pos[j + 1] = at.y; this.pos[j + 2] = at.z;
    this.vel[j] = vel.x; this.vel[j + 1] = vel.y; this.vel[j + 2] = vel.z;
    this.ang[j] = rand(-30, 30); this.ang[j + 1] = rand(-30, 30); this.ang[j + 2] = rand(-30, 30);
    qa.setFromAxisAngle(va.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize(), rand(0, 6));
    qa.toArray(this.quat, i * 4);
    this.size[i] = size; this.age[i] = 0; this.life[i] = life * rand(0.8, 1.2); this.rest[i] = 0;
    if (color) this.mesh.setColorAt(i, color);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Make every bit shrink away soon (when the wreck is cleared). */
  expire(inSeconds: number) {
    for (let i = 0; i < this.n; i++) if (this.age[i] < this.life[i]) this.life[i] = Math.min(this.life[i], this.age[i] + inSeconds * rand(0.6, 1));
  }

  update(dt: number, floor: number) {
    let dirty = false;
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] > this.life[i] + 0.5) continue;
      dirty = true;
      this.age[i] += dt;
      const j = i * 3;
      const s = this.size[i];
      const shrink = Math.max(0, Math.min(1, 1 - (this.age[i] - this.life[i]) / 0.5));
      if (!this.rest[i]) {
        this.vel[j + 1] -= 9.8 * dt;
        this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt;
        const r = s * 0.25;
        if (this.pos[j + 1] < floor + r) {
          this.pos[j + 1] = floor + r;
          if (this.vel[j + 1] < 0) this.vel[j + 1] *= -0.38;
          this.vel[j] *= 0.8; this.vel[j + 2] *= 0.8;
          this.ang[j] *= 0.7; this.ang[j + 1] *= 0.7; this.ang[j + 2] *= 0.7;
          if (Math.abs(this.vel[j + 1]) < 0.15 && this.vel[j] * this.vel[j] + this.vel[j + 2] * this.vel[j + 2] < 0.01) this.rest[i] = 1;
        }
        // walls
        if (Math.abs(this.pos[j]) > this.hx) { this.pos[j] = Math.sign(this.pos[j]) * this.hx; this.vel[j] *= -0.4; }
        if (Math.abs(this.pos[j + 2]) > this.hz) { this.pos[j + 2] = Math.sign(this.pos[j + 2]) * this.hz; this.vel[j + 2] *= -0.4; }
        const wx = this.ang[j], wy = this.ang[j + 1], wz = this.ang[j + 2];
        const w = Math.hypot(wx, wy, wz);
        if (w > 1e-4) {
          qa.fromArray(this.quat, i * 4);
          qa.premultiply(qb.setFromAxisAngle(va.set(wx / w, wy / w, wz / w), w * dt)).normalize();
          qa.toArray(this.quat, i * 4);
        }
      }
      qa.fromArray(this.quat, i * 4);
      m4.compose(va.set(this.pos[j], this.pos[j + 1], this.pos[j + 2]), qa, vs.setScalar(s * shrink));
      this.mesh.setMatrixAt(i, m4);
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
