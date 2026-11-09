// Sesame Drone's joints, shared by the home scene (effects/drone.ts) and the article header (widgets/sesame-drone.ts).
//
// The rig is the Fusion export run through scripts/fusion.mjs (screws dropped, the flattened root deduped):
//   node scripts/fusion.mjs <drone-sesame-3js-export> public/rigs/sesame-drone --ratio 0.03 --error 0.005
//     --min-size 0.003 --min-body 0.0045 --dedupe "^root_base$" --skip "^(91420A|92000A)"
// CAD frame: metres, Y up, the face looks down -x. The design is drawn in drone mode: every foot folded out flat
// against its end stop with the motor on top.
//
// The export's joint list is no use here (its origins are in mixed frames), so the pivots come from the servo models:
// every SG90 is the same vendor part with its output shaft at (-5.18 mm, y, 0) in its own frame, pointing along its +y.
// Run through the occurrence transforms in assembly.json, that puts the hip shafts upright inside the body and the
// knee shafts level, 45 degrees across each corner. The hip servo swings the femur; the knee servo rides in the foot
// (its horn is screwed to the femur) and folds the foot, the motor and the prop.

import * as THREE from '../three-lite';
import { FACE_WINDOW } from './sesame-rig';

const SG = 'SG90_-_Micro_Servo_9g_-_Tower_Pro';
const MOTOR = 'WYanHua-Motor_Micro_1104_Brushless_1-2S_4300KV_v1';
const mm = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).multiplyScalar(0.001);
const D = Math.SQRT1_2;

type LegDef = {
  id: 'FL' | 'FR' | 'BL' | 'BR';
  femur: string[]; foot: string[]; prop: string;
  hip: THREE.Vector3; knee: THREE.Vector3; kneeAxis: THREE.Vector3; motor: THREE.Vector3;
  /** prop direction (alternates around the frame, like any quad) */
  spin: number;
};

// shaft positions from assembly.json (see above), CAD millimetres
const LEGS: LegDef[] = [
  { id: 'FL', femur: ['femur-joint-R1_1', `${SG}.2_Pea_1_1`], foot: ['foot-joint-R3_1', `${SG}.1_Pea_Mirror_1_2`, `${MOTOR}_1`], prop: '40mm_1mm_prop_1',
    hip: mm(1.49, 16.82, -23.02), knee: mm(-30.07, 15.42, -43.47), kneeAxis: new THREE.Vector3(D, 0, -D), motor: mm(-52.26, 27.92, -60.93), spin: 1 },
  { id: 'FR', femur: ['femur-joint-R1_Mirror_1', `${SG}.2_Pea_1`], foot: ['foot-joint-R3_Mirror_1', `${SG}.1_Pea_Mirror_1_1`, `${MOTOR}_v2_Mirror_1`], prop: '40mm_1mm_prop_Mirror_1',
    hip: mm(1.49, 16.82, 27.78), knee: mm(-29.95, 15.42, 48.36), kneeAxis: new THREE.Vector3(D, 0, D), motor: mm(-52.26, 27.92, 65.69), spin: -1 },
  { id: 'BL', femur: ['femur-joint-R1_Mirror_1_1', `${SG}.2_Pea_1_2`, `${SG}.2_Pea_1_4`], foot: ['foot-joint-R3_Mirror_1_1', `${SG}.1_Pea_1_4`, `${MOTOR}_v2_Mirror_1_1`], prop: '40mm_1mm_prop_Mirror_1_1',
    hip: mm(49.95, 16.82, -23.02), knee: mm(81.17, 15.23, -43.81), kneeAxis: new THREE.Vector3(-D, 0, -D), motor: mm(103.62, 27.92, -60.93), spin: -1 },
  { id: 'BR', femur: ['femur-joint-R1_Mirror_Mirror_1', `${SG}.2_Pea_1_3`, `${SG}.2_Pea_1_5`], foot: ['foot-joint-R3_Mirror_Mirror_1', `${SG}.1_Pea_1_5`, `${MOTOR}_v2_Mirror_Mirror_1`], prop: '40mm_1mm_prop_Mirror_Mirror_1',
    hip: mm(49.95, 16.82, 27.78), knee: mm(81.17, 15.23, 48.58), kneeAxis: new THREE.Vector3(-D, 0, D), motor: mm(103.62, 27.92, 65.69), spin: 1 },
];

/** Middle of the four hips (CAD), the point the robot turns about. */
export const CENTER = mm(25.72, 0, 2.38);
const BELLY = -0.001; // underside of the body
const PROP_Y = 0.0399; // prop disc height
const PROP_R = 0.0345;
// the firmware's idle face, blinking every few seconds (7 frames a second)
const IDLE = [...Array(20).fill('idle'), 'idle_blink', 'idle_blink_1', 'idle_blink_2', 'idle_blink_3'];

export type DronePose = {
  /** 0 = walking (feet straight down), 1 = drone mode (feet flat against the end stops) */
  fold: number;
  /** hip swing per leg in radians, positive = foot forward (FL, FR, BL, BR) */
  hips: number[];
  /** extra knee lift per leg in radians, positive = foot up (walking steps) */
  lift: number[];
  /** prop speed in revolutions per second (the blades blur into a disc above ~8) */
  rps: number;
};

export type DroneRig = Awaited<ReturnType<typeof buildDroneRig>>;

function blurTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 6, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.5)');
  grad.addColorStop(0.75, 'rgba(255,255,255,0.32)');
  grad.addColorStop(0.92, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * `cad` is the loaded glTF scene (the CAD frame). Builds the joint groups inside it, keeping every part's pose,
 * and adds the OLED face and prop blur discs. Call pose() every frame.
 */
export async function buildDroneRig(cad: THREE.Object3D) {
  cad.updateMatrixWorld(true);
  // glTF node names can collide with primitive names, the loader keeps the original name in userData
  const parts = new Map<string, THREE.Object3D>();
  cad.traverse((o) => { if (o.userData.name && !parts.has(o.userData.name)) parts.set(o.userData.name, o); });
  const get = (ids: string[]) => ids.map((id) => parts.get(id)).filter((o): o is THREE.Object3D => !!o);

  /** A group at a CAD point turning about a CAD axis; built in the rest pose, so CAD axes are local axes. */
  const pivot = (parent: THREE.Object3D, origin: THREE.Vector3, axis: THREE.Vector3, objects: THREE.Object3D[]) => {
    const g = new THREE.Group();
    parent.add(g);
    parent.updateMatrixWorld(true);
    g.position.copy(parent.worldToLocal(cad.localToWorld(origin.clone())));
    g.updateMatrixWorld(true);
    for (const o of objects) g.attach(o);
    const q = new THREE.Quaternion();
    return { group: g, set: (a: number) => { g.quaternion.copy(q.setFromAxisAngle(axis, a)); } };
  };

  const blurTex = blurTexture();
  const blurMat = new THREE.MeshBasicMaterial({ map: blurTex, color: 0xb9c2cc, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const discGeo = new THREE.CircleGeometry(PROP_R, 40).rotateX(-Math.PI / 2);
  const UP = new THREE.Vector3(0, 1, 0);
  const cadInv = new THREE.Matrix4();
  const tmp = new THREE.Vector3();

  const legs = LEGS.map((def) => {
    const hip = pivot(cad, def.hip, UP, get(def.femur));
    const knee = pivot(hip.group, def.knee, def.kneeAxis, get(def.foot));
    const propObj = get([def.prop]);
    const prop = pivot(knee.group, def.motor, UP, propObj);
    const disc = new THREE.Mesh(discGeo, blurMat);
    disc.position.y = PROP_Y - def.motor.y;
    disc.renderOrder = 2;
    prop.group.add(disc);
    // feet fold down (toward walking) about the knee axis; this sign turns the outward motor end downward
    const out = def.motor.clone().sub(def.knee).setY(0);
    const foldSign = Math.sign(tmp.crossVectors(def.kneeAxis, out).y) || 1;
    // positive hip swing moves the foot toward -x (forward): left legs turn +, right legs -
    const fwdSign = def.hip.z < CENTER.z ? 1 : -1;
    return { def, hip, knee, prop, propObj, disc, foldSign, fwdSign, angle: Math.random() * 6, contacts: [] as THREE.Vector3[] };
  });

  const setKnee = (leg: (typeof legs)[number], fold: number, lift: number) => leg.knee.set(((fold - 1) * Math.PI) / 2 * leg.foldSign + lift * leg.foldSign);

  // lowest point of each foot in the walking and the drone pose, kept in the knee group's frame, for ground contact
  const lowest = (leg: (typeof legs)[number]) => {
    cad.updateMatrixWorld(true);
    cadInv.copy(cad.matrixWorld).invert();
    let best = Infinity;
    const at = new THREE.Vector3();
    const foot = get([leg.def.foot[0]])[0];
    foot?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const pos = mesh.geometry.getAttribute('position');
      const m = new THREE.Matrix4().multiplyMatrices(cadInv, mesh.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        tmp.fromBufferAttribute(pos, i).applyMatrix4(m);
        if (tmp.y < best) { best = tmp.y; at.copy(tmp); }
      }
    });
    // CAD point -> knee group local
    return leg.knee.group.worldToLocal(cad.localToWorld(at));
  };
  for (const fold of [0, 1]) {
    for (const leg of legs) setKnee(leg, fold, 0);
    for (const leg of legs) leg.contacts.push(lowest(leg));
  }

  // OLED face: the firmware's real 128 x 64 face bitmaps behind the cover's face window (same cover as Sesame)
  const [atlas, tex] = await Promise.all([
    fetch('/sesame/faces.json').then((r) => r.json() as Promise<{ cols: number; rows: number; frames: Record<string, number> }>),
    new THREE.TextureLoader().loadAsync('/sesame/faces.png'),
  ]);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.repeat.set(1 / atlas.cols, 1 / atlas.rows);
  const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), FACE_WINDOW.normal.clone().cross(new THREE.Vector3(0, 0, 1)), FACE_WINDOW.normal);
  const place = (o: THREE.Object3D, depth: number) => {
    o.quaternion.setFromRotationMatrix(basis);
    o.position.copy(FACE_WINDOW.center).addScaledVector(FACE_WINDOW.normal, -depth).multiplyScalar(0.001);
    o.scale.setScalar(0.001);
    cad.add(o);
  };
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(...FACE_WINDOW.active), new THREE.MeshBasicMaterial({ map: tex, color: 0xcdefff, toneMapped: false }));
  place(screen, FACE_WINDOW.wall + 0.05);
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(FACE_WINDOW.width + 2, FACE_WINDOW.height + 2),
    new THREE.MeshBasicMaterial({ color: 0x030405, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }),
  );
  place(glass, FACE_WINDOW.wall + 0.3);
  let faceName = 'idle';
  const showFace = (name: string) => {
    const i = atlas.frames[name] ?? atlas.frames.idle;
    tex.offset.set((i % atlas.cols) / atlas.cols, 1 - (Math.floor(i / atlas.cols) + 1) / atlas.rows);
  };
  showFace('idle');

  const p = new THREE.Vector3();
  return {
    legs,
    /** Shows a firmware face; 'idle' blinks on its own (see tick). */
    face(name: string) { faceName = name; showFace(name === 'idle' ? 'idle' : name); },
    /** Lowest point of the robot in the current pose, CAD y (call after pose()). */
    ground() {
      cad.updateMatrixWorld(true);
      cadInv.copy(cad.matrixWorld).invert();
      let y = BELLY;
      for (const leg of legs) for (const c of leg.contacts) y = Math.min(y, p.copy(c).applyMatrix4(leg.knee.group.matrixWorld).applyMatrix4(cadInv).y);
      return y;
    },
    /** Applies a pose and turns the props. `time` drives the idle blink. */
    pose(pose: DronePose, time: number, dt: number) {
      const blur = THREE.MathUtils.smoothstep(pose.rps, 6, 14);
      blurMat.opacity = blur * 0.55;
      legs.forEach((leg, i) => {
        leg.hip.set((pose.hips[i] ?? 0) * leg.fwdSign);
        setKnee(leg, pose.fold, pose.lift[i] ?? 0);
        // past the blur point the blades are drawn as the disc, turning slowly so the frames do not strobe
        leg.angle += (blur > 0.5 ? 0.6 : pose.rps) * Math.PI * 2 * dt * leg.def.spin;
        leg.prop.set(leg.angle);
        for (const o of leg.propObj) o.visible = blur < 0.9;
        leg.disc.visible = blur > 0;
      });
      if (faceName === 'idle') showFace(IDLE[Math.floor(time * 7) % IDLE.length]);
    },
  };
}
