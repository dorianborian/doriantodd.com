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

  // ---- goal lines: the field model has its own goals; a strip in the defending team's colour marks each mouth
  const mouth = halfZ * 0.35;
  const postH = ballR * 4.2;
  const teamHex = [0xe5484d, 0x3e8bff];
  for (const side of [1, -1] as const) {
    const defend = side > 0 ? 1 : 0; // team 1 defends +x
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(ballR * 0.5, mouth * 2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: teamHex[defend], transparent: true, opacity: 0.75, toneMapped: false, depthWrite: false }),
    );
    line.position.set(cx + side * halfX, surface + 0.004, cz);
    ctx.body.add(line);
  }

  // ---- ball shadow
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(ballR * 1.1, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
  ctx.body.add(shadow);

  // ---- scoreboard floating over the far sideline
  const board = document.createElement('canvas');
  board.width = 512; board.height = 160;
  const boardTex = new THREE.CanvasTexture(board);
  boardTex.colorSpace = THREE.SRGBColorSpace;
  const boardW = fsize.x * 0.42;
  const boardMesh = new THREE.Mesh(new THREE.PlaneGeometry(boardW, boardW * 160 / 512), new THREE.MeshBasicMaterial({ map: boardTex, transparent: true, toneMapped: false }));
  boardMesh.position.set(cx, surface + fsize.x * 0.22, cz - fsize.z / 2 - 0.35);
  ctx.body.add(boardMesh);
  const score = [0, 0];
  let clock = 0, banner = '', bannerT = 0, drawnKey = '';
  const drawBoard = () => {
    const key = `${score}|${Math.floor(clock)}|${banner}|${Math.floor(bannerT * 4) % 2}`;
    if (key === drawnKey) return;
    drawnKey = key;
    const g = board.getContext('2d')!;
    g.clearRect(0, 0, 512, 160);
    g.fillStyle = 'rgba(16,17,20,0.92)';
    g.beginPath(); g.roundRect(4, 4, 504, 152, 14); g.fill();
    g.strokeStyle = '#3b3e45'; g.lineWidth = 3; g.stroke();
    g.textAlign = 'center';
    g.font = '600 22px Consolas, monospace';
    g.fillStyle = '#9aa3b0';
    const mm = String(Math.floor(clock / 60)).padStart(2, '0'), ss = String(Math.floor(clock % 60)).padStart(2, '0');
    g.fillText(`${mm}:${ss}`, 256, 38);
    g.font = '700 70px Segoe UI, Arial, sans-serif';
    g.fillStyle = '#e5484d'; g.fillText(String(score[0]), 150, 112);
    g.fillStyle = '#3e8bff'; g.fillText(String(score[1]), 362, 112);
    g.fillStyle = '#e4e6ea'; g.fillText(':', 256, 108);
    g.font = '600 20px Segoe UI, Arial, sans-serif';
    g.fillStyle = '#e5484d'; g.fillText('RED', 150, 145);
    g.fillStyle = '#3e8bff'; g.fillText('BLUE', 362, 145);
    if (banner && Math.floor(bannerT * 4) % 2 === 0) {
      g.fillStyle = 'rgba(16,17,20,0.94)';
      g.fillRect(96, 52, 320, 70);
      g.font = '800 46px Segoe UI, Arial, sans-serif';
      g.fillStyle = '#ffd166';
      g.fillText(banner, 256, 104);
    }
    boardTex.needsUpdate = true;
  };

  // ---- confetti
  const CONF = 220;
  const cPos = new Float32Array(CONF * 3), cVel = new Float32Array(CONF * 3), cCol = new Float32Array(CONF * 3), cLife = new Float32Array(CONF);
  for (let i = 0; i < CONF; i++) cPos[i * 3 + 1] = -50;
  const cGeo = new THREE.BufferGeometry();
  const cPosAttr = new THREE.Float32BufferAttribute(cPos, 3); cPosAttr.setUsage(THREE.DynamicDrawUsage);
  const cColAttr = new THREE.Float32BufferAttribute(cCol, 3);
  cGeo.setAttribute('position', cPosAttr);
  cGeo.setAttribute('color', cColAttr);
  const confetti = new THREE.Points(cGeo, new THREE.PointsMaterial({ size: ballR * 0.55, vertexColors: true, toneMapped: false }));
  confetti.frustumCulled = false;
  ctx.body.add(confetti);
  let cCursor = 0;
  const confettiBurst = (x: number, z: number, team: number) => {
    const base = new THREE.Color(teamHex[team]);
    for (let k = 0; k < 90; k++) {
      const i = cCursor++ % CONF;
      cPos.set([cx + x, surface + postH, cz + z], i * 3);
      cVel.set([rand(-1, 1) * fsize.x * 0.12, rand(0.6, 1.4) * fsize.x * 0.18, rand(-1, 1) * fsize.x * 0.12], i * 3);
      const c = Math.random() < 0.3 ? new THREE.Color(0xffd166) : Math.random() < 0.5 ? new THREE.Color(0xffffff) : base;
      cCol.set([c.r, c.g, c.b], i * 3);
      cLife[i] = rand(1.4, 2.4);
    }
    cColAttr.needsUpdate = true;
  };

  // ---- referee: stuck ball, stalled robots, first to three
  let still = 0, stall = 0, cornered = 0, celebrate2 = { team: -1, t: 0 };
  const WIN = 3;
  const kickoff = (serveTo: number) => {
    bpos.set(0, 0);
    bvel.set(0, 0);
    for (const b of bots) { b.pos.copy(b.home); b.vel.set(0, 0); b.yaw = b.team ? -Math.PI / 2 : Math.PI / 2; }
    // a gentle roll toward the team that conceded
    bvel.set((serveTo === 0 ? -1 : 1) * maxSpeed * 0.6, rand(-0.4, 0.4) * maxSpeed);
  };
  const flash = (text: string, t = 1.8) => { banner = text; bannerT = t; };

  const place = () => {
    ball.position.set(cx + bpos.x, surface + ballR, cz + bpos.y);
    shadow.position.set(cx + bpos.x + ballR * 0.25, surface + 0.002, cz + bpos.y + ballR * 0.2);
    for (const bot of bots) {
      const bob = Math.abs(Math.sin(bot.phase * 2)) * botLength * 0.035;
      const hop = celebrate2.team === bot.team ? Math.abs(Math.sin(bot.phase * 1.5)) * botLength * 0.25 : 0;
      bot.obj.position.set(cx + bot.pos.x, surface + bob + hop, cz + bot.pos.y);
      bot.obj.rotation.set(0, bot.yaw, Math.sin(bot.phase * 2) * 0.05);
    }
  };
  place();

  return {
    update(_t, dt) {
      dt = Math.min(dt, 1 / 20);
      clock += dt;
      bannerT = Math.max(0, bannerT - dt);
      if (!bannerT) banner = '';
      if (replay > 0) {
        replay -= dt;
        if (replay <= 0) {
          const loser = celebrate2.team >= 0 ? 1 - celebrate2.team : Math.random() < 0.5 ? 0 : 1;
          if (score[0] >= WIN || score[1] >= WIN) { score[0] = score[1] = 0; clock = 0; }
          celebrate2.team = -1;
          kickoff(loser);
          flash('KICK OFF', 1.1);
        }
      } else {
        bpos.addScaledVector(bvel, dt);
        bvel.multiplyScalar(Math.pow(0.8, dt)); // light ball, rolls far
        if (Math.abs(bpos.y) > halfZ) { bpos.y = Math.sign(bpos.y) * halfZ; bvel.y *= -0.8; }
        if (Math.abs(bpos.x) > halfX) {
          if (Math.abs(bpos.y) < mouth) {
            // red attacks +x, blue attacks -x
            const scorer = bpos.x > 0 ? 0 : 1;
            score[scorer]++;
            celebrate(1);
            confettiBurst(Math.sign(bpos.x) * halfX, 0, scorer);
            celebrate2 = { team: scorer, t: 0 };
            const won = score[scorer] >= WIN;
            flash(won ? (scorer ? 'BLUE WINS' : 'RED WINS') : 'GOAL', won ? 3.4 : 2.2);
            replay = won ? 3.6 : 2.4;
            bpos.x = Math.sign(bpos.x) * (halfX + ballR * 1.5);
            bvel.set(0, 0);
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

      // referee: a ball that stops, gets wedged in a corner, or robots that stall out get a drop ball
      if (replay <= 0) {
        const ballSpeed = bvel.length();
        const near = bots.some((b) => b.pos.distanceTo(bpos) < botLength * 0.9 + ballR);
        still = ballSpeed < maxSpeed * 0.04 && !near ? still + dt : 0;
        const botsSlow = bots.every((b) => b.vel.length() < maxSpeed * 0.08);
        stall = botsSlow ? stall + dt : 0;
        cornered = Math.abs(bpos.x) > halfX * 0.88 && Math.abs(bpos.y) > halfZ * 0.8 ? cornered + dt : 0;
        if (still > 2.5 || stall > 3 || cornered > 3.5) {
          const toward = new THREE.Vector2(-bpos.x, -bpos.y).normalize();
          bpos.multiplyScalar(0.55);
          bvel.copy(toward.multiplyScalar(maxSpeed * 0.9)).add(new THREE.Vector2(rand(-0.3, 0.3), rand(-0.3, 0.3)).multiplyScalar(maxSpeed));
          for (const b of bots) b.vel.add(new THREE.Vector2(rand(-1, 1), rand(-1, 1)).multiplyScalar(maxSpeed * 0.6));
          still = stall = cornered = 0;
          flash('DROP BALL', 1.2);
        }
      }
      // scorer does a victory spin and hops, the other robot slumps
      if (celebrate2.team >= 0) {
        celebrate2.t += dt;
        for (const b of bots) {
          if (b.team === celebrate2.team) { b.yaw += dt * 9; b.phase += dt * 14; }
          else b.vel.multiplyScalar(0.9);
        }
      }
      // confetti falls and flutters
      for (let i = 0; i < CONF; i++) {
        if (cLife[i] <= 0) continue;
        cLife[i] -= dt;
        const j = i * 3;
        cVel[j + 1] -= fsize.x * 0.35 * dt;
        cVel[j] *= 0.985; cVel[j + 2] *= 0.985;
        cPos[j] += (cVel[j] + Math.sin(clock * 9 + i) * fsize.x * 0.02) * dt;
        cPos[j + 1] = Math.max(surface, cPos[j + 1] + cVel[j + 1] * dt);
        cPos[j + 2] += cVel[j + 2] * dt;
        if (cLife[i] <= 0) cPos[j + 1] = -50;
      }
      cPosAttr.needsUpdate = true;
      drawBoard();

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
