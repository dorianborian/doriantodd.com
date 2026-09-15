// Sesame playpen: the posable Sesame (real printed parts on Sesame Studio's joint rig) walks with the
// firmware gait, shoves toys around inside glowing digital walls, and performs the firmware's emotes.
// Its OLED face uses the real 128x64 face bitmaps and follows each sequence's face.

import * as THREE from '../three-lite';
import { makeBody, shove, step, type Body, type World } from './physics';
import { boundsInBody, glowMaterial, rand } from './shared';
import { buildRig } from './sesame-rig';
import type { EffectContext, Effect } from './types';

type Atlas = { cols: number; rows: number; frames: Record<string, number> };

// The firmware's idle face blinks now and then
const IDLE = { frames: ['idle', 'idle', 'idle', 'idle_blink', 'idle_blink_1', 'idle_blink_2', 'idle_blink_3', 'idle'], fps: 7 };
// Faces that animate through a few frames in the firmware
const ANIMATED: Record<string, string[]> = {
  dance: ['dance', 'dance_1'], point: ['point', 'point_1', 'point_2'], dead: ['dead', 'dead_1', 'dead_2'], rest: ['rest', 'rest_1', 'rest_2'],
};

const WALL_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    vec2 g = abs(fract(vUv * vec2(18.0, 3.0)) - 0.5);
    float grid = smoothstep(0.46, 0.5, max(g.x, g.y)) * 0.35;
    float top = smoothstep(0.88, 1.0, vUv.y);
    float scan = exp(-pow((vUv.y - fract(uTime * 0.35)) * 12.0, 2.0)) * 0.25;
    float fill = 0.05 + (1.0 - vUv.y) * 0.05;
    vec3 col = vec3(0.22, 0.88, 1.0);
    gl_FragColor = vec4(col * (fill + grid + top * 0.9 + scan), 0.0);
  }
`;
const VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const EMOTES = ['wave', 'dance', 'bow', 'cute', 'freaky', 'shake', 'shrug', 'pushup', 'swim', 'worm', 'crab', 'point'];

export default async function sesame(ctx: EffectContext): Promise<Effect> {
  const full = boundsInBody(ctx, [ctx.model]);
  const size = full.getSize(new THREE.Vector3());
  // the static model is swapped for the posable rig, sized to match it
  ctx.model.visible = false;
  const botLen = Math.max(size.x, size.z) * 0.15;
  const rig = await buildRig((url) => ctx.loadRaw(url, 'y', [0, 0, 0]), 1, { body: 0xf0782a, leg: 0x3a3f4a, foot: 0x9aa3b5 });
  rig.root.scale.setScalar(botLen / Math.max(rig.size.x, rig.size.z));
  ctx.body.add(rig.root);
  const botRadius = botLen * 0.45;

  // face on the OLED, in the rig's millimetre space (the robot looks along -x there)
  const atlas: Atlas = await fetch('/sesame/faces.json').then((r) => r.json());
  const tex = await new THREE.TextureLoader().loadAsync('/sesame/faces.png');
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.repeat.set(1 / atlas.cols, 1 / atlas.rows);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(26, 13), new THREE.MeshBasicMaterial({ map: tex, color: 0xcdefff, toneMapped: false }));
  face.rotation.y = -Math.PI / 2;
  face.position.copy(rig.faceSpot);
  rig.faceAnchor.add(face);
  const showFrame = (name: string) => {
    const i = atlas.frames[name] ?? atlas.frames.idle;
    tex.offset.set((i % atlas.cols) / atlas.cols, 1 - (Math.floor(i / atlas.cols) + 1) / atlas.rows);
  };

  // digital walls
  const half = ctx.foot * 0.36;
  const wallH = 0.2;
  const uniforms = { uTime: { value: 0 } };
  const wallMat = glowMaterial({ uniforms, vertexShader: VERT, fragmentShader: WALL_FRAG, side: THREE.DoubleSide });
  for (const [x, z, ry] of [[0, -half, 0], [0, half, 0], [-half, 0, Math.PI / 2], [half, 0, Math.PI / 2]] as const) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, wallH), wallMat);
    wall.position.set(x, wallH / 2, z);
    wall.rotation.y = ry;
    wall.renderOrder = 3;
    ctx.body.add(wall);
  }
  const posts = new THREE.MeshBasicMaterial({ color: 0x6fe6ff, toneMapped: false });
  for (const [x, z] of [[-half, -half], [half, -half], [-half, half], [half, half]]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.03, wallH + 0.02, 0.03), posts);
    post.position.set(x, (wallH + 0.02) / 2, z);
    ctx.body.add(post);
  }

  // toys
  const toyMat = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45 });
  const world: World = { gravity: 9.8, floor: 0, bounds: { cx: 0, cz: 0, hx: half, hz: half }, bodies: [] };
  const addToy = (mesh: THREE.Mesh, shape: 'box' | 'sphere', halfExt: THREE.Vector3, x: number, z: number) => {
    mesh.position.set(x, halfExt.y, z);
    ctx.body.add(mesh);
    const b = makeBody(mesh, shape, halfExt, { restitution: shape === 'sphere' ? 0.7 : 0.3, friction: shape === 'sphere' ? 0.18 : 0.7, mass: shape === 'sphere' ? 0.6 : 1 });
    world.bodies.push(b);
    return b;
  };
  addToy(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), toyMat(0xff5a5f)), 'box', new THREE.Vector3(0.04, 0.04, 0.04), 0.5, 0.4);
  addToy(new THREE.Mesh(new THREE.SphereGeometry(0.05, 24, 16), toyMat(0xffd23f)), 'sphere', new THREE.Vector3(0.05, 0.05, 0.05), -0.45, -0.3);
  addToy(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.1, 20), toyMat(0x3ecf8e)), 'box', new THREE.Vector3(0.04, 0.05, 0.04), -0.4, 0.5);
  addToy(new THREE.Mesh(new THREE.SphereGeometry(0.04, 20, 14), toyMat(0xff8fd6)), 'sphere', new THREE.Vector3(0.04, 0.04, 0.04), 0.35, -0.45);

  // behaviour: walk to a toy and shove it, perform one of the firmware's emotes, or lie down for a rest
  const bot = { pos: new THREE.Vector2(0, 0.1), yaw: new URLSearchParams(location.search).has('pose') ? 0 : Math.PI };
  type Plan = { kind: 'walk' | 'emote' | 'rest'; toy?: Body; timer: number; name?: string };
  let plan: Plan = { kind: 'emote', timer: 0, name: 'wave' };
  let lastEmote = 'wave';
  let gait: 'walk_forward' | 'turn_left' | 'turn_right' | null = null;
  const setGait = (g: typeof gait) => {
    if (g === gait) return;
    gait = g;
    if (g) rig.play(g, true, true);
  };
  // ?pose=<sequence> holds one firmware sequence in place (for checking poses)
  const forced = new URLSearchParams(location.search).get('pose');
  rig.play(forced ?? 'wave', !!forced, true);
  if (!forced) rig.play('stand');

  const choose = () => {
    const r = Math.random();
    gait = null;
    if (r < 0.45) {
      plan = { kind: 'walk', toy: world.bodies[Math.floor(rand(0, world.bodies.length))], timer: rand(6, 10) };
    } else if (r < 0.9) {
      let name = EMOTES[Math.floor(rand(0, EMOTES.length))];
      if (name === lastEmote) name = EMOTES[(EMOTES.indexOf(name) + 1) % EMOTES.length];
      lastEmote = name;
      plan = { kind: 'emote', timer: 0, name };
      rig.play(name, false, true);
      rig.play('stand');
    } else {
      plan = { kind: 'rest', timer: rand(2.5, 4) };
      rig.play('rest', true, true);
    }
  };

  let blinkT = 0;
  const center3 = new THREE.Vector3();
  const vel3 = new THREE.Vector3();
  return {
    update(time, dt) {
      dt = Math.min(dt, 1 / 20);
      uniforms.uTime.value = time;

      let speed = 0;
      if (forced) { /* hold */ } else if (plan.kind === 'walk') {
        plan.timer -= dt;
        const toy = plan.toy!.pos;
        // aim a little behind the toy, seen from the pen centre, so it gets pushed across the floor
        const dir = new THREE.Vector2(toy.x, toy.z).normalize();
        const target = new THREE.Vector2(toy.x, toy.z).addScaledVector(dir, -botRadius * 0.4);
        const dx = target.x - bot.pos.x, dz = target.y - bot.pos.y;
        const want = Math.atan2(dx, dz);
        const err = Math.atan2(Math.sin(want - bot.yaw), Math.cos(want - bot.yaw));
        // the firmware turns on the spot, then walks; small corrections happen while walking
        if (Math.abs(err) > (gait === 'walk_forward' ? 0.7 : 0.25)) setGait(err > 0 ? 'turn_left' : 'turn_right');
        else setGait('walk_forward');
        if (gait === 'walk_forward') { speed = botLen * 0.5; bot.yaw += err * dt * 0.8; }
        else bot.yaw += Math.sign(err) * dt * 0.9;
        if (plan.timer <= 0 || Math.hypot(dx, dz) < botRadius * 0.3) { rig.play('stand', false, true); choose(); }
      } else if (plan.kind === 'emote') {
        if (plan.name === 'crab') bot.pos.x += Math.sin(time * 2) * dt * botLen * 0.2;
        if (!rig.busy) choose();
      } else {
        plan.timer -= dt;
        if (plan.timer <= 0) { rig.play('stand', false, true); choose(); }
      }

      const lim = half - botRadius;
      bot.pos.x = THREE.MathUtils.clamp(bot.pos.x + Math.sin(bot.yaw) * speed * dt, -lim, lim);
      bot.pos.y = THREE.MathUtils.clamp(bot.pos.y + Math.cos(bot.yaw) * speed * dt, -lim, lim);
      rig.update(dt);
      rig.root.position.set(bot.pos.x, 0, bot.pos.y);
      rig.root.rotation.y = bot.yaw;

      // shove toys
      center3.set(bot.pos.x, 0, bot.pos.y);
      vel3.set(Math.sin(bot.yaw) * speed, 0, Math.cos(bot.yaw) * speed);
      for (const toy of world.bodies) shove(toy, center3, botRadius, vel3, 1.3);
      step(world, dt);

      // face: each sequence frame's face, with the idle blink while standing
      const f = rig.face ?? 'idle';
      if (f === 'stand' || f === 'idle') {
        blinkT += dt;
        showFrame(IDLE.frames[Math.floor(blinkT * IDLE.fps) % IDLE.frames.length]);
      } else if (ANIMATED[f]) {
        showFrame(ANIMATED[f][Math.floor(time * 3) % ANIMATED[f].length]);
      } else showFrame(f);
    },
  };
}
