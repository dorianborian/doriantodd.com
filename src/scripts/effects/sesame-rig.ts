// Posable Sesame for the home scene, built from the real printed parts and Sesame Studio's joint rig
// (public/sesame/rig.glb + rig.json, made by scripts/sesame-rig.mjs). Poses use Studio's transform order
// (translate to pivot, rotate about the joint axis, translate back), and sequences are the firmware's own
// built-in poses, played back with servo slew limits. Ground contact: after every pose the body tilts
// onto its lowest feet and settles under gravity, so poses like pushup, worm or dead really lie on the floor.

import * as THREE from '../three-lite';

export const SERVOS = ['R1', 'R2', 'L1', 'L2', 'R4', 'R3', 'L3', 'L4'] as const;
type Servo = (typeof SERVOS)[number];
type Angles = Record<Servo, number>;
export type SeqFrame = { ms: number; a: Angles; face: string | null };
type Offset = { position: [number, number, number]; rotation: [number, number, number] };
type JointCfg = { stl: string; pivot: [number, number, number]; axis?: 'X' | 'Y' | 'Z'; parent: string | null; rest_angle?: number; invert?: boolean; offset?: Offset };
type RigJson = {
  rig: { body: { frame_stl: string; bottom_stl: string; cover_stl?: string; frame_offset?: Offset; bottom_offset?: Offset; cover_offset?: Offset }; joints: Record<string, JointCfg> };
  sequences: Record<string, SeqFrame[]>;
};

const DEG = Math.PI / 180;
// three.js strips . : / [ ] from node names and turns spaces into underscores
const key = (name: string) => name.replace(/[[\].:/]/g, '').replace(/\s/g, '_');
const AXES = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) };
export const STAND: Angles = { R1: 135, R2: 45, L1: 45, L2: 135, R4: 0, R3: 180, L3: 0, L4: 180 };
const SLEW = 520; // deg/s, an MG90 under load

function offsetMatrix(offset: Offset, center: THREE.Vector3) {
  const [px, py, pz] = offset.position, [rx, ry, rz] = offset.rotation;
  return new THREE.Matrix4().makeTranslation(px, py, pz)
    .multiply(new THREE.Matrix4().makeTranslation(center.x, center.y, center.z))
    .multiply(new THREE.Matrix4().makeRotationZ(rz * DEG))
    .multiply(new THREE.Matrix4().makeRotationY(ry * DEG))
    .multiply(new THREE.Matrix4().makeRotationX(rx * DEG))
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
}

export type Rig = Awaited<ReturnType<typeof buildRig>>;

/**
 * root: place and yaw this (forward is the root's +z). The rig inside is in millimetres, scaled by `scale`.
 * Call play(name) to queue a firmware sequence, update(dt) every frame.
 */
export async function buildRig(load: (url: string) => Promise<THREE.Object3D>, scale: number, colors: { body: number; leg: number; foot: number }) {
  const [gltf, data] = await Promise.all([load('/sesame/rig.glb'), fetch('/sesame/rig.json').then((r) => r.json() as Promise<RigJson>)]);
  gltf.updateMatrixWorld(true);
  const geoms: Record<string, THREE.BufferGeometry> = {};
  gltf.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // bake the dequantisation transform so geometry is back in STL millimetres
    // positions are quantised integers in the file: copy them out as floats before transforming
    const src = mesh.geometry.attributes.position;
    const pos = new Float32Array(src.count * 3);
    for (let i = 0; i < src.count; i++) { pos[i * 3] = src.getX(i); pos[i * 3 + 1] = src.getY(i); pos[i * 3 + 2] = src.getZ(i); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (mesh.geometry.index) g.setIndex(mesh.geometry.index.clone());
    g.applyMatrix4(mesh.matrixWorld);
    g.computeVertexNormals();
    g.computeBoundingBox();
    for (const n of [mesh.name, mesh.parent?.name]) if (n) geoms[key(n)] = g;
  });
  const mats = {
    body: new THREE.MeshStandardMaterial({ color: colors.body, roughness: 0.5, metalness: 0.05 }),
    leg: new THREE.MeshStandardMaterial({ color: colors.leg, roughness: 0.5, metalness: 0.1 }),
    foot: new THREE.MeshStandardMaterial({ color: colors.foot, roughness: 0.5, metalness: 0.05 }),
  };

  const root = new THREE.Group();     // world placement, yaw
  const yawFix = new THREE.Group();   // rig forward (-x) to root forward (+z)
  yawFix.rotation.y = Math.PI / 2;
  const tilt = new THREE.Group();     // ground-contact pitch and roll (in rig axes)
  const lift = new THREE.Group();     // ground-contact height
  const inner = new THREE.Group();    // millimetre rig
  inner.scale.setScalar(scale);
  root.add(yawFix);
  yawFix.add(lift);
  lift.add(tilt);
  tilt.add(inner);

  const zero: Offset = { position: [0, 0, 0], rotation: [0, 0, 0] };
  const parts: THREE.Mesh[] = [];
  const addPart = (file: string | undefined, offset: Offset | undefined, mat: THREE.Material, parent: THREE.Object3D) => {
    const g = file ? geoms[key(file)] : undefined;
    if (!g) return null;
    const mesh = new THREE.Mesh(g, mat);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(offsetMatrix(offset ?? zero, g.boundingBox!.getCenter(new THREE.Vector3())));
    parent.add(mesh);
    parts.push(mesh);
    return mesh;
  };
  const body = data.rig.body;
  addPart(body.frame_stl, body.frame_offset, mats.body, inner);
  addPart(body.bottom_stl, body.bottom_offset, mats.body, inner);
  const cover = addPart(body.cover_stl, body.cover_offset, mats.body, inner);

  const joints: Partial<Record<Servo, { group: THREE.Group; cfg: JointCfg; foot: THREE.Mesh | null }>> = {};
  const groups: Record<string, THREE.Group> = {};
  for (const name of Object.keys(data.rig.joints)) { groups[name] = new THREE.Group(); groups[name].matrixAutoUpdate = false; }
  for (const [name, cfg] of Object.entries(data.rig.joints)) {
    (cfg.parent ? groups[cfg.parent] : inner).add(groups[name]);
    const mesh = addPart(cfg.stl, cfg.offset, cfg.parent ? mats.foot : mats.leg, groups[name]);
    joints[name as Servo] = { group: groups[name], cfg, foot: cfg.parent ? mesh : null };
  }

  const current: Angles = { ...STAND };
  const target: Angles = { ...STAND };
  const pose = () => {
    for (const s of SERVOS) {
      const j = joints[s];
      if (!j) continue;
      let raw = current[s];
      if (j.cfg.invert) raw = 180 - raw;
      const [px, py, pz] = j.cfg.pivot;
      j.group.matrix.makeTranslation(px, py, pz)
        .multiply(new THREE.Matrix4().makeRotationAxis(AXES[j.cfg.axis ?? 'Y'], (raw - (j.cfg.rest_angle ?? 90)) * DEG))
        .multiply(new THREE.Matrix4().makeTranslation(-px, -py, -pz));
      j.group.matrixWorldNeedsUpdate = true;
    }
  };
  pose();

  // centre the standing footprint on the root
  yawFix.rotation.y = 0;
  root.updateMatrixWorld(true);
  const box0 = new THREE.Box3().setFromObject(inner);
  yawFix.rotation.y = Math.PI / 2;
  const c0 = box0.getCenter(new THREE.Vector3());
  inner.position.set(-c0.x, -box0.min.y, -c0.z);
  const size = box0.getSize(new THREE.Vector3());

  // the OLED face sits on the front of the top cover (rig forward is -x)
  let faceAnchor: THREE.Object3D = inner;
  let faceSpot = new THREE.Vector3(box0.min.x / scale, c0.y / scale, c0.z / scale);
  if (cover) {
    const g = cover.geometry.boundingBox!.clone().applyMatrix4(cover.matrix);
    faceAnchor = inner;
    faceSpot = new THREE.Vector3(g.min.x - 0.4, g.min.y + (g.max.y - g.min.y) * 0.55, (g.min.z + g.max.z) / 2);
  }

  // ---- sequence playback
  let queue: { name: string; frames: SeqFrame[]; loop: boolean }[] = [];
  let playing: { name: string; frames: SeqFrame[]; loop: boolean } | null = null;
  let frameIdx = 0, hold = 0;
  let face: string | null = null;
  const play = (name: string, loop = false, now = false) => {
    const frames = data.sequences[name];
    if (!frames) return;
    const item = { name, frames, loop };
    if (now) { queue = []; playing = item; frameIdx = 0; hold = 0; startFrame(); } else queue.push(item);
  };
  const startFrame = () => {
    if (!playing) return;
    const f = playing.frames[frameIdx];
    Object.assign(target, f.a);
    hold = f.ms / 1000 + 0.02 * 8; // the firmware waits 20 ms between servo writes
    if (f.face) face = f.face;
  };

  // ---- ground contact
  const worldInv = new THREE.Matrix4();
  const tmp = new THREE.Vector3();
  const corners = [0, 1, 2, 3, 4, 5, 6, 7];
  let pitch = 0, roll = 0, height = 0, vy = 0;

  const lowest = () => {
    // lowest points of every part, in the lift group's frame (rig axes, before tilt)
    lift.updateMatrixWorld(true);
    worldInv.copy(lift.matrixWorld).invert();
    const pts: THREE.Vector3[] = [];
    for (const part of parts) {
      const bb = part.geometry.boundingBox!;
      const m = new THREE.Matrix4().multiplyMatrices(worldInv, part.matrixWorld);
      let best: THREE.Vector3 | null = null;
      for (const k of corners) {
        tmp.set(k & 1 ? bb.max.x : bb.min.x, k & 2 ? bb.max.y : bb.min.y, k & 4 ? bb.max.z : bb.min.z).applyMatrix4(m);
        if (!best || tmp.y < best.y) best = tmp.clone();
      }
      pts.push(best!);
    }
    return pts;
  };

  return {
    root,
    size,
    faceAnchor,
    faceSpot,
    scale,
    get face() { return face; },
    get name() { return playing?.name ?? null; },
    get busy() { return !!playing || queue.length > 0; },
    play,
    stop() { queue = []; playing = null; },
    update(dt: number) {
      // advance the sequence
      if (!playing && queue.length) { playing = queue.shift()!; frameIdx = 0; startFrame(); }
      if (playing) {
        hold -= dt;
        if (hold <= 0) {
          frameIdx++;
          if (frameIdx >= playing.frames.length) {
            if (playing.loop && !queue.length) frameIdx = 0;
            else { playing = queue.shift() ?? null; frameIdx = 0; }
          }
          startFrame();
        }
      }
      // slew servos
      const step = SLEW * dt;
      for (const s of SERVOS) current[s] += THREE.MathUtils.clamp(target[s] - current[s], -step, step);
      pose();

      // ground contact: tilt so the lowest point at the front and back (and left and right) share a floor
      tilt.rotation.set(0, 0, 0);
      const pts = lowest();
      const half = size.x / 2;
      const low = (f: (p: THREE.Vector3) => boolean) => pts.filter(f).reduce((m, p) => Math.min(m, p.y), Infinity);
      const front = low((p) => p.x < -half * 0.15), back = low((p) => p.x > half * 0.15);
      const left = low((p) => p.z > size.z * 0.1), right = low((p) => p.z < -size.z * 0.1);
      const wantPitch = Number.isFinite(front + back) ? THREE.MathUtils.clamp(Math.atan2(front - back, size.x * 0.8), -0.5, 0.5) : 0;
      const wantRoll = Number.isFinite(left + right) ? THREE.MathUtils.clamp(Math.atan2(right - left, size.z * 0.8), -0.4, 0.4) : 0;
      const k = 1 - Math.exp(-dt * 7);
      pitch += (wantPitch - pitch) * k;
      roll += (wantRoll - roll) * k;
      tilt.rotation.set(roll, 0, pitch, 'XYZ');
      const after = lowest().reduce((m, p) => Math.min(m, p.y), Infinity);
      // gravity: fall onto the floor, never sink through it
      const floor = -after;
      vy -= size.y * 25 * dt;
      height += vy * dt;
      if (height < floor) { height = floor; vy = 0; }
      lift.position.y = height;
    },
  };
}
