// Combat Robotics: the Executioner (its real CAD, with the weapon on its shaft) hunts household appliances
// and nerd-culture easter eggs around a small steel arena. The weapon idles, winds up while hunting and
// hits full speed in a charge; every hit bleeds rotor speed, dents the panel it lands on, bends or tears off
// the parts on that side, pops screws, throws sparks, and heavy hits start fires. When a target is stripped
// the wreck burns for a moment, gets cleared, and the next one drops in.
//
// public/rigs/executioner was made with (root_base is a flattened copy of the whole assembly, so it is skipped;
// fasteners, bearings and the electronics hidden under the top plates go too):
//   node scripts/fusion.mjs <Executioner-nexp> public/rigs/executioner --ratio 0.03 --error 0.01 --skip
//     "^root_base$|Screw|Locknut|Bearing|nutsrip|KakeSwitch|S2_Mini|LED_Strip|FlyColor|6s1p|Ovonic|Drive_Pulley|Repeat_Ultra|Anti-Buckle|Internal_Link"

import * as THREE from '../three-lite';
import { buildAppliance, LINEUP, type Build, type Piece } from './appliances';
import { Bits, boltGeometry, Sprites } from './arena-fx';
import { loadFusionRig } from './fusion-rig';
import { hitAt, makeRigid, resize, RigidWorld, wake, type Kinematic, type Rigid } from './rigid';
import { damp, rand, turnToward, wrapAngle } from './shared';
import type { EffectContext, Effect } from './types';

// Weapon joint, checked against the geometry: the export's joint origin is off in space, but the weapon,
// its pulley and both bearings are all centred on y = 0.2113, z = 0.0730 (CAD metres, Z-up), axis along x.
const WEAPON = { ids: ['Revised-asymmetrical_weapon_v1_1', '1277N771_Timing_Belt_Pulley_v2_1'], origin: [0.2132, 0.211287, 0.073025], tip: 0.068, length: 0.144 };
const WHEELS = ['MK3_Cast_Front_Wheels_v7_1', 'MK3_Cast_Front_Wheels_v6_Mirror_1', 'MK3_Cast_Rear_Wheels_v9_1', 'MK3_Cast_Rear_Wheels_v9_1_1'];
/** World units per CAD metre: about the size the old static model had. */
const S = 2.0;

function hazardTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#16171a';
  g.fillRect(0, 0, 256, 32);
  g.fillStyle = '#f2b84b';
  for (let x = -32; x < 290; x += 32) {
    g.beginPath();
    g.moveTo(x, 32); g.lineTo(x + 16, 32); g.lineTo(x + 32, 0); g.lineTo(x + 16, 0);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** Motion smear around the real weapon: a translucent drum that streaks behind each tooth, fading in with speed. */
function blurDrum(radius: number, length: number) {
  const uniforms = { uAngle: { value: 0 }, uSpeed: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `varying vec3 vP; void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uAngle; uniform float uSpeed; varying vec3 vP;
      void main() {
        float phi = atan(vP.z, vP.y);
        // two teeth, half a turn apart; d is how far this point trails the nearest one
        float d = mod(uAngle - phi, 3.14159265);
        float smear = 0.12 + 2.2 * uSpeed * uSpeed;
        float streak = exp(-d / smear);
        float r = length(vP.yz) / ${radius.toFixed(4)};
        float band = smoothstep(0.25, 0.55, r);
        float a = (0.06 + 0.42 * streak) * band * smoothstep(0.3, 0.9, uSpeed);
        vec3 col = mix(vec3(0.75, 0.04, 0.03), vec3(1.0, 0.75, 0.7), streak * 0.5);
        gl_FragColor = vec4(col, a);
      }`,
  });
  const g = new THREE.Group();
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 48, 1, true).rotateZ(Math.PI / 2), mat);
  const capGeo = new THREE.CircleGeometry(radius, 48).rotateY(Math.PI / 2);
  const capA = new THREE.Mesh(capGeo, mat);
  const capB = new THREE.Mesh(capGeo, mat);
  capA.position.x = -length / 2;
  capB.position.x = length / 2;
  for (const m of [drum, capA, capB]) { m.renderOrder = 5; g.add(m); }
  return { group: g, uniforms };
}

type Loose = { piece: Piece; body: Rigid; lastVy: number };
type Bent = { piece: Piece; hinge: THREE.Group; axis: THREE.Vector3; angle: number; vel: number; target: number; life: number };
type Fire = { local: THREE.Vector3; heat: number };

export default async function arena(ctx: EffectContext): Promise<Effect> {
  const half = ctx.foot * 0.48;
  const floorY = 0.03;

  // ------------------------------------------------------------ arena
  const floor = new THREE.Mesh(new THREE.BoxGeometry(half * 2, floorY, half * 2), new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.55, metalness: 0.5 }));
  floor.position.y = floorY / 2;
  ctx.body.add(floor);
  const plates = new THREE.GridHelper(half * 2, 6, 0x5b616b, 0x4a4f58);
  plates.position.y = floorY + 0.002;
  ctx.body.add(plates);
  const stripes = hazardTexture();
  for (const [x, z, ry] of [[0, -half + 0.05, 0], [0, half - 0.05, 0], [-half + 0.05, 0, Math.PI / 2], [half - 0.05, 0, Math.PI / 2]] as const) {
    const t = stripes.clone();
    t.repeat.set(8, 1);
    t.needsUpdate = true;
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(half * 2 - 0.1, 0.1), new THREE.MeshBasicMaterial({ map: t }));
    strip.rotation.set(-Math.PI / 2, 0, ry);
    strip.position.set(x, floorY + 0.004, z);
    ctx.body.add(strip);
  }
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xcfe3ff, transparent: true, opacity: 0.1, roughness: 0.05, depthWrite: false, side: THREE.DoubleSide });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.5, metalness: 0.6 });
  const wallH = 0.42;
  for (const [x, z, ry, h] of [[0, -half, 0, wallH], [0, half, 0, wallH * 0.55], [-half, 0, Math.PI / 2, wallH], [half, 0, Math.PI / 2, wallH]] as const) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, h), wallMat);
    wall.position.set(x, floorY + h / 2, z);
    wall.rotation.y = ry;
    const rail = new THREE.Mesh(new THREE.BoxGeometry(half * 2, 0.02, 0.02), frameMat);
    rail.position.set(x, floorY + h, z);
    rail.rotation.y = ry;
    ctx.body.add(wall, rail);
  }
  for (const [x, z] of [[-half, -half], [half, -half], [-half, half], [half, half]]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.04, wallH + 0.02, 0.04), frameMat);
    post.position.set(x, floorY + (wallH + 0.02) / 2, z);
    ctx.body.add(post);
  }

  // ------------------------------------------------------------ the robot: real CAD, live weapon and wheels
  ctx.model.visible = false;
  const rig = await loadFusionRig(ctx, '/rigs/executioner');
  const robot = new THREE.Group();
  ctx.body.add(robot);
  const tilt = new THREE.Group(); // pitches up on hits
  robot.add(tilt);
  tilt.add(rig.root);
  // CAD front is +y, which stands up as -z; turn it to +z (the drive direction) and size it
  rig.root.rotation.set(0, Math.PI, 0);
  rig.root.scale.setScalar(S);
  robot.updateMatrixWorld(true);
  const rb = new THREE.Box3().setFromObject(rig.root, true).applyMatrix4(new THREE.Matrix4().copy(tilt.matrixWorld).invert());
  const rc = rb.getCenter(new THREE.Vector3());
  rig.root.position.set(-rc.x, -rb.min.y, -rc.z);
  const botSize = rb.getSize(new THREE.Vector3());
  robot.updateMatrixWorld(true);
  ctx.pickable(rig.root);

  const weapon = rig.pivot(WEAPON.ids, WEAPON.origin, [1, 0, 0]);
  const blur = blurDrum(WEAPON.tip * 1.02, WEAPON.length);
  blur.group.position.set(WEAPON.origin[0], WEAPON.origin[1], WEAPON.origin[2]);
  rig.scene.add(blur.group);
  const wheels = WHEELS.map((id) => {
    const o = rig.info.occurrences.find((x) => x.id === id);
    if (!o) return null;
    const c = [0, 1, 2].map((k) => (o.bbox[0][k] + o.bbox[1][k]) / 2);
    return { pivot: rig.pivot([id], c, [1, 0, 0]), left: c[0] < 0.2, r: ((o.bbox[1][2] - o.bbox[0][2]) / 2) * S, angle: 0 };
  }).filter((x) => x !== null);

  // weapon axis in the robot frame, for contact points
  robot.updateMatrixWorld(true);
  const axisLocal = robot.worldToLocal(weapon.group.getWorldPosition(new THREE.Vector3()));
  const tipReach = axisLocal.z + WEAPON.tip * S; // how far in front of the robot centre the teeth reach
  // physics box for the chassis only: the low forks slide under things, the weapon makes the contact
  const kin: Kinematic = {
    pos: new THREE.Vector3(), quat: new THREE.Quaternion(), vel: new THREE.Vector3(),
    half: new THREE.Vector3(botSize.x / 2, botSize.y / 2, (axisLocal.z + botSize.z / 2) / 2),
  };
  const kinOffset = (axisLocal.z - botSize.z / 2) / 2; // its centre sits behind the robot centre
  const botRadius = Math.max(botSize.x, botSize.z) / 2;

  // ------------------------------------------------------------ effects
  const fxU = { uTime: { value: 0 } };
  const sparks = new Sprites(ctx.body, 360, 'spark', fxU);
  const flames = new Sprites(ctx.body, 220, 'flame', fxU);
  const smoke = new Sprites(ctx.body, 160, 'smoke', fxU);
  const bolts = new Bits(ctx.body, 60, boltGeometry(), new THREE.MeshStandardMaterial({ color: 0xb7bec6, roughness: 0.3, metalness: 0.9 }), half - 0.02, half - 0.02);
  const chips = new Bits(ctx.body, 70, new THREE.BoxGeometry(1, 0.35, 0.7), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }), half - 0.02, half - 0.02);
  chips.mesh.setColorAt(0, new THREE.Color(0xffffff));
  const flash = new THREE.PointLight(0xffa640, 0, 1.8, 2);
  ctx.body.add(flash);
  let flashI = 0;
  const C = {
    spark: new THREE.Color(1, 0.55, 0.18), ember: new THREE.Color(1, 0.4, 0.08), flame: new THREE.Color(1, 0.42, 0.08),
    smoke: new THREE.Color(0.11, 0.11, 0.12), dust: new THREE.Color(0.55, 0.53, 0.5), fluff: new THREE.Color(0.95, 0.95, 0.93),
  };
  const v = new THREE.Vector3();
  const w = new THREE.Vector3();

  const sparkBurst = (at: THREE.Vector3, dir: THREE.Vector3, n: number, speed = 3) => {
    for (let k = 0; k < n; k++) {
      const s = speed * rand(0.35, 1.25);
      v.set(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).normalize().multiplyScalar(0.7).add(dir).normalize().multiplyScalar(s);
      sparks.spawn(at.x, at.y, at.z, v.x, v.y, v.z, rand(0.008, 0.016), rand(0.25, 0.7), C.spark, { stretch: 0.035, buoy: -7 });
    }
  };
  const puff = (at: THREE.Vector3, color: THREE.Color, n: number, size = 0.12, rise = 0.3) => {
    for (let k = 0; k < n; k++) {
      smoke.spawn(at.x + rand(-0.04, 0.04), at.y + rand(-0.02, 0.04), at.z + rand(-0.04, 0.04), rand(-0.25, 0.25), rise * rand(0.6, 1.4), rand(-0.25, 0.25),
        size * rand(0.7, 1.3), rand(1.4, 2.6), color, { grow: 2.2, buoy: 0.05, drag: 1.5 });
    }
  };

  // ------------------------------------------------------------ robot state
  const R = { pos: new THREE.Vector2(-half * 0.45, half * 0.45), yaw: 0.6, speed: 0, turn: 0 };
  type Mode = 'roam' | 'hunt' | 'charge' | 'recoil';
  let mode: Mode = 'roam';
  let timer = rand(1, 2);
  let sinceHit = 0;
  let spin = 0.1; // 0 idle .. 1 full speed
  let weaponAngle = 0;
  let pitch = 0, pitchVel = 0;
  const waypoint = new THREE.Vector2(rand(-1, 1) * half * 0.5, rand(-1, 1) * half * 0.5);
  let time = 0;

  // ------------------------------------------------------------ physics and the current target
  const world = new RigidWorld(floorY, half, half);
  world.robots.push(kin);
  let lineup = 0;
  let build!: Build;
  let chassis!: THREE.Group;
  let body!: Rigid;
  let attached: Piece[] = [];
  let loose: Loose[] = [];
  let bent: Bent[] = [];
  let vanishing: { mesh: THREE.Object3D; t: number }[] = [];
  let fires: Fire[] = [];
  let power = 1;
  let damage = 0;
  let perHit = 2;
  let finished = 0; // seconds since the last part came off (0 while parts remain)
  let clearing = 0; // > 0 while the wreck shrinks away

  const spawn = (index: number, drop: boolean) => {
    build = buildAppliance(LINEUP[index % LINEUP.length]);
    chassis = new THREE.Group();
    ctx.body.add(chassis);
    for (const p of build.pieces) {
      p.mesh.position.copy(p.home);
      p.mesh.quaternion.copy(p.homeQ);
      chassis.add(p.mesh);
    }
    body = makeRigid(chassis, build.half, 3, { restitution: 0.25, friction: 0.7 });
    // drop in away from the robot, facing roughly toward the front of the cell
    for (let k = 0; k < 8; k++) {
      body.pos.set(rand(-0.4, 0.4) * half, floorY + build.half.y + (drop ? 1.1 : 0.002), rand(-0.45, 0.2) * half);
      if (Math.hypot(body.pos.x - R.pos.x, body.pos.z - R.pos.y) > 0.9) break;
    }
    body.quat.setFromAxisAngle(v.set(0, 1, 0), rand(-0.5, 0.5));
    chassis.position.copy(body.pos);
    chassis.quaternion.copy(body.quat);
    world.add(body);
    attached = build.pieces.slice(0, -1);
    perHit = Math.max(2, Math.ceil(attached.length / 7));
    loose = []; bent = []; vanishing = []; fires = [];
    power = 1; damage = 0; finished = 0;
    build.tick(0, 1);
  };

  /** Re-fit the chassis box to what is still attached, keeping the body origin at the box centre. */
  const refit = () => {
    const bb = new THREE.Box3();
    const pb = new THREE.Box3();
    const m = new THREE.Matrix4();
    const one = new THREE.Vector3(1, 1, 1);
    for (const p of [...attached, build.core]) {
      pb.setFromCenterAndSize(v.set(0, 0, 0), w.copy(p.half).multiplyScalar(2));
      bb.union(pb.applyMatrix4(m.compose(p.home, p.homeQ, one)));
    }
    const c = bb.getCenter(new THREE.Vector3());
    for (const ch of chassis.children) ch.position.sub(c);
    for (const p of build.pieces) if (p.state < 2) p.home.sub(c);
    for (const f of fires) f.local.sub(c);
    resize(body, bb.getSize(w).multiplyScalar(0.5));
    body.pos.add(c.applyQuaternion(body.quat));
    chassis.position.copy(body.pos);
  };

  /** Pose of an object in the cell body's space. */
  const bodyPose = (o: THREE.Object3D, pos: THREE.Vector3, quat: THREE.Quaternion) => {
    ctx.body.updateMatrixWorld(true);
    o.updateMatrixWorld(true);
    new THREE.Matrix4().copy(ctx.body.matrixWorld).invert().multiply(o.matrixWorld).decompose(pos, quat, new THREE.Vector3());
  };

  const popScrews = (p: Piece, n: number, kick: THREE.Vector3) => {
    if (!n) return;
    const pos = new THREE.Vector3(), q = new THREE.Quaternion();
    bodyPose(p.mesh, pos, q);
    for (let k = 0; k < n; k++) {
      const corner = new THREE.Vector3(Math.random() < 0.5 ? p.half.x : -p.half.x, Math.random() < 0.5 ? p.half.y : -p.half.y, Math.random() < 0.5 ? p.half.z : -p.half.z).multiplyScalar(0.85).applyQuaternion(q).add(pos);
      const out = corner.clone().sub(pos).normalize();
      bolts.spawn(corner, out.multiplyScalar(rand(0.8, 1.8)).add(kick).add(v.set(rand(-0.5, 0.5), rand(1.2, 2.6), rand(-0.5, 0.5))), rand(0.022, 0.034));
    }
  };

  /** Tear a piece off: it becomes its own rigid body (or vanishes, for a blade). */
  const detach = (p: Piece, kick: THREE.Vector3) => {
    const pos = new THREE.Vector3(), q = new THREE.Quaternion();
    bodyPose(p.mesh, pos, q);
    const b = bent.find((x) => x.piece === p);
    if (b) { bent = bent.filter((x) => x !== b); b.hinge.removeFromParent(); }
    ctx.body.add(p.mesh);
    p.mesh.position.copy(pos);
    p.mesh.quaternion.copy(q);
    p.state = 2;
    attached = attached.filter((x) => x !== p);
    if (p.vanish) { vanishing.push({ mesh: p.mesh, t: 0.25 }); return; }
    const r = makeRigid(p.mesh, p.half, p.mass, { restitution: 0.3, friction: 0.65 });
    // start with the chassis' own motion at that point, plus the kick
    r.vel.crossVectors(body.ang, w.copy(pos).sub(body.pos)).add(body.vel).add(kick);
    r.ang.set(rand(-14, 14), rand(-10, 10), rand(-14, 14)).multiplyScalar(Math.min(1, 0.4 / Math.max(0.05, p.half.length())));
    world.add(r);
    loose.push({ piece: p, body: r, lastVy: r.vel.y });
  };

  /** Bend a panel out on a hinge along one of its edges (the one away from the hit, or a door's own). */
  const bend = (p: Piece, hitLocal: THREE.Vector3) => {
    const h = p.half;
    // thin axis is the panel normal; the hinge sits on an in-plane edge
    const axes = [0, 1, 2].sort((a, b) => h.getComponent(a) - h.getComponent(b));
    const thin = axes[0];
    let edge: THREE.Vector3;
    if (p.hinge) edge = p.hinge.clone();
    else {
      // hinge on the far side from the hit, across whichever in-plane axis the hit is further along
      const q = hitLocal.clone().sub(p.home).applyQuaternion(p.homeQ.clone().invert());
      const a = Math.abs(q.getComponent(axes[1]) / h.getComponent(axes[1])) > Math.abs(q.getComponent(axes[2]) / h.getComponent(axes[2])) ? axes[1] : axes[2];
      edge = new THREE.Vector3().setComponent(a, -Math.sign(q.getComponent(a)) || 1);
    }
    const ea = [0, 1, 2].find((k) => Math.abs(edge.getComponent(k)) > 0.5) ?? 1;
    const line = [0, 1, 2].find((k) => k !== ea && k !== thin) ?? [0, 1, 2].find((k) => k !== ea)!;
    // panel's outward normal (away from the chassis centre)
    const nrm = new THREE.Vector3().setComponent(thin, 1);
    if (nrm.clone().applyQuaternion(p.homeQ).dot(p.home) < 0) nrm.negate();
    const axis = new THREE.Vector3().setComponent(line, 1);
    // the free edge must swing outward
    if (new THREE.Vector3().crossVectors(axis, edge.clone().negate()).dot(nrm) < 0) axis.negate();
    const hinge = new THREE.Group();
    hinge.position.copy(edge.clone().multiply(h).applyQuaternion(p.homeQ).add(p.home));
    chassis.add(hinge);
    chassis.updateMatrixWorld(true);
    hinge.attach(p.mesh);
    p.state = 1;
    bent.push({ piece: p, hinge, axis: axis.applyQuaternion(p.homeQ).normalize(), angle: 0, vel: rand(6, 10), target: rand(0.45, 1.1), life: rand(5, 9) });
  };

  /** Push panel vertices in around the hit point (the segmented bevelled boxes take this well). */
  const dent = (p: Piece, at: THREE.Vector3, dir: THREE.Vector3, depth: number) => {
    const geo = p.mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    ctx.body.updateMatrixWorld(true);
    p.mesh.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(p.mesh.matrixWorld).invert();
    const local = at.clone().applyMatrix4(ctx.body.matrixWorld).applyMatrix4(inv);
    const d = dir.clone().transformDirection(ctx.body.matrixWorld).transformDirection(inv);
    const radius = Math.max(p.half.x, p.half.y, p.half.z) * 0.6;
    let moved = false;
    for (let i = 0; i < pos.count; i++) {
      // distance across the panel only, so both skins move together and it bends instead of folding through
      const ox = pos.getX(i) - local.x, oy = pos.getY(i) - local.y, oz = pos.getZ(i) - local.z;
      const along = ox * d.x + oy * d.y + oz * d.z;
      const r = Math.hypot(ox - d.x * along, oy - d.y * along, oz - d.z * along) / radius;
      if (r >= 1) continue;
      const k = (1 - r * r) * (1 - r * r) * depth;
      pos.setXYZ(i, pos.getX(i) + d.x * k, pos.getY(i) + d.y * k, pos.getZ(i) + d.z * k);
      moved = true;
    }
    if (!moved) return;
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  };

  spawn(lineup, false);

  const fwd = new THREE.Vector3();
  const tip = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const toTarget = new THREE.Vector2();

  /** The weapon connects: knock the target, take parts off near the contact, sparks, dents, fire. */
  const hit = () => {
    // nearest point on the chassis box to the teeth
    tmpQ.copy(body.quat).invert();
    const local = tip.clone().sub(body.pos).applyQuaternion(tmpQ).clamp(body.half.clone().negate(), body.half);
    const contact = local.clone().applyQuaternion(body.quat).add(body.pos);
    const k = 0.45 + 0.55 * spin;
    // uppercut: the teeth come up through the front, so the shove is forward and up
    hitAt(body, contact, fwd.clone().multiplyScalar(2.2 * k).addScaledVector(up, 2.7 * k).multiplyScalar(1 / body.invMass));
    body.ang.clampLength(0, 9);

    const dirLocal = local.lengthSq() > 1e-6 ? local.clone().normalize() : v.set(0, 0, 1);
    // pieces on the struck side first; already bent ones are next to go
    const scored = attached.map((p) => ({ p, s: (p.home.lengthSq() > 1e-8 ? p.home.clone().normalize().dot(dirLocal) : 0) + (p.state === 1 ? 0.6 : 0) + rand(0, 0.35) }));
    scored.sort((a, b) => b.s - a.s);
    let dented = false;
    for (const { p } of scored.slice(0, perHit)) {
      if (p.panel && !dented) { dent(p, contact, fwd, 0.035 * k); dented = true; }
      if (p.panel && p.state === 0 && Math.random() < 0.8) {
        bend(p, local);
        popScrews(p, Math.ceil(p.screws / 2), fwd.clone().multiplyScalar(0.6));
      } else {
        popScrews(p, p.screws, fwd.clone().multiplyScalar(0.8));
        detach(p, fwd.clone().multiplyScalar(rand(1, 2.4) * k).addScaledVector(up, rand(1.4, 2.8) * k).add(v.set(rand(-0.6, 0.6), 0, rand(-0.6, 0.6))));
      }
    }
    refit();

    // what flies
    const n = build.matter === 'soft' ? 18 : build.matter === 'plastic' ? 40 : 80;
    sparkBurst(contact, up.clone().multiplyScalar(1.2).addScaledVector(fwd, 0.6), Math.round(n * k), 3.2 * k + 1);
    for (let c = 0; c < (build.matter === 'metal' ? 3 : 7); c++) chips.spawn(contact, v.set(rand(-1, 1), rand(1, 2.6), rand(-1, 1)).addScaledVector(fwd, 1.2), rand(0.012, 0.024), build.chip);
    if (build.matter === 'soft') puff(contact, C.fluff, 6, 0.06, 0.6);
    if (spin > 0.7) puff(contact, C.smoke, 2, 0.08, 0.35);
    flash.position.copy(contact).y += 0.1;
    flashI = 5;
    // fire: every hit adds damage; flammable things catch sooner
    damage += k;
    power = Math.max(0, power - 0.45);
    if (damage > 2.4 - build.fuel * 1.4 && fires.length < 3) fires.push({ local: contact.clone().sub(body.pos).applyQuaternion(tmpQ.copy(body.quat).invert()).multiplyScalar(0.7), heat: 0.4 });
    for (const f of fires) f.heat = Math.min(1, f.heat + 0.2);

    // recoil and rotor speed loss
    spin = Math.max(0.25, spin - 0.38);
    R.speed = -0.9;
    pitchVel += 2.5 * k;
    mode = 'recoil';
    timer = rand(0.5, 0.8);
    sinceHit = 0;
  };

  return {
    update(_t, dtIn) {
      const dt = Math.min(dtIn, 1 / 30);
      if (dt <= 0) return;
      time += dt;
      fxU.uTime.value = time;
      const lim = half - botRadius * 0.9;
      sinceHit += dt;

      // ---------------------------------------------------------- target state
      const toT = toTarget.set(body.pos.x - R.pos.x, body.pos.z - R.pos.y);
      const distT = toT.length();
      const settled = body.air < 0.3 && body.vel.lengthSq() < 0.5;
      const live = attached.length > 0 && clearing <= 0;
      // keep the target off the walls so there is always a way in
      const wallLim = half - Math.max(build.half.x, build.half.z) - botRadius * 1.1;
      for (const k of ['x', 'z'] as const) {
        if (Math.abs(body.pos[k]) > wallLim && live) { body.vel[k] -= Math.sign(body.pos[k]) * dt * 2.5; wake(body); }
      }
      // watchdog: never get stuck unable to reach the last pieces
      if (live && sinceHit > 9) {
        body.pos.set(rand(-0.2, 0.2) * half, floorY + build.half.y + 0.7, rand(-0.2, 0.2) * half);
        body.vel.set(0, 0, 0); body.ang.set(0, 0, 0); wake(body);
        puff(v.set(body.pos.x, floorY + 0.05, body.pos.z), C.dust, 5, 0.12);
        sinceHit = 4; mode = 'roam'; timer = 0.6;
      }

      // ---------------------------------------------------------- driving
      timer -= dt;
      const yawPrev = R.yaw;
      // standoff: just outside weapon reach of the target's box
      const reach = tipReach + Math.max(build.half.x, build.half.z);
      if (mode === 'roam') {
        if (R.pos.distanceTo(waypoint) < 0.2 || timer < -4) {
          waypoint.set(rand(-lim, lim) * 0.85, rand(-lim, lim) * 0.85);
          timer = Math.min(timer, rand(0.8, 2));
        }
        R.yaw = turnToward(R.yaw, Math.atan2(waypoint.x - R.pos.x, waypoint.y - R.pos.y), dt * 2.6);
        R.speed += (0.45 - R.speed) * damp(3, dt);
        if (timer <= 0 && live && settled) { mode = 'hunt'; timer = 4; }
      } else if (mode === 'hunt') {
        const want = Math.atan2(toT.x, toT.y);
        R.yaw = turnToward(R.yaw, want, dt * 3);
        const err = Math.abs(wrapAngle(want - R.yaw));
        // line up a run: back off if too close, creep in if far
        const gap = distT - (reach + 0.45);
        R.speed += (THREE.MathUtils.clamp(gap * 2, -0.5, 0.6) * (err < 0.6 ? 1 : 0.3) - R.speed) * damp(4, dt);
        if ((err < 0.18 && spin > 0.55 && Math.abs(gap) < 0.35) || timer <= 0) { mode = 'charge'; timer = 2.6; }
        if (!live) { mode = 'roam'; timer = rand(1, 2); }
      } else if (mode === 'charge') {
        R.yaw = turnToward(R.yaw, Math.atan2(toT.x, toT.y), dt * 2.2);
        R.speed += (1.5 - R.speed) * damp(5, dt);
        if (!live) { mode = 'roam'; timer = rand(1, 2); }
      } else {
        R.speed += (0 - R.speed) * damp(3, dt);
        if (timer <= 0) { mode = live ? 'hunt' : 'roam'; timer = live ? 3.5 : rand(1, 2); }
      }
      R.turn = wrapAngle(R.yaw - yawPrev) / dt;
      R.pos.x = THREE.MathUtils.clamp(R.pos.x + Math.sin(R.yaw) * R.speed * dt, -lim, lim);
      R.pos.y = THREE.MathUtils.clamp(R.pos.y + Math.cos(R.yaw) * R.speed * dt, -lim, lim);
      robot.position.set(R.pos.x, floorY, R.pos.y);
      robot.rotation.set(0, R.yaw, 0);
      // the nose lifts a little on hits (gyro kick), then drops back onto the forks
      pitchVel += (-60 * pitch - 9 * pitchVel) * dt;
      pitch = Math.max(0, pitch + pitchVel * dt);
      tilt.rotation.x = -pitch * 0.25;
      fwd.set(Math.sin(R.yaw), 0, Math.cos(R.yaw));
      kin.pos.set(R.pos.x + fwd.x * kinOffset, floorY + kin.half.y, R.pos.y + fwd.z * kinOffset);
      kin.quat.setFromAxisAngle(up, R.yaw);
      kin.vel.copy(fwd).multiplyScalar(R.speed);
      tip.set(R.pos.x + fwd.x * tipReach, floorY + axisLocal.y, R.pos.y + fwd.z * tipReach);

      // the teeth reach the target's box (or a charge runs out right next to it)
      if (mode === 'charge' && live) {
        tmpQ.copy(body.quat).invert();
        const l = w.copy(tip).sub(body.pos).applyQuaternion(tmpQ);
        const out = Math.hypot(Math.max(0, Math.abs(l.x) - body.half.x), Math.max(0, Math.abs(l.y) - body.half.y), Math.max(0, Math.abs(l.z) - body.half.z));
        if (out < 0.05 || (timer <= 0 && distT < reach * 1.6)) hit();
        else if (timer <= 0) { mode = 'hunt'; timer = 3; }
      }

      // ---------------------------------------------------------- weapon: idle, winding up, full speed
      const wantSpin = !live ? 0.12 : mode === 'charge' ? 1 : mode === 'hunt' ? 0.8 : mode === 'recoil' ? 0.55 : 0.3;
      spin += (wantSpin - spin) * damp(wantSpin > spin ? 0.9 : 0.5, dt);
      weaponAngle += (1.2 + spin * 34) * dt;
      weapon.set(weaponAngle);
      blur.uniforms.uAngle.value = weaponAngle % (Math.PI * 2);
      blur.uniforms.uSpeed.value = spin;
      for (const wh of wheels) {
        const vSide = R.speed + R.turn * (wh.left ? -1 : 1) * botSize.x * 0.45;
        wh.angle -= (vSide / wh.r) * dt;
        wh.pivot.set(wh.angle);
      }

      // ---------------------------------------------------------- appliance animation and bent panels
      build.tick(time, power);
      for (const b of bent) {
        b.vel += (40 * (b.target - b.angle) - 4 * b.vel) * dt + rand(-1, 1) * body.vel.length() * 6 * dt;
        b.angle = THREE.MathUtils.clamp(b.angle + b.vel * dt, 0, 1.9);
        b.hinge.quaternion.setFromAxisAngle(b.axis, b.angle);
        // violent tumbles tear hinged panels off on their own
        b.life -= dt * (1 + body.ang.length() * 0.3);
      }
      const torn = bent.find((x) => x.life <= 0);
      if (torn) { detach(torn.piece, v.set(rand(-0.5, 0.5), rand(0.5, 1.2), rand(-0.5, 0.5))); refit(); }

      world.step(dt);

      for (const l of loose) {
        // landing hard: sparks off metal, a little dust off everything else
        const vy = l.body.vel.y;
        if (l.lastVy < -1.6 && vy > -0.3) {
          v.copy(l.body.pos).setY(floorY + 0.01);
          if (build.matter === 'metal') sparkBurst(v, up, 6, 1.4);
          puff(v, C.dust, 1, 0.07, 0.15);
        }
        l.lastVy = vy;
      }
      for (const x of vanishing) { x.t -= dt; x.mesh.scale.setScalar(Math.max(0.001, x.t / 0.25)); if (x.t <= 0) x.mesh.visible = false; }

      // ---------------------------------------------------------- fire: flames, embers and smoke from points on the chassis
      const burning = finished > 0 ? 1 : 0;
      let fireLight = 0;
      for (const f of fires) {
        if (clearing > 0) f.heat = Math.max(0, f.heat - dt * 2);
        const heat = clearing > 0 ? f.heat : Math.min(1, f.heat + burning * 0.6);
        w.copy(f.local).applyQuaternion(body.quat).add(body.pos);
        w.y = Math.max(w.y, floorY + 0.02);
        if (Math.random() < 40 * heat * dt) flames.spawn(w.x + rand(-0.04, 0.04), w.y, w.z + rand(-0.04, 0.04), rand(-0.05, 0.05), rand(0.15, 0.35), rand(-0.05, 0.05), rand(0.07, 0.14) * (0.6 + heat * 0.6), rand(0.45, 0.8), C.flame, { buoy: 0.9, drag: 1 });
        if (Math.random() < 5 * heat * dt) sparks.spawn(w.x, w.y + 0.05, w.z, rand(-0.3, 0.3), rand(0.5, 1.1), rand(-0.3, 0.3), rand(0.006, 0.011), rand(1.2, 2.2), C.ember, { stretch: 0.01, buoy: 0.25, drag: 0.8 });
        if (Math.random() < 4 * heat * dt) smoke.spawn(w.x, w.y + 0.12, w.z, rand(-0.06, 0.06), rand(0.18, 0.32), rand(-0.06, 0.06), rand(0.1, 0.16), rand(2.4, 3.6), C.smoke, { grow: 2.6, buoy: 0.08, drag: 0.6 });
        fireLight = Math.max(fireLight, heat);
        flash.position.lerp(w, damp(4, dt));
      }
      flashI = Math.max(0, flashI - dt * 22);
      flash.intensity = Math.max(flashI, fireLight * (1.2 + 0.5 * Math.sin(time * 23) * Math.sin(time * 7.3)));

      sparks.update(dt, floorY);
      flames.update(dt, floorY);
      smoke.update(dt, floorY);
      bolts.update(dt, floorY);
      chips.update(dt, floorY);

      // ---------------------------------------------------------- stripped: burn, clear, next
      if (!attached.length && clearing <= 0) {
        if (finished === 0) {
          // the last part is off: everything flares up
          if (!fires.length) fires.push({ local: new THREE.Vector3(), heat: 1 });
          fires.push({ local: new THREE.Vector3(rand(-0.05, 0.05), build.core.half.y, 0), heat: 1 });
          puff(v.copy(body.pos).setY(body.pos.y + 0.1), C.smoke, 6, 0.14, 0.5);
        }
        finished += dt;
        if (finished > 4.5) {
          clearing = 1;
          for (const l of loose) puff(l.body.pos, C.dust, 1, 0.1, 0.2);
          puff(body.pos, C.dust, 4, 0.16, 0.3);
          bolts.expire(0.6);
          chips.expire(0.6);
        }
      }
      if (clearing > 0) {
        clearing -= dt;
        const k = Math.max(0.001, clearing);
        chassis.scale.setScalar(k);
        for (const l of loose) l.piece.mesh.scale.setScalar(k);
        if (clearing <= 0) {
          for (const o of [chassis, ...build.pieces.map((p) => p.mesh)]) {
            o.removeFromParent();
            o.traverse((m) => (m as THREE.Mesh).geometry?.dispose());
          }
          world.bodies.length = 0;
          lineup = (lineup + 1) % LINEUP.length;
          spawn(lineup, true);
          mode = 'roam';
          timer = 1.5;
          sinceHit = 0;
        }
      }
    },
  };
}
