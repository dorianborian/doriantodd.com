// Live Robot Soccer: two recoloured mini Sesames play on the field model while a crowd of
// pictogram people watches from both sidelines, cheering goals and flinching at near misses.

import * as THREE from '../three-lite';
import { Crowd, type Person } from './people';
import { boundsInBody, damp, rand, recolor, turnToward } from './shared';
import type { EffectContext, Effect } from './types';

type Bot = { obj: THREE.Object3D; team: 0 | 1; pos: THREE.Vector2; vel: THREE.Vector2; yaw: number; phase: number; home: THREE.Vector2; cool?: number };

// Classic ball: black pentagon patches on white, from the vertices of an icosahedron
function soccerBallMaterial() {
  const t = (1 + Math.sqrt(5)) / 2;
  const centers = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map(([x, y, z]) => new THREE.Vector3(x, y, z).normalize());
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, flatShading: true });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uC = { value: centers };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vObj;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vObj = normalize(position);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vObj;
uniform vec3 uC[12];`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float m = 0.0; for (int i = 0; i < 12; i++) m = max(m, dot(normalize(vObj), uC[i]));
diffuseColor.rgb *= m > 0.93 ? 0.06 : 1.0;`);
  };
  return mat;
}

export default async function soccer(ctx: EffectContext): Promise<Effect> {
  // Leave room around the field for the audience
  ctx.model.scale.setScalar(0.86);
  ctx.model.updateMatrixWorld(true);

  const field = boundsInBody(ctx, [ctx.model]);
  const fsize = field.getSize(new THREE.Vector3());
  const cx = (field.min.x + field.max.x) / 2;
  const cz = (field.min.z + field.max.z) / 2;
  const halfX = fsize.x * 0.42;
  const halfZ = fsize.z * 0.36;

  // Playing surface height: cast down onto the middle of the field
  const down = new THREE.Raycaster(new THREE.Vector3(cx, field.max.y + 1, cz).applyMatrix4(ctx.body.matrixWorld), new THREE.Vector3(0, -1, 0));
  const hit = down.intersectObject(ctx.model, true)[0];
  const surface = hit ? hit.point.clone().applyMatrix4(new THREE.Matrix4().copy(ctx.body.matrixWorld).invert()).y : field.min.y + fsize.y * 0.3;

  const botLength = fsize.x * 0.1;
  const bots: Bot[] = [];
  if (ctx.assets.robot) {
    const r = ctx.assets.robot;
    const base = await ctx.loadRaw(r.url, r.up, r.rotation);
    const bb = new THREE.Box3().setFromObject(base, true);
    const bs = bb.getSize(new THREE.Vector3());
    const c = bb.getCenter(new THREE.Vector3());
    const s = botLength / Math.max(bs.x, bs.z);
    const starts = [[-0.5, 0], [0.5, 0]];
    const teamColors = [0xe5484d, 0x3e8bff];
    for (let k = 0; k < 2; k++) {
      const team = k as 0 | 1;
      const inner = base.clone(true);
      recolor(inner, teamColors[team]);
      inner.position.set(-c.x, -bb.min.y, -c.z);
      const holder = new THREE.Group();
      holder.add(inner);
      holder.scale.setScalar(s);
      const pivot = new THREE.Group();
      pivot.add(holder);
      ctx.body.add(pivot);
      const home = new THREE.Vector2(starts[k][0] * halfX, starts[k][1] * halfZ);
      bots.push({ obj: pivot, team, pos: home.clone(), vel: new THREE.Vector2(), yaw: team ? -Math.PI / 2 : Math.PI / 2, phase: k * 1.7, home });
    }
  }

  const ballR = botLength * 0.3;
  const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(ballR, 1), soccerBallMaterial());
  ctx.body.add(ball);
  const bpos = new THREE.Vector2();
  const bvel = new THREE.Vector2(0.25, 0.12).multiplyScalar(fsize.x * 0.12);
  const maxSpeed = fsize.x * 0.12;

  // ---- audience along both long sides
  const crowd = new Crowd(ctx.body, 22);
  const fans: { p: Person; side: 1 | -1; baseZ: number; excite: number; delay: number }[] = [];
  const perSide = 9;
  for (const side of [1, -1] as const) {
    for (let i = 0; i < perSide; i++) {
      const x = cx + (i / (perSide - 1) - 0.5) * fsize.x * 0.9 + rand(-0.04, 0.04);
      const z = cz + side * (fsize.z / 2 + 0.2 + rand(0, 0.12));
      const p = crowd.add({ pos: new THREE.Vector3(x, 0, z), yaw: side > 0 ? Math.PI : 0, height: botLength * 1.25 * rand(0.9, 1.1) });
      fans.push({ p, side, baseZ: z, excite: 0, delay: 0 });
    }
  }
  const celebrate = (strength: number) => {
    for (const f of fans) { f.excite = Math.max(f.excite, strength); f.delay = rand(0, 0.35); }
  };

  const tmp = new THREE.Vector2();
  let replay = 0;

  const place = () => {
    ball.position.set(cx + bpos.x, surface + ballR, cz + bpos.y);
    for (const bot of bots) {
      const bob = Math.abs(Math.sin(bot.phase * 2)) * botLength * 0.035;
      bot.obj.position.set(cx + bot.pos.x, surface + bob, cz + bot.pos.y);
      bot.obj.rotation.set(0, bot.yaw, Math.sin(bot.phase * 2) * 0.05);
    }
  };
  place();

  return {
    update(_t, dt) {
      dt = Math.min(dt, 1 / 20);
      if (replay > 0) {
        replay -= dt;
        if (replay <= 0) { bpos.set(0, 0); bvel.set(rand(-1, 1) * maxSpeed, rand(-1, 1) * maxSpeed * 0.5); for (const b of bots) b.pos.copy(b.home); }
      } else {
        bpos.addScaledVector(bvel, dt);
        bvel.multiplyScalar(Math.pow(0.8, dt)); // light ball, rolls far
        if (Math.abs(bpos.y) > halfZ) { bpos.y = Math.sign(bpos.y) * halfZ; bvel.y *= -0.8; }
        if (Math.abs(bpos.x) > halfX) {
          if (Math.abs(bpos.y) < halfZ * 0.35) {
            celebrate(1); // goal
            replay = 1.6;
          } else {
            bpos.x = Math.sign(bpos.x) * halfX;
            bvel.x *= -0.8;
            celebrate(0.4); // off the post
          }
        }
      }
      ball.rotation.z -= (bvel.x * dt) / ballR;
      ball.rotation.x += (bvel.y * dt) / ballR;

      for (const bot of bots) {
        const goalX = bot.team === 0 ? halfX : -halfX;
        const mates = bots.filter((o) => o.team === bot.team);
        const chaser = mates.reduce((best, o) => (o.pos.distanceTo(bpos) < best.pos.distanceTo(bpos) ? o : best));
        // line up behind the ball; if the other team is already on it, come in from the side
        const rival = bots.find((o) => o.team !== bot.team && o.pos.distanceTo(bpos) < botLength * 1.2);
        const side = rival ? (bot.pos.y > bpos.y ? 1 : -1) * botLength * 0.9 : 0;
        const want = bot === chaser
          ? tmp.set(bpos.x - Math.sign(goalX) * (ballR + botLength * 0.4), bpos.y + side).clone()
          : new THREE.Vector2((bpos.x - goalX) * 0.45, bot.home.y * 0.7 + bpos.y * 0.3);
        const steer = want.sub(bot.pos);
        const desired = steer.setLength(Math.min(maxSpeed, steer.length() * 2.2));
        bot.vel.lerp(desired, damp(4, dt));
        bot.pos.addScaledVector(bot.vel, dt);
        bot.pos.x = THREE.MathUtils.clamp(bot.pos.x, -halfX, halfX);
        bot.pos.y = THREE.MathUtils.clamp(bot.pos.y, -halfZ, halfZ);
        const speed = bot.vel.length();
        if (speed > maxSpeed * 0.05) bot.yaw = turnToward(bot.yaw, Math.atan2(bot.vel.x, bot.vel.y), dt * 6);
        bot.phase += dt * (3 + (speed / maxSpeed) * 9);
        bot.cool = Math.max(0, (bot.cool ?? 0) - dt);
        const reach = botLength * 0.42 + ballR;
        const d = bot.pos.distanceTo(bpos);
        if (replay <= 0 && d < reach) {
          // body contact: the light ball is pushed out of the robot, never pinned
          const away = tmp.copy(bpos).sub(bot.pos);
          if (away.lengthSq() < 1e-8) away.set(rand(-1, 1), rand(-1, 1));
          away.normalize();
          bpos.copy(bot.pos).addScaledVector(away, reach);
          if (bvel.dot(away) < maxSpeed * 0.6) bvel.addScaledVector(away, maxSpeed * 0.8);
          if (bot.cool <= 0) {
            const aim = new THREE.Vector2(goalX - bpos.x, rand(-0.6, 0.6) * halfZ).normalize();
            bvel.copy(aim.multiplyScalar(maxSpeed * rand(2.2, 3.2)));
            bot.cool = 0.6;
          }
        }
      }
      // robots bump off each other instead of shoving head to head
      if (bots.length === 2) {
        const [a, b] = bots;
        const gap = tmp.copy(b.pos).sub(a.pos);
        const dist = gap.length();
        const min = botLength * 0.95;
        if (dist < min) {
          if (dist < 1e-6) gap.set(0, 1); else gap.divideScalar(dist);
          const push = (min - dist) / 2;
          a.pos.addScaledVector(gap, -push);
          b.pos.addScaledVector(gap, push);
          a.vel.addScaledVector(gap, -maxSpeed * 0.5);
          b.vel.addScaledVector(gap, maxSpeed * 0.5);
        }
      }

      // fans: cheer after goals, lean in when the ball comes to their side
      for (const f of fans) {
        if (f.delay > 0) { f.delay -= dt; continue; }
        f.excite = Math.max(0, f.excite - dt * 0.45);
        const near = Math.sign(bpos.y) === f.side && Math.abs(bpos.y) > halfZ * 0.6;
        f.p.pose = f.excite > 0.5 ? 'cheer' : f.excite > 0.15 || near ? 'wave' : 'idle';
        f.p.hop = f.p.pose === 'cheer' ? Math.max(0, Math.sin(f.p.phase * 0.5)) * 0.25 : 0;
        const ballX = cx + bpos.x;
        f.p.yaw = turnToward(f.p.yaw, Math.atan2(ballX - f.p.pos.x, cz - f.baseZ), dt * 3);
      }
      crowd.update(dt);
      place();
    },
  };
}
