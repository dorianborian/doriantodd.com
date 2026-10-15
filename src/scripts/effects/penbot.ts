// PenBot Linkage Plotter: the Fusion rig of PenBot (MK6 "ultra max") draws line art on a sheet of paper in its
// canvas tray, then tosses each finished drawing onto a pile beside it.
//
// Linkage (checked against the export geometry, CAD mm, Z up): two coaxial arms turn about O = (-31.27, 19.00),
// each driven by its own stepper through a pinion. Component4 is the 100 mm arm O->B, Component2 the 60 mm arm
// O->D. Component3 (D->E, 100 mm) and Component12 (E->B, 60 mm) close a parallelogram, and Component12 carries on
// past B to the pen holder, so the pen sits at P = O + 100 u1 - 111.25 u2 (u1, u2 = arm directions).
// The pen holder rides a vertical rail (LWL7B carriage), which is the pen lift. Component9/15 are stale copies of the
// arm gears sitting off the arm axis, so the converter skips them; the root mesh flattens every body of the design,
// so its copies of the moving parts are dropped with --dedupe. Rig built with:
//   node scripts/fusion.mjs <Penbotultra-nexp> public/rigs/penbot --ratio 0.06 --error 0.004 --min-size 0.004
//     --min-body 0.005 --dedupe "^root_base$" --skip "Magnet|Component9_1|Component15_1|RASPBERRY|KCD1|XT60"
//
// ?pendebug draws a dot at the solved pen tip and prints pin gaps / tip error as a page warning.

import * as THREE from '../three-lite';
import { loadFusionRig } from './fusion-rig';
import { ART_NAMES, Carrier, layout, PenPath, pinCheck, Sheets } from './plotter';
import type { EffectContext, Effect } from './types';

const O = [-0.03127, 0.019];
const ARM_A = 0.1; // O -> B (Component4)
const ARM_C = 0.06; // O -> D (Component2)
const PEN = 0.11125; // B -> pen axis along Component12
const PINION = [-0.0942, 0.019];
const PINION_RATIO = 3; // big gear on each arm vs the motor pinion
const TRAY_Z = -0.0618; // floor of the 6 x 4 in canvas recess
const PAPER = new THREE.Vector3(-0.0165, -0.1122, TRAY_Z);
const SHEET_T = 0.0008;
const TIP_REST_Z = -0.0453;
// The lead-screw height adjust sits the arms a little lower than in the export so the pen reaches the paper
// within the rail's travel; the carriage then moves the pen 9 mm between up and down.
const CARRIAGE_DOWN = -0.007;
const CARRIAGE_UP = 0.002;
const STACK_DROP = TRAY_Z + SHEET_T - (TIP_REST_Z + CARRIAGE_DOWN); // negative
const PARK = [0.045, -0.045];
const DRAW_TIME = 4.2; // seconds per drawing, roughly

export default async function penbot(ctx: EffectContext): Promise<Effect> {
  ctx.model.visible = false;
  const rig = await loadFusionRig(ctx, '/rigs/penbot');
  const ground = rig.info.occurrences.find((o) => o.id === 'root_base')?.bbox[0][2] ?? -0.0642;
  // robot plus the pile spot: CAD x -0.268..0.096, y -0.167..0.094
  const s = 7.2;
  rig.root.scale.setScalar(s);
  rig.root.position.set(0.0855 * s, -ground * s, -0.0365 * s);
  ctx.body.add(rig.root);
  ctx.pickable(rig.root);

  // joints (all in the CAD frame; the stack holds everything that the height adjust moves)
  const Z = [0, 0, 1];
  const stack = rig.pivot([], [0, 0, 0], Z);
  const armA = rig.pivot(['Component4_1'], [O[0], O[1], 0], Z, stack.group);
  const armC = rig.pivot(['Component2_1'], [O[0], O[1], 0], Z, stack.group);
  const linkDE = rig.pivot(['Component3_1'], [O[0], O[1] + ARM_C, 0], Z, stack.group);
  const linkEB = rig.pivot(['Component12_1', 'Component11_1', 'LinearRail-LWL7B-100mm_1'], [O[0] + ARM_A, O[1], 0], Z, stack.group);
  const carriage = rig.pivot(['Carriage-LWL7B_1', 'Component16_1', 'Component14_1', 'Sharpie_Pen_1'], [O[0] + ARM_A, O[1], 0], Z, linkEB.group);
  // ?pendebug: pin gaps of the closed chain and the Sharpie's real tip against the solved one (printed as a warning)
  const PEN_REST = [O[0] + ARM_A, O[1] - PEN, TIP_REST_Z];
  const pins = pinCheck(rig.scene, rig.part, [
    ['Component4_1', 'root_base', [O[0], O[1], 0]], ['Component2_1', 'root_base', [O[0], O[1], 0]],
    ['Component2_1', 'Component3_1', [O[0], O[1] + ARM_C, 0]], ['Component3_1', 'Component12_1', [O[0] + ARM_A, O[1] + ARM_C, 0]],
    ['Component4_1', 'Component12_1', [O[0] + ARM_A, O[1], 0]],
  ], 2);
  const sharpie = new Carrier(rig.scene, rig.part('Sharpie_Pen_1')!);
  const at = new THREE.Vector3();
  let checkT = 0;
  const stats = [0, 0, Infinity, -Infinity];
  const checkTip = (x: number, y: number) => {
    if (++checkT % 15) return;
    rig.scene.updateMatrixWorld(true);
    sharpie.at(PEN_REST, at);
    stats[0] = Math.max(stats[0], Math.hypot(at.x - x, at.y - y));
    stats[1] = Math.max(stats[1], pins());
    stats[2] = Math.min(stats[2], at.z - (TRAY_Z + SHEET_T));
    stats[3] = Math.max(stats[3], at.z - (TRAY_Z + SHEET_T));
    const mm = (v: number) => (v * 1000).toFixed(3);
    if (checkT % 600 === 0) console.warn(`PenBot: pen tip off by ${mm(stats[0])} mm, worst pin gap ${mm(stats[1])} mm, tip height ${mm(stats[2])}..${mm(stats[3])} mm`);
  };

  stack.group.position.z = STACK_DROP;
  const pinionC = rig.pivot(['2664N353_Metal_Gear_-_20_Degree_Pressure_Angle_1'], [PINION[0], PINION[1], 0], Z);
  const pinionA = rig.pivot(['2664N353_Metal_Gear_-_20_Degree_Pressure_Angle_2'], [PINION[0], PINION[1], 0], Z);

  let th1 = 0, th2 = Math.PI / 2;
  /** Closed-form IK: pen target (x, y) -> arm angles. Keeps the elbow on the same side as the CAD pose. */
  const solve = (x: number, y: number) => {
    const dx = x - O[0], dy = y - O[1];
    const c = (dx * dx + dy * dy - ARM_A * ARM_A - PEN * PEN) / (2 * ARM_A * PEN);
    if (c < -1 || c > 1) return;
    const g = -Math.acos(c); // angle from arm A to the pen direction (B -> pen)
    th1 = Math.atan2(dy, dx) - Math.atan2(PEN * Math.sin(g), ARM_A + PEN * Math.cos(g));
    th2 = th1 + g + Math.PI; // arm C points opposite the pen direction (parallelogram)
  };
  const tip = { x: 0, y: 0 };
  const pose = (lift: number) => {
    const c1 = Math.cos(th1), s1 = Math.sin(th1), c2 = Math.cos(th2), s2 = Math.sin(th2);
    armA.set(th1);
    armC.set(th2 - Math.PI / 2);
    linkDE.group.position.set(O[0] + ARM_C * c2, O[1] + ARM_C * s2, 0);
    linkDE.set(th1);
    linkEB.group.position.set(O[0] + ARM_A * c1, O[1] + ARM_A * s1, 0);
    linkEB.set(th2 - Math.PI / 2);
    carriage.group.position.z = CARRIAGE_DOWN + (CARRIAGE_UP - CARRIAGE_DOWN) * lift;
    pinionA.set(-th1 * PINION_RATIO);
    pinionC.set(-(th2 - Math.PI / 2) * PINION_RATIO);
    // forward kinematics: where the pen really is
    tip.x = O[0] + ARM_A * c1 - PEN * c2;
    tip.y = O[1] + ARM_A * s1 - PEN * s2;
  };

  const sheets = new Sheets(rig.scene, {
    w: 0.148, h: 0.098, thick: SHEET_T, paper: PAPER, pile: new THREE.Vector3(-0.186, -0.112, ground), cap: 12,
    ppm: 512 / 0.148, ink: 0.0009, arc: 0.07,
  });
  sheets.setInk();
  ctx.pickable(sheets.group);

  const debug = new URLSearchParams(location.search).has('pendebug');
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0018, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff2040, depthTest: false }));
  dot.renderOrder = 10;
  dot.visible = debug;
  rig.scene.add(dot);

  const order = [...ART_NAMES].sort(() => Math.random() - 0.5);
  let next = 0;
  const path = new PenPath(0.1, 0.35, 0.12);
  path.x = PARK[0];
  path.y = PARK[1];
  let state: 'draw' | 'park' | 'swap' = 'draw';
  let wait = 0;
  const begin = () => {
    const d = layout(order[next++ % order.length], PAPER.x, PAPER.y, 0.124, 0.074);
    path.start(d, THREE.MathUtils.clamp(d.length / DRAW_TIME, 0.04, 0.25));
    sheets.setInk();
    state = 'draw';
  };
  begin();

  return {
    update(_time, dt) {
      dt = Math.min(dt, 1 / 20);
      path.step(dt);
      if (state === 'draw' && path.phase === 'done') {
        path.goTo(PARK[0], PARK[1]);
        state = 'park';
      } else if (state === 'park' && path.phase === 'idle') {
        wait = sheets.toss(0.45) + 0.15;
        state = 'swap';
      } else if (state === 'swap' && (wait -= dt) <= 0 && !sheets.busy) {
        begin();
      }
      solve(path.x, path.y);
      pose(path.lift);
      sheets.pen(tip.x, tip.y, path.lift <= 0);
      sheets.update(dt);
      if (debug) {
        dot.position.set(tip.x, tip.y, TRAY_Z + SHEET_T + 0.001);
        checkTip(tip.x, tip.y);
      }
    },
  };
}
