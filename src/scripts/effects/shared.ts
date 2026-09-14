import * as THREE from '../three-lite';
import type { EffectContext } from './types';

export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Turn `current` toward `target` by at most `maxStep` radians. */
export function turnToward(current: number, target: number, maxStep: number) {
  const d = wrapAngle(target - current);
  return current + THREE.MathUtils.clamp(d, -maxStep, maxStep);
}

/** Additive glow that leaves destination alpha alone, so it composites over the page background. */
export function glowMaterial(params: THREE.ShaderMaterialParameters) {
  return new THREE.ShaderMaterial({
    ...params,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
}

/** Bounding box of objects expressed in the body's local space. */
export function boundsInBody(ctx: EffectContext, objects: THREE.Object3D[]) {
  ctx.body.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(ctx.body.matrixWorld).invert();
  const b = new THREE.Box3();
  for (const o of objects) {
    const ob = new THREE.Box3().setFromObject(o, true);
    if (!ob.isEmpty()) b.union(ob);
  }
  return b.applyMatrix4(inv);
}

/** Scale the model holder (it scales about its base centre, so it stays on the ground). */
export function shrinkModel(ctx: EffectContext, k: number) {
  ctx.model.scale.setScalar(k);
  ctx.model.updateMatrixWorld(true);
}

/** Recolour the saturated parts of a model to a new hue, leaving neutrals alone. */
export function recolor(obj: THREE.Object3D, hex: number) {
  const target = new THREE.Color(hex).getHSL({ h: 0, s: 0, l: 0 });
  const hsl = { h: 0, s: 0, l: 0 };
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => {
      const c = (m as THREE.MeshStandardMaterial).clone();
      c.color.getHSL(hsl);
      if (hsl.s > 0.3 && hsl.l > 0.12 && hsl.l < 0.9) c.color.setHSL(target.h, Math.max(target.s, 0.65), THREE.MathUtils.clamp(hsl.l, 0.25, 0.6));
      return c;
    });
    mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
  });
}

/** A short-lived spray of additive particles (sparks, dust). */
export class Sparks {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private cursor = 0;
  constructor(parent: THREE.Object3D, capacity = 160, color = 0xffb347, size = 0.035) {
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    const geo = new THREE.BufferGeometry();
    const attr = new THREE.Float32BufferAttribute(this.pos, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr);
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color, size, sizeAttenuation: true, transparent: true, depthWrite: false, toneMapped: false,
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      }),
    );
    this.points.frustumCulled = false;
    parent.add(this.points);
    for (let i = 0; i < capacity; i++) this.pos[i * 3 + 1] = -100;
  }
  burst(at: THREE.Vector3, count: number, speed: number, dir = new THREE.Vector3(0, 1, 0)) {
    const n = this.life.length;
    for (let k = 0; k < count; k++) {
      const i = this.cursor++ % n;
      const v = new THREE.Vector3(rand(-1, 1), rand(0.2, 1.2), rand(-1, 1)).normalize().add(dir).normalize().multiplyScalar(speed * rand(0.4, 1.3));
      this.pos.set([at.x, at.y, at.z], i * 3);
      this.vel.set([v.x, v.y, v.z], i * 3);
      this.life[i] = rand(0.35, 0.8);
    }
  }
  update(dt: number, floor = 0) {
    for (let i = 0; i < this.life.length; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const j = i * 3;
      this.vel[j + 1] -= 6 * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      if (this.pos[j + 1] < floor) { this.pos[j + 1] = floor; this.vel[j + 1] *= -0.3; }
      if (this.life[i] <= 0) this.pos[j + 1] = -100;
    }
    (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
