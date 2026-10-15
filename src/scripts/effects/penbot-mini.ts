// PenBot Mini: the credit-card sized five-bar plotter from its Fusion rig sits on a sheet of paper and draws the
// same line art as PenBot, with its cheap servos' charming wobble. Finished sheets are pulled out from under it
// and tossed onto a pile.
//
// Linkage (checked against the export geometry, CAD mm, Y up, linkage in the XZ plane). The export holds two
// linkage sets: crank1_1 / link1_1 ... is an older, shorter skeleton and is skipped by the converter; the real one
// (crank1_1_1 ...) matches the photos: two servos at A1 = (18, 31.4) and A2 = (18, 6) drive 50.8 mm cranks, two
// 50.8 mm links meet at J3, and link1 carries on 19.05 mm (3/4 in) past J3 to the pen clip. The Sharpie is added here.
// Rig built with:
//   node scripts/fusion.mjs <Penbotmini-nexp> public/rigs/penbot-mini --ratio 0.25 --error 0.001 --min-size 0.004
//     --min-body 0.002 --skip "^(crank|link)\d_1$|proto-board|SG90_-_Micro|XIAO"
//
// ?pendebug prints pin gaps / tip error as a page warning.

import * as THREE from '../three-lite';
import { loadFusionRig } from './fusion-rig';
import { ART_NAMES, Carrier, layout, mergeGeometries, PenPath, pinCheck, Sheets, Wobble } from './plotter';
import type { EffectContext, Effect } from './types';

const A1 = [0.018, 0.0314];
const A2 = [0.018, 0.006];
const L = 0.0508;
const EXT = 0.01905; // pen past J3 along link1
const J1R = [0.06259, 0.05573];
const J2R = [0.05634, -0.02732];
const J3R = [0.08847, 0.01202];
const PIN_Y = 0.03;
const FLOOR = -0.0063; // bottom of the rubber shoe
const SHEET_T = 0.0006;
const TILT_AT = [-0.0476, FLOOR, 0]; // the robot rocks on the back edge of its shoe to lift the pen
const TILT_UP = 0.026;
const DRAW_TIME = 4.2;
const CENTER = [0.1, 0.014]; // middle of the comfortable workspace (x, z)
const PARK = [0.1, 0.0];

/** One intersection of two circles in the XZ plane; `side` picks which. Writes into out, false if none. */
function meet(ax: number, az: number, ar: number, bx: number, bz: number, br: number, side: number, out: number[]) {
  const dx = bx - ax, dz = bz - az;
  const d = Math.hypot(dx, dz);
  if (d > ar + br || d < Math.abs(ar - br) || d < 1e-9) return false;
  const a = (ar * ar - br * br + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(ar * ar - a * a, 0));
  out[0] = ax + (a * dx) / d - (side * h * dz) / d;
  out[1] = az + (a * dz) / d + (side * h * dx) / d;
  return true;
}

function sharpie() {
  const body = new THREE.MeshStandardMaterial({ color: 0x8e939b, roughness: 0.35, metalness: 0.4 });
  const black = new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.5 });
  const cyl = (r0: number, r1: number, y0: number, y1: number, seg = 20) => new THREE.CylinderGeometry(r1, r0, y1 - y0, seg).translate(0, (y0 + y1) / 2, 0);
  const g = new THREE.Group();
  g.add(new THREE.Mesh(mergeGeometries([cyl(0.0048, 0.0048, 0.022, 0.08)]), body));
  const clip = new THREE.BoxGeometry(0.0016, 0.026, 0.003).translate(0, 0.09, 0.0058);
  g.add(new THREE.Mesh(mergeGeometries([
    cyl(0.0006, 0.0008, 0, 0.0025, 10), cyl(0.0011, 0.0042, 0.0025, 0.009), cyl(0.0048, 0.0048, 0.009, 0.022),
    cyl(0.0056, 0.0056, 0.072, 0.104), cyl(0.0056, 0.0035, 0.104, 0.107), clip,
  ]), black));
  return g;
}

export default async function penbotMini(ctx: EffectContext): Promise<Effect> {
  ctx.model.visible = false;
  const rig = await loadFusionRig(ctx, '/rigs/penbot-mini', 'y');
  // the robot, its sheet and the pile behind it: CAD x -0.05..0.13, z -0.19..0.08
  const s = 9.5;
  rig.root.scale.setScalar(s);
  rig.root.position.set(-0.04 * s, -FLOOR * s, 0.055 * s);
  ctx.body.add(rig.root);
  ctx.pickable(rig.root);

  // the Sharpie, standing in the clip at the end of link1 with its tip at the shoe's floor (the robot stands on the sheet)
  const pen = sharpie();
  const penRest = [J3R[0] + ((J3R[0] - J1R[0]) * EXT) / L, FLOOR, J3R[1] + ((J3R[1] - J1R[1]) * EXT) / L]; // tip, in the rest pose
  pen.position.fromArray(penRest);
  rig.scene.add(pen);

  // joints: everything rides the tilt pivot, the cranks turn about -Y so angles grow like atan2(z, x)
  const AX = [0, -1, 0];
  const tilt = rig.pivot(rig.info.occurrences.map((o) => o.id), TILT_AT, [0, 0, 1]);
  const crank1 = rig.pivot(['crank1_1_1'], [A1[0], PIN_Y, A1[1]], AX, tilt.group);
  const crank2 = rig.pivot(['crank2_1_1'], [A2[0], PIN_Y, A2[1]], AX, tilt.group);
  const link1 = rig.pivot(['link1_1_1', pen], [J1R[0], PIN_Y, J1R[1]], AX, tilt.group);
  const link2 = rig.pivot(['link2_1_1'], [J2R[0], PIN_Y, J2R[1]], AX, tilt.group);
  const ang = (x: number, z: number) => Math.atan2(z, x);
  const rest = {
    c1: ang(J1R[0] - A1[0], J1R[1] - A1[1]), c2: ang(J2R[0] - A2[0], J2R[1] - A2[1]),
    l1: ang(J3R[0] - J1R[0], J3R[1] - J1R[1]), l2: ang(J3R[0] - J2R[0], J3R[1] - J2R[1]),
  };
  // which of the two J3 solutions the real linkage uses (the one in the CAD pose)
  const tmp = [0, 0];
  meet(J1R[0], J1R[1], L, J2R[0], J2R[1], L, 1, tmp);
  const J3_SIDE = Math.hypot(tmp[0] - J3R[0], tmp[1] - J3R[1]) < 1e-3 ? 1 : -1;

  // ?pendebug: pin gaps and the clip position against the solved pen tip (printed as a warning)
  const pins = pinCheck(rig.scene, rig.part, [
    ['crank1_1_1', 'Frame_1', [A1[0], PIN_Y, A1[1]]], ['crank2_1_1', 'Frame_1', [A2[0], PIN_Y, A2[1]]],
    ['crank1_1_1', 'link1_1_1', [J1R[0], PIN_Y, J1R[1]]], ['crank2_1_1', 'link2_1_1', [J2R[0], PIN_Y, J2R[1]]],
    ['link1_1_1', 'link2_1_1', [J3R[0], PIN_Y, J3R[1]]],
  ], 1);
  const clip = new Carrier(rig.scene, rig.part('link1_1_1')!);
  const penTip = new Carrier(rig.scene, pen);

  // servo state: commanded (after the deadband) and actual angles
  const servo = { c1: rest.c1, c2: rest.c2, a1: rest.c1, a2: rest.c2 };
  const J1 = [0, 0], J2 = [0, 0], J3 = [0, 0];
  /** Closed-form IK for the pen point (x, z) -> crank angles (keeps the CAD elbow configuration). */
  const solve = (x: number, z: number) => {
    if (!meet(A1[0], A1[1], L, x, z, L + EXT, 1, J1)) return;
    const k = L / (L + EXT);
    const jx = J1[0] + (x - J1[0]) * k, jz = J1[1] + (z - J1[1]) * k;
    if (!meet(A2[0], A2[1], L, jx, jz, L, -1, J2)) return;
    const t1 = ang(J1[0] - A1[0], J1[1] - A1[1]), t2 = ang(J2[0] - A2[0], J2[1] - A2[1]);
    // cheap hobby servos: nothing happens until the error passes the deadband
    const band = 0.011;
    if (Math.abs(t1 - servo.c1) > band) servo.c1 = t1;
    if (Math.abs(t2 - servo.c2) > band) servo.c2 = t2;
  };
  const tip = { x: 0, z: 0 };
  /** Places every link from the actual servo angles (forward kinematics), so the chain always closes. */
  const pose = () => {
    J1[0] = A1[0] + L * Math.cos(servo.a1); J1[1] = A1[1] + L * Math.sin(servo.a1);
    J2[0] = A2[0] + L * Math.cos(servo.a2); J2[1] = A2[1] + L * Math.sin(servo.a2);
    if (!meet(J1[0], J1[1], L, J2[0], J2[1], L, J3_SIDE, J3)) return;
    crank1.set(servo.a1 - rest.c1);
    crank2.set(servo.a2 - rest.c2);
    link1.group.position.set(J1[0] - TILT_AT[0], link1.group.position.y, J1[1] - TILT_AT[2]);
    link1.set(ang(J3[0] - J1[0], J3[1] - J1[1]) - rest.l1);
    link2.group.position.set(J2[0] - TILT_AT[0], link2.group.position.y, J2[1] - TILT_AT[2]);
    link2.set(ang(J3[0] - J2[0], J3[1] - J2[1]) - rest.l2);
    tip.x = J1[0] + ((J3[0] - J1[0]) * (L + EXT)) / L;
    tip.z = J1[1] + ((J3[1] - J1[1]) * (L + EXT)) / L;
  };

  // desk frame for the sheets: x = CAD x, y = -CAD z, up = CAD y (paper surface at the shoe's floor)
  const desk = new THREE.Group();
  desk.rotation.x = -Math.PI / 2;
  desk.position.y = FLOOR;
  rig.scene.add(desk);
  const sheets = new Sheets(desk, {
    w: 0.18, h: 0.125, thick: SHEET_T, paper: new THREE.Vector3(0.04, -0.0187, 0), pile: new THREE.Vector3(0.042, 0.124, 0), cap: 12,
    ppm: 4000, ink: 0.0008, arc: 0.045,
  });
  sheets.setInk();
  ctx.pickable(sheets.group);

  const debug = new URLSearchParams(location.search).has('pendebug');
  const at = new THREE.Vector3(), at2 = new THREE.Vector3();
  let checkT = 0;
  const stats = [0, 0, Infinity, -Infinity, 0];
  const check = () => {
    if (++checkT % 15) return;
    stats[1] = Math.max(stats[1], pins());
    clip.at(penRest, at);
    penTip.at(penRest, at2);
    // clip centre and the Sharpie's tip against forward kinematics (only meaningful while the pen is down)
    if (lift === 0 && tiltA === 0) stats[0] = Math.max(stats[0], Math.hypot(at.x - tip.x, at.z - tip.z), Math.hypot(at2.x - tip.x, at2.z - tip.z));
    stats[2] = Math.min(stats[2], at2.y - (FLOOR + SHEET_T));
    stats[3] = Math.max(stats[3], at2.y - (FLOOR + SHEET_T));
    const mm = (v: number) => (v * 1000).toFixed(3);
    if (checkT % 600 === 0) console.warn(`PenBot Mini: pen tip off by ${mm(stats[0])} mm, worst pin gap ${mm(stats[1])} mm, tip height ${mm(stats[2])}..${mm(stats[3])} mm`);
  };

  const order = [...ART_NAMES].sort(() => Math.random() - 0.5);
  let next = 0;
  const path = new PenPath(0.01, 0.12, 0.15);
  path.x = PARK[0];
  path.y = -PARK[1];
  const wob = new Wobble();
  let state: 'draw' | 'park' | 'pickup' | 'swap' | 'putdown' = 'draw';
  let timer = 0;
  let lift = 0; // picked up off the paper, 0..1
  let tiltA = TILT_UP;
  const begin = () => {
    // drawing box in desk coordinates (y = -z)
    const d = layout(order[next++ % order.length], CENTER[0], -CENTER[1], 0.05, 0.044);
    path.start(d, THREE.MathUtils.clamp(d.length / DRAW_TIME, 0.01, 0.08));
    wob.reseed();
    sheets.setInk();
    state = 'draw';
  };
  begin();

  return {
    update(time, dt) {
      dt = Math.min(dt, 1 / 20);
      path.step(dt);
      timer += dt;
      if (state === 'draw' && path.phase === 'done') {
        path.goTo(PARK[0], -PARK[1]);
        state = 'park';
      } else if (state === 'park' && path.phase === 'idle') {
        state = 'pickup';
        timer = 0;
      } else if (state === 'pickup' && timer > 0.45) {
        timer = -sheets.toss(0.3);
        state = 'swap';
      } else if (state === 'swap' && timer > 0 && !sheets.busy) {
        state = 'putdown';
        timer = 0;
      } else if (state === 'putdown' && timer > 0.5) {
        begin();
      }
      const up = state === 'pickup' ? Math.min(1, timer / 0.4) : state === 'swap' ? 1 : state === 'putdown' ? 1 - Math.min(1, timer / 0.45) : 0;
      lift = up * up * (3 - 2 * up);

      // wobbly target: slow drift along the stroke plus a little servo tremor
      const sd = path.drawn * 900;
      const amp = 0.001;
      solve(path.x + wob.at(sd, 0) * amp, -(path.y + wob.at(sd, 1.7) * amp));
      const k = Math.min(1, dt * 22);
      servo.a1 += (servo.c1 - servo.a1) * k + Math.sin(time * 41.3) * 0.0006;
      servo.a2 += (servo.c2 - servo.a2) * k + Math.sin(time * 37.9 + 1) * 0.0006;
      pose();
      tiltA = TILT_UP * path.lift;
      tilt.set(tiltA + lift * 0.08);
      tilt.group.position.y = TILT_AT[1] + SHEET_T + lift * 0.085; // picked up clear of the sheet
      sheets.pen(tip.x, -tip.z, path.lift <= 0 && lift === 0);
      sheets.update(dt);
      if (debug) check();
    },
  };
}
