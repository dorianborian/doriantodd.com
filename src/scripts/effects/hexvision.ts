// HEX-VISION: the red.HEX hexapod waddles around its cell sweeping a sensor frustum. People it
// detects get a bounding box, panic, run off and fade away; new ones wander in later.

import * as THREE from '../three-lite';
import { Crowd, type Person } from './people';
import { boundsInBody, glowMaterial, rand, turnToward, wrapAngle } from './shared';
import type { EffectContext, Effect } from './types';

const SCAN_VERT = /* glsl */ `
  attribute float aDist;
  attribute float aSide;
  varying float vDist;
  varying float vSide;
  void main() { vDist = aDist; vSide = aSide; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const SCAN_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  varying float vDist;
  varying float vSide;
  void main() {
    float s = fract(uTime * 0.5);
    float band = exp(-pow((vDist - s) * 14.0, 2.0));
    float sweep = exp(-pow((vSide - sin(uTime * 1.9)) * 2.6, 2.0)) * 0.3;
    float body = (1.0 - vDist) * 0.09 + 0.02;
    float rings = step(0.93, fract(vDist * 8.0 - uTime * 0.9)) * 0.07;
    float a = (body + band * 0.8 + sweep * (1.0 - vDist) + rings) * smoothstep(0.0, 0.1, vDist);
    gl_FragColor = vec4(uColor * a, 0.0);
  }
`;

export default function hexvision(ctx: EffectContext): Effect {
  // Measure the robot before shrinking it, in the holder's own (unscaled) space
  const b = boundsInBody(ctx, [ctx.model]);
  const size = b.getSize(new THREE.Vector3());
  const SCALE = 0.32;
  ctx.model.scale.setScalar(SCALE);

  // Frustum on the robot's sensor side (-z), built in holder space so it moves with the robot
  const apex = new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y + size.y * 0.5, (b.min.z + b.max.z) / 2 - size.z * 0.24);
  const L = size.z * 0.9;
  const halfAngle = THREE.MathUtils.degToRad(28);
  const halfW = Math.tan(halfAngle) * L;
  const halfH = Math.tan(THREE.MathUtils.degToRad(13)) * L;
  const tilt = new THREE.Matrix4().makeRotationX(-THREE.MathUtils.degToRad(12));
  const far = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => new THREE.Vector3(sx * halfW, sy * halfH, -L).applyMatrix4(tilt).add(apex));

  const pos: number[] = [], dist: number[] = [], side: number[] = [];
  const sides = [-1, 1, 1, -1];
  for (let k = 0; k < 4; k++) {
    const c1 = far[k], c2 = far[(k + 1) % 4];
    pos.push(apex.x, apex.y, apex.z, c1.x, c1.y, c1.z, c2.x, c2.y, c2.z);
    dist.push(0, 1, 1);
    side.push(0, sides[k], sides[(k + 1) % 4]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aDist', new THREE.Float32BufferAttribute(dist, 1));
  geo.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  const uniforms = { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x38e1ff) } };
  const cone = new THREE.Mesh(geo, glowMaterial({ uniforms, vertexShader: SCAN_VERT, fragmentShader: SCAN_FRAG, side: THREE.DoubleSide }));
  cone.renderOrder = 6;
  const edgePts: THREE.Vector3[] = [];
  for (let k = 0; k < 4; k++) edgePts.push(apex, far[k], far[k], far[(k + 1) % 4]);
  const edges = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(edgePts), new THREE.LineBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.6, depthWrite: false }));
  const lens = new THREE.Mesh(new THREE.SphereGeometry(size.x * 0.018, 16, 12), new THREE.MeshBasicMaterial({ color: 0xaaf4ff, toneMapped: false }));
  lens.position.copy(apex);
  ctx.model.add(cone, edges, lens);

  // Scan reach in body units, for detection
  const reach = L * SCALE * Math.cos(THREE.MathUtils.degToRad(12));
  const arena = ctx.foot * 0.5;

  // People and their detection boxes
  const crowd = new Crowd(ctx.body, 4);
  const boxGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  type Target = { p: Person; box: THREE.LineSegments; state: 'wander' | 'spotted' | 'gone'; timer: number; heading: number };
  const targets: Target[] = [];
  for (let i = 0; i < 3; i++) {
    const box = new THREE.LineSegments(boxGeo, new THREE.LineBasicMaterial({ color: 0xff4d4d, transparent: true, opacity: 0, depthWrite: false }));
    ctx.body.add(box);
    const p = crowd.add({ height: ctx.foot * 0.11, pose: 'walk' });
    const t: Target = { p, box, state: 'gone', timer: rand(0, 1.5), heading: 0 };
    targets.push(t);
  }
  const respawn = (t: Target) => {
    const a = rand(0, Math.PI * 2);
    t.p.pos.set(Math.cos(a) * arena * 0.85, 0, Math.sin(a) * arena * 0.85);
    t.heading = a + Math.PI + rand(-0.6, 0.6);
    t.p.fade = 0;
    t.p.alive = true;
    t.p.pose = 'walk';
    t.state = 'wander';
  };

  const robot = { pos: new THREE.Vector2(), yaw: 0, phase: 0 };
  return {
    update(time, dt) {
      dt = Math.min(dt, 1 / 20);
      uniforms.uTime.value = time;

      // --- robot: head toward the nearest wandering person, or patrol
      const live = targets.filter((t) => t.state === 'wander');
      let wantYaw = robot.yaw + Math.sin(time * 0.4) * 0.6;
      if (live.length) {
        const near = live.reduce((a, c) => (Math.hypot(c.p.pos.x - robot.pos.x, c.p.pos.z - robot.pos.y) < Math.hypot(a.p.pos.x - robot.pos.x, a.p.pos.z - robot.pos.y) ? c : a));
        // the sensor looks along -z, so the robot's yaw points away from the target
        wantYaw = Math.atan2(near.p.pos.x - robot.pos.x, near.p.pos.z - robot.pos.y) + Math.PI;
      }
      const edge = arena - size.x * SCALE * 0.45;
      if (Math.abs(robot.pos.x) > edge * 0.7 || Math.abs(robot.pos.y) > edge * 0.7) wantYaw = Math.atan2(-robot.pos.x, -robot.pos.y) + Math.PI;
      robot.yaw = turnToward(robot.yaw, wantYaw, dt * 1.2);
      const speed = 0.16;
      robot.pos.x = THREE.MathUtils.clamp(robot.pos.x - Math.sin(robot.yaw) * speed * dt, -edge, edge);
      robot.pos.y = THREE.MathUtils.clamp(robot.pos.y - Math.cos(robot.yaw) * speed * dt, -edge, edge);
      robot.phase += dt * 7;
      // tripod-gait waddle: bob, roll and a little yaw wiggle
      ctx.model.position.set(robot.pos.x, Math.abs(Math.sin(robot.phase)) * 0.025, robot.pos.y);
      ctx.model.rotation.set(0, robot.yaw + Math.sin(robot.phase) * 0.06, Math.sin(robot.phase) * 0.035);

      // --- people
      const fwd = new THREE.Vector2(-Math.sin(robot.yaw), -Math.cos(robot.yaw));
      for (const t of targets) {
        const p = t.p;
        if (t.state === 'gone') {
          p.alive = false;
          t.timer -= dt;
          (t.box.material as THREE.LineBasicMaterial).opacity = 0;
          if (t.timer <= 0) respawn(t);
          continue;
        }
        const dx = p.pos.x - robot.pos.x, dz = p.pos.z - robot.pos.y;
        const d = Math.hypot(dx, dz);
        if (t.state === 'wander') {
          p.fade = Math.min(1, p.fade + dt * 1.2);
          t.heading += rand(-1, 1) * dt;
          if (Math.abs(p.pos.x) > arena * 0.9 || Math.abs(p.pos.z) > arena * 0.9) t.heading = Math.atan2(-p.pos.x, -p.pos.z);
          p.pos.x += Math.sin(t.heading) * 0.18 * dt;
          p.pos.z += Math.cos(t.heading) * 0.18 * dt;
          p.yaw = turnToward(p.yaw, t.heading, dt * 5);
          const angle = Math.abs(wrapAngle(Math.atan2(dx, dz) - Math.atan2(fwd.x, fwd.y)));
          if (d < reach && angle < halfAngle && p.fade > 0.6) {
            t.state = 'spotted';
            t.timer = 1.6;
            p.pose = 'panic';
          }
        } else {
          // spotted: run directly away and fade out
          t.timer -= dt;
          const away = Math.atan2(dx, dz);
          p.yaw = turnToward(p.yaw, away, dt * 10);
          p.pos.x += Math.sin(p.yaw) * 0.6 * dt;
          p.pos.z += Math.cos(p.yaw) * 0.6 * dt;
          p.pos.x = THREE.MathUtils.clamp(p.pos.x, -arena, arena);
          p.pos.z = THREE.MathUtils.clamp(p.pos.z, -arena, arena);
          if (t.timer < 0.9) p.fade = Math.max(0, t.timer / 0.9);
          if (t.timer <= 0) { t.state = 'gone'; t.timer = rand(1.2, 3); }
        }
        // detection box follows the person
        const h = p.height;
        t.box.position.set(p.pos.x, h * 0.55 + (p.hop || 0), p.pos.z);
        t.box.scale.set(h * 0.7, h * 1.15, h * 0.7);
        t.box.rotation.y = p.yaw;
        const mat = t.box.material as THREE.LineBasicMaterial;
        mat.opacity = t.state === 'spotted' ? Math.min(1, p.fade * 1.4) * (0.7 + 0.3 * Math.sin(time * 30)) : 0;
      }
      crowd.update(dt);
    },
  };
}
