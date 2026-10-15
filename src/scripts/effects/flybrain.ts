// Fly Brain Bridge: a point cloud of real MaleCNS neuron positions lives inside a large glass Sesame.
// It cycles through the project's circuits: a stimulus group lights up, activity spreads through
// the brain, the command neurons fire, and Sesame plays the matching firmware sequence.
// Data comes from the project's own export (public/flybrain), sampled from the 166,700 neurons.

import * as THREE from '../three-lite';
import { damp, glowMaterial, wrapAngle } from './shared';
import { buildRig } from './sesame-rig';
import type { EffectContext, Effect } from './types';

type Group = { id: string; label: string; color: string; idx: number[] };
type Action = 'feed' | 'escape' | 'groom' | 'walk' | 'left' | 'dance' | 'back';
type Episode = { stim: Group; cmd: Group; action: Action };

// Neuron families, same order as the export: sensory, optic lobe, visual projection, central brain,
// descending, ascending, nerve cord, motor
const FAMILY = [0x2ec4b6, 0x3a5bff, 0x4cc9f0, 0x8b5cf6, 0xff9f1c, 0xffd166, 0x2a9d8f, 0xef476f];

// What Sesame does when each circuit's command neurons fire: the closest firmware sequence. Gaits loop
// for the rest of the episode and move the robot (speed in body lengths/s, turn in rad/s); the others play once.
const MOVES: Record<Action, { seq: string; gait?: { speed: number; turn: number } }> = {
  feed: { seq: 'bow' }, // MN9: bow down to the sugar
  escape: { seq: 'freaky' }, // Giant Fiber: startle
  groom: { seq: 'wave' }, // aDN1/aDN2: a front leg up to the antennae
  walk: { seq: 'walk_forward', gait: { speed: 0.22, turn: 0 } }, // P9/BDN2/oDN1
  left: { seq: 'turn_left', gait: { speed: 0, turn: 0.9 } }, // DNa01/02
  dance: { seq: 'dance' }, // pIP10/DNp13
  back: { seq: 'walk_backward', gait: { speed: -0.18, turn: 0 } }, // MDN, the moonwalker neurons
};

const VERT = /* glsl */ `
  attribute float aAct;
  attribute vec3 aColor;
  attribute vec3 aHot;
  uniform float uSize;
  varying vec3 vCol;
  varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (1.0 + aAct * 2.2) / -mv.z;
    vCol = mix(aColor * 0.55, aHot, clamp(aAct, 0.0, 1.0));
    vA = 0.3 + aAct * 1.4;
  }
`;
const FRAG = /* glsl */ `
  varying vec3 vCol;
  varying float vA;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = dot(p, p) * 4.0;
    if (d > 1.0) discard;
    float k = (1.0 - d);
    gl_FragColor = vec4(vCol * k * k * vA, 0.0);
  }
`;

export default async function flybrain(ctx: EffectContext): Promise<Effect> {
  const [buf, data] = await Promise.all([
    fetch('/flybrain/brain.bin').then((r) => r.arrayBuffer()),
    fetch('/flybrain/brain-groups.json').then((r) => r.json() as Promise<{ episodes: Episode[] }>),
  ]);
  const view = new DataView(buf);
  const n = view.getUint32(0, true);
  const q = new Int16Array(buf, 8, n * 3);
  const fam = new Uint8Array(buf, 8 + n * 6, n);

  // ---- Sesame: the posable rig, about the size of the red.HEX hexapod, in translucent blue glass so
  // it reads as the brain's body rather than the stock orange robot
  ctx.model.visible = false;
  const glass = new THREE.MeshStandardMaterial({ color: 0x4a9bff, emissive: 0x12305a, roughness: 0.3, metalness: 0.1, transparent: true, opacity: 0.25, depthWrite: false });
  const rig = await buildRig((url) => ctx.loadRaw(url, 'y', [0, 0, 0]), 1, { body: glass, frame: glass });
  const botLen = ctx.foot * 0.66;
  rig.root.scale.setScalar(botLen / Math.max(rig.size.x, rig.size.z));
  // the glass shell draws first, the brain after it (additive, no depth writes), so nothing flickers
  rig.root.traverse((o) => { o.renderOrder = 1; });
  ctx.body.add(rig.root);
  const home = new THREE.Vector2(0, -ctx.foot * 0.08);
  const lim = ctx.foot * 0.5 - botLen * 0.5;
  const bot = { pos: home.clone(), yaw: 0 };
  rig.play('stand', false, true);

  // ---- brain point cloud, normalised so its longest side is 1: x left/right, y dorsal up, z toward the
  // nerve cord
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const hot = new Float32Array(n * 3);
  const act = new Float32Array(n);
  const c = new THREE.Color();
  const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.set(q[i * 3], q[i * 3 + 1], q[i * 3 + 2]);
    lo.min(v);
    hi.max(v);
  }
  const mid = lo.clone().add(hi).multiplyScalar(0.5);
  const ext = hi.clone().sub(lo);
  const R = 1 / Math.max(ext.x, ext.y, ext.z);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (q[i * 3] - mid.x) * R;
    pos[i * 3 + 1] = (q[i * 3 + 1] - mid.y) * R;
    pos[i * 3 + 2] = (q[i * 3 + 2] - mid.z) * R;
    c.setHex(FAMILY[fam[i]] ?? 0xffffff);
    col.set([c.r, c.g, c.b], i * 3);
    hot.set([1, 1, 1], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  const hotAttr = new THREE.BufferAttribute(hot, 3);
  const actAttr = new THREE.BufferAttribute(act, 1);
  hotAttr.setUsage(THREE.DynamicDrawUsage);
  actAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aHot', hotAttr);
  geo.setAttribute('aAct', actAttr);
  const uniforms = { uSize: { value: 26 } };
  const cloud = new THREE.Points(geo, glowMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG }));
  cloud.frustumCulled = false;
  cloud.renderOrder = 2;

  // inside the body, in the rig's millimetre space (forward -x): the head end sits behind the face in the
  // top cover and the nerve cord runs back along the body. The cover is about 37 mm wide.
  const fit = 37 / (ext.x * R);
  const brain = new THREE.Group();
  brain.scale.setScalar(fit);
  brain.rotation.y = Math.PI / 2; // brain +z (nerve cord) to rig +x (back), brain x across the body
  brain.position.set(-7 + (ext.z * R * fit) / 2, 40, 2.4);
  brain.add(cloud);
  rig.mm.add(brain);

  // centroid of a group in brain space
  const centroid = (g: Group) => {
    const out = new THREE.Vector3();
    for (const i of g.idx) out.add(v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
    return out.multiplyScalar(1 / Math.max(1, g.idx.length));
  };
  // background neurons near the straight path from stimulus to command neurons, for the spreading wave
  const pathNeurons = (a: THREE.Vector3, b: THREE.Vector3) => {
    const ab = b.clone().sub(a);
    const len2 = Math.max(ab.lengthSq(), 1e-6);
    const out: { i: number; t: number }[] = [];
    const p = new THREE.Vector3();
    const rad = 0.133;
    for (let i = 0; i < n; i += 2) {
      p.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / len2, 0, 1);
      if (p.distanceTo(a.clone().addScaledVector(ab, t)) < rad * (0.6 + Math.sin(t * Math.PI) * 0.8)) out.push({ i, t });
    }
    return out;
  };
  const episodes = data.episodes.map((e) => {
    const a = centroid(e.stim), b = centroid(e.cmd);
    return { ...e, path: pathNeurons(a, b), stimCol: new THREE.Color(e.stim.color), cmdCol: new THREE.Color(e.cmd.color), b };
  });

  // the firing neurons light the glass and the floor around it
  const light = new THREE.PointLight(0x8b5cf6, 0, ctx.foot * 0.9, 1.6);
  brain.add(light);

  const EP = 6; // seconds per episode
  let current = -1;
  let acting = false;
  const setHot = (idx: number[], color: THREE.Color) => { for (const i of idx) hot.set([color.r, color.g, color.b], i * 3); };

  return {
    update(time, dt) {
      dt = Math.min(dt, 1 / 20);
      const k = Math.floor(time / EP);
      const e = episodes[((k % episodes.length) + episodes.length) % episodes.length];
      const t = time / EP - k; // 0..1 through the episode
      if (k !== current) {
        current = k;
        acting = false;
        hot.fill(1);
        for (const p of e.path) hot.set([0.75, 0.8, 1], p.i * 3);
        setHot(e.stim.idx, e.stimCol);
        setHot(e.cmd.idx, e.cmdCol);
        hotAttr.needsUpdate = true;
        light.position.copy(e.b);
      }

      // decay, then drive: stimulus (0-45%), spreading wave (15-60%), command neurons (40-85%)
      const decay = Math.exp(-dt * 5);
      for (let i = 0; i < n; i++) act[i] *= decay;
      const pulse = (a: number, b: number) => (t > a && t < b ? Math.sin(((t - a) / (b - a)) * Math.PI) : 0);
      const sAmp = pulse(0, 0.45);
      for (const i of e.stim.idx) if (Math.random() < 0.55 * sAmp) act[i] = Math.max(act[i], 0.9 + Math.random() * 0.4);
      if (t > 0.12 && t < 0.62) {
        const front = (t - 0.12) / 0.4;
        for (const p of e.path) if (Math.abs(p.t - front) < 0.09 && Math.random() < 0.35) act[p.i] = Math.max(act[p.i], 0.55 + Math.random() * 0.3);
      }
      const cAmp = pulse(0.4, 0.88);
      for (const i of e.cmd.idx) if (Math.random() < 0.7 * cAmp) act[i] = Math.max(act[i], 1.1 + Math.random() * 0.5);
      // faint background chatter so the brain never looks dead
      for (let j = 0; j < 60; j++) { const i = (Math.random() * n) | 0; act[i] = Math.max(act[i], 0.25 * Math.random()); }
      actAttr.needsUpdate = true;

      light.color.copy(cAmp > sAmp ? e.cmdCol : e.stimCol);
      light.intensity = 0.3 + Math.max(sAmp, cAmp) * 1.6;

      // ---- Sesame acts once the command neurons fire, then stands again
      const move = MOVES[e.action];
      if (!acting && t > 0.45) {
        acting = true;
        rig.play(move.seq, !!move.gait, true);
        if (!move.gait) rig.play('stand');
      }
      if (move.gait && t > 0.9 && rig.name === move.seq) rig.play('stand', false, true);
      const gait = move.gait && rig.name === move.seq ? move.gait : null;
      if (gait) {
        bot.yaw += gait.turn * dt;
        bot.pos.x += Math.sin(bot.yaw) * gait.speed * botLen * dt;
        bot.pos.y += Math.cos(bot.yaw) * gait.speed * botLen * dt;
      } else if (t < 0.45) {
        // drift back home between behaviours so it never wanders off the cell
        bot.pos.lerp(home, damp(0.8, dt));
        bot.yaw += wrapAngle(-bot.yaw) * damp(0.8, dt);
      }
      bot.pos.x = THREE.MathUtils.clamp(bot.pos.x, -lim, lim);
      bot.pos.y = THREE.MathUtils.clamp(bot.pos.y, -lim, lim);
      rig.update(dt);
      rig.root.position.set(bot.pos.x, 0, bot.pos.y);
      rig.root.rotation.y = bot.yaw;
    },
  };
}
