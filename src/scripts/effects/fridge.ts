// Autonomous Fridge Tank: pictogram people chase the fridge around its cell, and the fridge
// turns on its treads and drives away from whoever is closest.

import * as THREE from '../three-lite';
import { Crowd, type Person } from './people';
import { damp, rand, turnToward, wrapAngle } from './shared';
import type { EffectContext, Effect } from './types';

export default function fridge(ctx: EffectContext): Effect {
  const SCALE = 0.26;
  ctx.model.scale.setScalar(SCALE);
  const arena = ctx.foot * 0.5; // half size of the roaming square
  const tank = { pos: new THREE.Vector2(0, 0), yaw: 0, speed: 0 };
  const radius = ctx.foot * SCALE * 0.5;

  const crowd = new Crowd(ctx.body, 1);
  const chasers: { p: Person; target: THREE.Vector2; pause: number }[] = [];
  const spawn = (p?: Person) => {
    const a = rand(0, Math.PI * 2);
    const pos = new THREE.Vector3(Math.cos(a) * arena * 0.95, 0, Math.sin(a) * arena * 0.95);
    if (p) { p.pos.copy(pos); p.fade = 0; return p; }
    return crowd.add({ pos, height: ctx.foot * 0.13, pose: 'run' });
  };
  for (let i = 0; i < 1; i++) chasers.push({ p: spawn()!, target: new THREE.Vector2(), pause: rand(0, 1) });

  const flee = new THREE.Vector2();
  return {
    update(_t, dt) {
      dt = Math.min(dt, 1 / 20);

      // --- fridge: steer away from people and from the edges
      flee.set(0, 0);
      let threat = 0;
      for (const c of chasers) {
        const dx = tank.pos.x - c.p.pos.x, dz = tank.pos.y - c.p.pos.z;
        const d = Math.max(Math.hypot(dx, dz), 0.05);
        const w = 1 / (d * d);
        flee.x += (dx / d) * w;
        flee.y += (dz / d) * w;
        threat = Math.max(threat, 1.2 / d);
      }
      const edge = arena - radius;
      // walls push inward early; near a wall, slide along it instead of pinning against it
      const wall = (v: number) => -Math.sign(v) * Math.pow(Math.max(0, Math.abs(v) / edge - 0.45) / 0.55, 2) * 4;
      flee.x += wall(tank.pos.x);
      flee.y += wall(tank.pos.y);
      if (flee.lengthSq() < 1e-6) flee.set(Math.sin(tank.yaw), Math.cos(tank.yaw));
      const heading = Math.atan2(flee.x, flee.y);
      const off = Math.abs(wrapAngle(heading - tank.yaw));
      // tank steering: always keep rolling, slow down for sharp turns
      tank.yaw = turnToward(tank.yaw, heading, dt * 3.4);
      const wantSpeed = Math.min(0.9, 0.35 + threat * 0.4) * (off > 1.6 ? 0.45 : 1);
      tank.speed += (wantSpeed - tank.speed) * damp(4, dt);
      tank.pos.x = THREE.MathUtils.clamp(tank.pos.x + Math.sin(tank.yaw) * tank.speed * dt, -edge, edge);
      tank.pos.y = THREE.MathUtils.clamp(tank.pos.y + Math.cos(tank.yaw) * tank.speed * dt, -edge, edge);
      // the model faces its local +x (googly eyes); treads run along x
      const jig = tank.speed;
      ctx.model.position.set(tank.pos.x, Math.abs(Math.sin(_t * 23)) * ctx.foot * 0.006 * jig, tank.pos.y);
      ctx.model.rotation.set(Math.sin(_t * 17) * 0.03 * jig, tank.yaw - Math.PI / 2, Math.sin(_t * 29) * 0.035 * jig);

      // --- people: run at the fridge, catch their breath when they get close
      for (const c of chasers) {
        const p = c.p;
        p.fade = Math.min(1, p.fade + dt * 1.5);
        const dx = tank.pos.x - p.pos.x, dz = tank.pos.y - p.pos.z;
        const d = Math.hypot(dx, dz);
        if (c.pause > 0) {
          c.pause -= dt;
          p.pose = 'wave';
        } else if (d < radius + 0.15) {
          c.pause = rand(0.3, 0.6);
        } else {
          p.pose = 'run';
          const sp = 0.42;
          p.pos.x += (dx / d) * sp * dt;
          p.pos.z += (dz / d) * sp * dt;
        }
        p.yaw = turnToward(p.yaw, Math.atan2(dx, dz), dt * 8);
        // keep the chasers from stacking on top of each other
        for (const o of chasers) {
          if (o === c) continue;
          const ox = p.pos.x - o.p.pos.x, oz = p.pos.z - o.p.pos.z;
          const od = Math.hypot(ox, oz);
          if (od < 0.18 && od > 0) { p.pos.x += (ox / od) * (0.18 - od) * 0.5; p.pos.z += (oz / od) * (0.18 - od) * 0.5; }
        }
        p.pos.x = THREE.MathUtils.clamp(p.pos.x, -arena, arena);
        p.pos.z = THREE.MathUtils.clamp(p.pos.z, -arena, arena);
      }
      crowd.update(dt);
    },
  };
}
