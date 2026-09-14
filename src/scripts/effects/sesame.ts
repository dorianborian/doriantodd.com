// Sesame playpen: a smaller Sesame inside glowing digital walls, pushing simple toys around.
// Its OLED face uses the real 128x64 face bitmaps from the Sesame firmware and changes often.

import * as THREE from '../three-lite';
import { makeBody, shove, step, type Body, type World } from './physics';
import { boundsInBody, damp, glowMaterial, rand, turnToward } from './shared';
import type { EffectContext, Effect } from './types';

type Atlas = { cols: number; rows: number; frames: Record<string, number> };

// Face animations: frame sequences and playback rate, mirroring the firmware's face table.
const MOODS: Record<string, { frames: string[]; fps: number }> = {
  idle: { frames: ['idle', 'idle', 'idle', 'idle_blink', 'idle_blink_1', 'idle_blink_2', 'idle_blink_3', 'idle'], fps: 7 },
  happy: { frames: ['happy', 'talk_happy'], fps: 3 },
  excited: { frames: ['excited', 'talk_excited'], fps: 4 },
  love: { frames: ['love', 'talk_love'], fps: 2 },
  surprised: { frames: ['surprised', 'talk_surprised'], fps: 3 },
  thinking: { frames: ['thinking', 'thinking_2', 'talk_thinking'], fps: 2 },
  confused: { frames: ['confused', 'talk_confused'], fps: 2 },
  dance: { frames: ['dance', 'dance_1'], fps: 4 },
  cute: { frames: ['cute'], fps: 1 },
  freaky: { frames: ['freaky'], fps: 1 },
  point: { frames: ['point', 'point_1', 'point_2'], fps: 5 },
  sleepy: { frames: ['sleepy', 'talk_sleepy'], fps: 1.5 },
  wave: { frames: ['wave'], fps: 1 },
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

export default async function sesame(ctx: EffectContext): Promise<Effect> {
  const full = boundsInBody(ctx, [ctx.model]);
  const size = full.getSize(new THREE.Vector3());

  // Face on the OLED facade. The facade body in the Sesame CAD sits at the front of the head, in the
  // model file's own coordinates: front surface at x = -0.99, centred at y = 4.22, z = 0.26, 2.54 wide.
  // Parenting to the glTF scene keeps it locked to the head whatever orientation is applied.
  const scene = ctx.model.children[0]?.children[0]?.children[0]?.children[0];
  const atlas: Atlas = await fetch('/sesame/faces.json').then((r) => r.json());
  const tex = await new THREE.TextureLoader().loadAsync('/sesame/faces.png');
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.repeat.set(1 / atlas.cols, 1 / atlas.rows);
  if (scene) {
    const w = 1.7;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 2), new THREE.MeshBasicMaterial({ map: tex, color: 0xcdefff, toneMapped: false }));
    face.rotation.y = -Math.PI / 2; // the robot looks along -x in the model file
    face.position.set(-1.02, 4.22, 0.26);
    scene.add(face);
  }
  const showFrame = (name: string) => {
    const i = atlas.frames[name] ?? atlas.frames.idle;
    tex.offset.set((i % atlas.cols) / atlas.cols, 1 - (Math.floor(i / atlas.cols) + 1) / atlas.rows);
  };

  const SCALE = 0.2;
  ctx.model.scale.setScalar(SCALE);
  const botRadius = Math.max(size.x, size.z) * SCALE * 0.45;

  // Digital walls
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

  // Toys
  const toyMat = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45 });
  const world: World = { gravity: 9.8, floor: 0, bounds: { cx: 0, cz: 0, hx: half, hz: half }, bodies: [] };
  const addToy = (mesh: THREE.Mesh, shape: 'box' | 'sphere', halfExt: THREE.Vector3, x: number, z: number) => {
    mesh.position.set(x, halfExt.y, z);
    ctx.body.add(mesh);
    const b = makeBody(mesh, shape, halfExt, { restitution: shape === 'sphere' ? 0.7 : 0.3, friction: shape === 'sphere' ? 0.18 : 0.7, mass: shape === 'sphere' ? 0.6 : 1 });
    world.bodies.push(b);
    return b;
  };
  addToy(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), toyMat(0xff5a5f)), 'box', new THREE.Vector3(0.06, 0.06, 0.06), 0.55, 0.4);
  addToy(new THREE.Mesh(new THREE.SphereGeometry(0.065, 24, 16), toyMat(0xffd23f)), 'sphere', new THREE.Vector3(0.065, 0.065, 0.065), -0.5, -0.3);
  addToy(new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.14, 20), toyMat(0x3ecf8e)), 'box', new THREE.Vector3(0.055, 0.07, 0.055), -0.4, 0.55);
  addToy(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 0.08), toyMat(0x5b8cff)), 'box', new THREE.Vector3(0.1, 0.04, 0.04), 0.45, -0.55);
  addToy(new THREE.Mesh(new THREE.SphereGeometry(0.05, 20, 14), toyMat(0xff8fd6)), 'sphere', new THREE.Vector3(0.05, 0.05, 0.05), 0.1, -0.15);

  // Behaviour
  const bot = { pos: new THREE.Vector2(0, 0.2), yaw: Math.PI, speed: 0, phase: 0, spin: 0 };
  type Plan = { kind: 'push' | 'dance' | 'look' | 'wander'; toy?: Body; timer: number; mood: string; point?: THREE.Vector2 };
  let plan: Plan = { kind: 'look', timer: 1.2, mood: 'idle' };
  let mood = 'idle', moodTimer = 0, frameT = 0;
  const setMood = (m: string) => { if (m !== mood) { mood = m; frameT = 0; } moodTimer = rand(1.4, 3.2); };

  const choose = () => {
    const r = Math.random();
    if (r < 0.55) {
      const toy = world.bodies[Math.floor(rand(0, world.bodies.length))];
      plan = { kind: 'push', toy, timer: rand(3, 6), mood: ['excited', 'happy', 'point'][Math.floor(rand(0, 3))] };
    } else if (r < 0.7) plan = { kind: 'dance', timer: rand(1.6, 2.6), mood: 'dance' };
    else if (r < 0.85) plan = { kind: 'look', timer: rand(1.2, 2.2), mood: ['thinking', 'confused', 'sleepy'][Math.floor(rand(0, 3))] };
    else plan = { kind: 'wander', timer: rand(2, 3.5), mood: ['love', 'cute', 'wave', 'freaky'][Math.floor(rand(0, 4))], point: new THREE.Vector2(rand(-half, half) * 0.6, rand(-half, half) * 0.6) };
    setMood(plan.mood);
  };

  const center3 = new THREE.Vector3();
  const vel3 = new THREE.Vector3();
  return {
    update(time, dt) {
      dt = Math.min(dt, 1 / 20);
      uniforms.uTime.value = time;

      plan.timer -= dt;
      if (plan.timer <= 0) choose();

      let target: THREE.Vector2 | null = null;
      if (plan.kind === 'push' && plan.toy) {
        // come at the toy from the side facing the pen centre so it gets shoved across
        const toy = plan.toy.pos;
        const dir = new THREE.Vector2(toy.x, toy.z).normalize();
        target = new THREE.Vector2(toy.x, toy.z).addScaledVector(dir, -0.05);
      } else if (plan.kind === 'wander') target = plan.point!;

      let wantSpeed = 0;
      if (plan.kind === 'dance') {
        bot.spin += dt * 6;
        bot.yaw += dt * 5;
      } else if (plan.kind === 'look') {
        bot.yaw += Math.sin(time * 2.2) * dt * 1.4;
      } else if (target) {
        const dx = target.x - bot.pos.x, dz = target.y - bot.pos.y;
        const d = Math.hypot(dx, dz);
        bot.yaw = turnToward(bot.yaw, Math.atan2(dx, dz), dt * 3.2);
        wantSpeed = d > 0.06 ? 0.2 : 0;
      }
      bot.speed += (wantSpeed - bot.speed) * damp(5, dt);
      const lim = half - botRadius;
      bot.pos.x = THREE.MathUtils.clamp(bot.pos.x + Math.sin(bot.yaw) * bot.speed * dt, -lim, lim);
      bot.pos.y = THREE.MathUtils.clamp(bot.pos.y + Math.cos(bot.yaw) * bot.speed * dt, -lim, lim);
      bot.phase += dt * (bot.speed * 30 + (plan.kind === 'dance' ? 10 : 1));
      const hop = plan.kind === 'dance' ? Math.abs(Math.sin(bot.spin)) * 0.025 : Math.abs(Math.sin(bot.phase)) * 0.008;
      ctx.model.position.set(bot.pos.x, hop, bot.pos.y);
      ctx.model.rotation.set(0, bot.yaw, Math.sin(bot.phase) * 0.03);

      // shove toys
      center3.set(bot.pos.x, 0, bot.pos.y);
      vel3.set(Math.sin(bot.yaw) * bot.speed, 0, Math.cos(bot.yaw) * bot.speed);
      for (const toy of world.bodies) {
        if (shove(toy, center3, botRadius, vel3, 1.3) && plan.kind === 'push' && toy === plan.toy && mood !== 'excited') setMood('happy');
      }
      step(world, dt);

      // face
      moodTimer -= dt;
      if (moodTimer <= 0) setMood(Math.random() < 0.35 ? 'idle' : plan.mood);
      frameT += dt;
      const m = MOODS[mood] ?? MOODS.idle;
      showFrame(m.frames[Math.floor(frameT * m.fps) % m.frames.length]);
    },
  };
}
