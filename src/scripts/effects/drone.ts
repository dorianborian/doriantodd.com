// Sesame Drone: the robot from its Fusion rig (see drone-rig.ts) walks across the cell with a trot, folds its legs out
// against the end stops, spins up, flies a lap back to where it started, lands, unfolds and walks again.
// In the air it leans into its turns, wobbles a little (it flies right around a 1:1 thrust-to-weight ratio, so
// there is almost nothing left for corrections) and its hips still swing side to side, like the real one.

import * as THREE from '../three-lite';
import { loadFusionRig } from './fusion-rig';
import { buildDroneRig, CENTER, type DronePose } from './drone-rig';
import type { EffectContext, Effect } from './types';

const S = 7.5; // rig metres -> cell units
const START = -0.62; // walk from here (cell z) toward the front...
const END = 0.58; // ...take off here, fly a lap back to START
const ALT = 0.11; // hover height, CAD metres
const STRIDE = 0.2; // hip swing, radians each way
const STEP_T = 1.0; // one full trot cycle, seconds
const LIFT = 0.45; // knee lift during a step, radians

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

// timeline of one loop, seconds
const T = { walk: 3.6, stop: 0.5, fold: 1.0, spin: 0.9, rise: 1.1, fly: 4.6, land: 1.3, spinDown: 0.8, unfold: 1.0, rest: 0.6 };
const MARKS: Record<keyof typeof T, number> = {} as Record<keyof typeof T, number>;
let acc = 0;
for (const k of Object.keys(T) as (keyof typeof T)[]) { MARKS[k] = acc; acc += T[k]; }
const LOOP = acc;

function blobTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export default async function drone(ctx: EffectContext): Promise<Effect> {
  ctx.model.visible = false;
  const rig = await loadFusionRig(ctx, '/rigs/sesame-drone', 'y');
  const bot = await buildDroneRig(rig.scene);

  // holder: the robot's spot and heading in the cell. Inside it the rig faces +z with the hips' centre on the origin
  // (rotating CAD by +90 deg about Y sends (x, z) to (z, -x), so the face, CAD -x, looks down +z).
  const holder = new THREE.Group();
  ctx.body.add(holder);
  holder.add(rig.root);
  rig.root.scale.setScalar(S);
  rig.root.rotation.set(0, Math.PI / 2, 0);
  rig.root.position.set(-CENTER.z * S, 0, CENTER.x * S);
  ctx.pickable(rig.root);

  // soft contact shadow, so height reads when it flies
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }));
  shadow.position.y = 0.004;
  shadow.renderOrder = 1;
  ctx.body.add(shadow);

  const pose: DronePose = { fold: 0, hips: [0, 0, 0, 0], lift: [0, 0, 0, 0], rps: 0 };
  const pos = new THREE.Vector3(0, 0, START);
  const prev = new THREE.Vector3().copy(pos);
  const vel = new THREE.Vector3(), lastVel = new THREE.Vector3(), accel = new THREE.Vector3();
  let gait = 0; // trot phase
  let face = '';
  const setFace = (name: string) => { if (name !== face) { face = name; bot.face(name); } };

  /** Lap from END back to START: out to the right, round, and in, with a slow full turn in the middle. */
  const flyPath = (u: number, out: THREE.Vector3) => {
    const a = Math.PI * ease(u);
    const r = (END - START) / 2, mid = (END + START) / 2;
    return out.set(Math.sin(a) * 0.72, 0, mid + Math.cos(a) * r);
  };

  return {
    update(time, dt) {
      dt = Math.min(dt, 1 / 20);
      const t = time % LOOP;
      const k = (name: keyof typeof T) => clamp01((t - MARKS[name]) / T[name]);
      let alt = 0, yaw = 0;
      pose.lift.fill(0);
      pose.hips.fill(0);

      if (t < MARKS.stop) {
        // trot: diagonal pairs (FL+BR, FR+BL) take turns stepping forward while the other pair pushes back
        setFace('idle');
        pose.fold = 0;
        pose.rps = 0;
        gait = (t / STEP_T) % 1;
        // ease the stride in and out so the legs settle to neutral before the fold
        const env = ease(Math.min(t / 0.35, (MARKS.stop - t) / 0.35));
        for (let i = 0; i < 4; i++) {
          const ph = (gait + (i === 0 || i === 3 ? 0 : 0.5)) % 1;
          const swing = ph < 0.5;
          const u = swing ? ph / 0.5 : (ph - 0.5) / 0.5;
          pose.hips[i] = (swing ? -STRIDE + 2 * STRIDE * ease(u) : STRIDE - 2 * STRIDE * u) * env;
          pose.lift[i] = (swing ? LIFT * Math.sin(Math.PI * u) : 0) * env;
        }
        pos.set(0, 0, START + (END - START) * ease(k('walk') * 1.05 - 0.02));
      } else if (t < MARKS.fold) {
        setFace('excited');
        pos.set(0, 0, END);
      } else if (t < MARKS.rise) {
        // fold out to the stops, then spool up
        pose.fold = ease(k('fold'));
        pose.rps = 40 * k('spin') ** 2;
        pos.set(0, 0, END);
        if (pose.fold >= 1) setFace('happy');
      } else if (t < MARKS.spinDown) {
        pose.fold = 1;
        pose.rps = 40;
        setFace('happy');
        const up = ease(k('rise')), down = ease(k('land'));
        alt = ALT * (up - down);
        if (t < MARKS.fly) pos.set(0, 0, END);
        else if (t < MARKS.land) flyPath(k('fly'), pos);
        else pos.set(0, 0, START);
        // a slow full turn in the middle of the lap
        yaw = Math.PI * 2 * ease((k('fly') - 0.25) / 0.5);
        // the hips are not locked in drone mode: a little side to side swing, the props still push straight up
        const wig = Math.sin(time * 5.1) * 0.08 * (up - down);
        pose.hips[0] = pose.hips[3] = wig;
        pose.hips[1] = pose.hips[2] = -wig;
      } else {
        pos.set(0, 0, START);
        pose.rps = 40 * (1 - k('spinDown')) ** 2;
        pose.fold = 1 - ease(k('unfold'));
        setFace('idle');
      }

      // lean into the acceleration like a quad, plus the barely-there margin's wobble
      vel.copy(pos).sub(prev).divideScalar(Math.max(dt, 1e-3));
      accel.copy(vel).sub(lastVel).divideScalar(Math.max(dt, 1e-3));
      lastVel.copy(vel);
      prev.copy(pos);
      const air = THREE.MathUtils.smoothstep(alt, 0, 0.02);
      const wob = air * 0.05;
      const pitch = THREE.MathUtils.clamp(accel.z * 0.18, -0.35, 0.35) * air + Math.sin(time * 7.3) * wob;
      const roll = THREE.MathUtils.clamp(-accel.x * 0.18, -0.35, 0.35) * air + Math.sin(time * 6.1 + 1.3) * wob;

      bot.pose(pose, time, dt);
      // stand on the lowest point of the pose (feet while walking, belly once folded)
      const ground = bot.ground();
      holder.position.set(pos.x, (alt - ground) * S + air * Math.sin(time * 3.2) * 0.02, pos.z);
      holder.rotation.set(pitch, yaw, roll, 'YXZ');

      const spread = 1.5 + alt * 9;
      shadow.position.x = pos.x;
      shadow.position.z = pos.z;
      shadow.scale.setScalar(spread);
      (shadow.material as THREE.MeshBasicMaterial).opacity = 1 - air * 0.55;
    },
  };
}
