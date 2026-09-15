// Fly Brain Bridge: a point cloud of real MaleCNS neuron positions floats over a small Sesame.
// It cycles through the project's circuits: a stimulus group lights up, activity spreads through
// the brain, the command neurons fire, and Sesame does the matching behavior.
// Data comes from the project's own export (public/flybrain), sampled from the 166,700 neurons.

import * as THREE from '../three-lite';
import { damp, glowMaterial } from './shared';
import type { EffectContext, Effect } from './types';

type Group = { id: string; label: string; color: string; idx: number[] };
type Episode = { stim: Group; cmd: Group; action: 'feed' | 'escape' | 'groom' | 'walk' | 'left' | 'dance' | 'back' };

// Neuron families, same order as the export: sensory, optic lobe, visual projection, central brain,
// descending, ascending, nerve cord, motor
const FAMILY = [0x2ec4b6, 0x3a5bff, 0x4cc9f0, 0x8b5cf6, 0xff9f1c, 0xffd166, 0x2a9d8f, 0xef476f];

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
    vA = 0.22 + aAct * 1.6;
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

  // ---- Sesame, small, standing in front of the brain
  const SCALE = 0.2;
  ctx.model.scale.setScalar(SCALE);
  // translucent blue, so it reads as the brain's body rather than the stock orange robot
  const ghost = new THREE.MeshStandardMaterial({ color: 0x4a9bff, emissive: 0x12305a, roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.6, depthWrite: false });
  ctx.model.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = ghost; });
  const home = new THREE.Vector2(0, ctx.foot * 0.3);
  const bot = { pos: home.clone(), yaw: 0, phase: 0, hop: 0, pitch: 0, roll: 0 };

  // ---- brain point cloud: the fly's head faces the viewer, the nerve cord trails away behind it
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const hot = new Float32Array(n * 3);
  const act = new Float32Array(n);
  const c = new THREE.Color();
  const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < n; i++) {
    // export space: x left/right, y dorsal up, z toward the nerve cord
    const v = new THREE.Vector3(q[i * 3], q[i * 3 + 1], -q[i * 3 + 2]);
    lo.min(v);
    hi.max(v);
  }
  const mid = lo.clone().add(hi).multiplyScalar(0.5);
  const R = (ctx.foot * 0.9) / Math.max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (q[i * 3] - mid.x) * R;
    pos[i * 3 + 1] = (q[i * 3 + 1] - mid.y) * R;
    pos[i * 3 + 2] = (-q[i * 3 + 2] - mid.z) * R;
    c.setHex(FAMILY[fam[i]] ?? 0xffffff);
    col.set([c.r, c.g, c.b], i * 3);
    hot.set([1, 1, 1], i * 3);
  }
  const center = new THREE.Vector3(0, ctx.foot * 0.5, -ctx.foot * 0.15);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  const hotAttr = new THREE.BufferAttribute(hot, 3);
  const actAttr = new THREE.BufferAttribute(act, 1);
  hotAttr.setUsage(THREE.DynamicDrawUsage);
  actAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aHot', hotAttr);
  geo.setAttribute('aAct', actAttr);
  const uniforms = { uSize: { value: 30 } };
  const cloud = new THREE.Points(geo, glowMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG }));
  cloud.frustumCulled = false;
  const brain = new THREE.Group();
  brain.position.copy(center);
  brain.rotation.x = -0.3; // tilt so the nerve cord trails down and back
  brain.add(cloud);
  ctx.body.add(brain);

  // centroid of a group in brain space
  const centroid = (g: Group) => {
    const v = new THREE.Vector3();
    for (const i of g.idx) v.add(new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
    return v.multiplyScalar(1 / Math.max(1, g.idx.length));
  };
  // background neurons near the straight path from stimulus to command neurons, for the spreading wave
  const pathNeurons = (a: THREE.Vector3, b: THREE.Vector3) => {
    const ab = b.clone().sub(a);
    const len2 = Math.max(ab.lengthSq(), 1e-6);
    const out: { i: number; t: number }[] = [];
    const p = new THREE.Vector3();
    const rad = ctx.foot * 0.12;
    for (let i = 0; i < n; i += 2) {
      p.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / len2, 0, 1);
      if (p.distanceTo(a.clone().addScaledVector(ab, t)) < rad * (0.6 + Math.sin(t * Math.PI) * 0.8)) out.push({ i, t });
    }
    return out;
  };
  const episodes = data.episodes.map((e) => {
    const a = centroid(e.stim), b = centroid(e.cmd);
    return { ...e, a, b, path: pathNeurons(a, b), stimCol: new THREE.Color(e.stim.color), cmdCol: new THREE.Color(e.cmd.color) };
  });

  // ---- a glowing line from the command neurons down to Sesame while it acts
  const linkGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const linkMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
  const link = new THREE.Line(linkGeo, linkMat);
  link.frustumCulled = false;
  ctx.body.add(link);

  const light = new THREE.PointLight(0x8b5cf6, 0, ctx.foot * 1.4, 1.6);
  light.position.copy(center);
  ctx.body.add(light);

  const EP = 4.2; // seconds per episode
  let current = -1;
  const setHot = (idx: number[], color: THREE.Color) => { for (const i of idx) hot.set([color.r, color.g, color.b], i * 3); };
  const tmp = new THREE.Vector3();

  return {
    update(time, dt) {
      dt = Math.min(dt, 1 / 20);
      const k = Math.floor(time / EP);
      const e = episodes[((k % episodes.length) + episodes.length) % episodes.length];
      const t = time / EP - k; // 0..1 through the episode
      if (k !== current) {
        current = k;
        hot.fill(1);
        for (const p of e.path) hot.set([0.75, 0.8, 1], p.i * 3);
        setHot(e.stim.idx, e.stimCol);
        setHot(e.cmd.idx, e.cmdCol);
        hotAttr.needsUpdate = true;
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
      light.intensity = 0.4 + Math.max(sAmp, cAmp) * 2.2;
      brain.rotation.y = Math.sin(time * 0.25) * 0.35;

      // ---- Sesame acts while the command neurons fire
      const acting = t > 0.45 && t < 0.95;
      const s = acting ? Math.sin(((t - 0.45) / 0.5) * Math.PI) : 0;
      let speed = 0, turn = 0;
      let pitch = 0, roll = 0, hop = 0;
      switch (e.action) {
        case 'feed': pitch = 0.35 * s; break; // bow toward the "food"
        case 'escape': hop = acting ? Math.max(0, Math.sin((t - 0.45) * 40)) * 0.05 * s : 0; pitch = -0.2 * s; break;
        case 'groom': roll = Math.sin(time * 18) * 0.12 * s; break;
        case 'walk': speed = 0.16 * s; break;
        case 'left': turn = 2.2 * s; speed = 0.05 * s; break;
        case 'dance': turn = 5 * s; hop = Math.abs(Math.sin(time * 14)) * 0.03 * s; break;
        case 'back': speed = -0.12 * s; break;
      }
      bot.yaw += turn * dt;
      // drift back home between behaviors so it never wanders off the cell
      if (!acting) {
        bot.pos.lerp(home, damp(1.5, dt));
        bot.yaw += Math.atan2(Math.sin(-bot.yaw), Math.cos(-bot.yaw)) * damp(1.8, dt);
      }
      bot.pos.x += Math.sin(bot.yaw) * speed * dt;
      bot.pos.y += Math.cos(bot.yaw) * speed * dt;
      bot.phase += dt * (3 + Math.abs(speed) * 60 + Math.abs(turn) * 4);
      bot.pitch += (pitch - bot.pitch) * damp(8, dt);
      bot.roll += (roll - bot.roll) * damp(10, dt);
      const wobble = Math.sin(bot.phase) * (0.02 + Math.abs(speed) * 0.25);
      ctx.model.position.set(bot.pos.x, hop * ctx.foot + Math.abs(Math.sin(bot.phase)) * 0.006, bot.pos.y);
      ctx.model.rotation.set(bot.pitch, bot.yaw, wobble + bot.roll, 'YXZ');

      // link from the firing command neurons to Sesame
      linkMat.opacity = cAmp * 0.8;
      linkMat.color.copy(e.cmdCol);
      brain.updateMatrixWorld();
      tmp.copy(e.b).applyMatrix4(brain.matrix);
      const pts = linkGeo.attributes.position as THREE.BufferAttribute;
      pts.setXYZ(0, tmp.x, tmp.y, tmp.z);
      pts.setXYZ(1, bot.pos.x, ctx.foot * 0.12, bot.pos.y);
      pts.needsUpdate = true;
    },
  };
}
