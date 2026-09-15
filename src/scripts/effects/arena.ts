// Combat Robotics: Executioner drives around a small arena (steel floor, hazard border, clear
// polycarbonate walls) and keeps attacking the same washing machine. Every hit throws sparks and
// knocks a panel loose; once it's in pieces, the parts slowly pull themselves back together.

import * as THREE from '../three-lite';
import { makeBody, step, type Body, type World } from './physics';
import { damp, glowMaterial, rand, turnToward, wrapAngle } from './shared';
import type { EffectContext, Effect } from './types';

/** Executioner's weapon side faces -z in the model, so the drive heading is flipped. */
const FRONT = Math.PI;

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

type Piece = {
  mesh: THREE.Mesh;
  /** Offset and rotation relative to the machine when assembled. */
  home: THREE.Vector3;
  homeQ: THREE.Quaternion;
  half: THREE.Vector3;
  body: Body | null;
};

type Kind = 'washer' | 'stove' | 'fridge' | 'microwave' | 'miku' | 'toaster' | 'crt' | 'trash' | 'heater' | 'arcade' | 'duck' | 'cone' | 'gnome' | 'tower' | 'vending' | 'lamp' | 'tank' | 'printer';
// appliances first, with the easter eggs mixed in between
const LINEUP: Kind[] = ['washer', 'toaster', 'stove', 'duck', 'crt', 'fridge', 'cone', 'microwave', 'tower', 'gnome', 'heater', 'arcade', 'trash', 'tank', 'printer', 'vending', 'lamp', 'miku'];

/** Appliances built from separate parts so they can come apart. The last part stays with the chassis. */
function appliance(kind: Kind) {
  const std = (color: number, roughness = 0.4, metalness = 0.1) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const pieces: Piece[] = [];
  const add = (obj: THREE.Mesh, pos: [number, number, number], rot?: THREE.Euler) => {
    if (rot) obj.rotation.copy(rot);
    const bb = new THREE.Box3().setFromObject(obj, true);
    obj.rotation.set(0, 0, 0);
    const half = bb.getSize(new THREE.Vector3()).multiplyScalar(0.5).max(new THREE.Vector3(0.01, 0.01, 0.01));
    pieces.push({ mesh: obj, home: new THREE.Vector3(...pos), homeQ: new THREE.Quaternion().setFromEuler(rot ?? new THREE.Euler()), half, body: null });
    return obj;
  };
  const box = (w: number, h: number, d: number, mat: THREE.Material, pos: [number, number, number]) => add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat), pos);
  const t = 0.018;
  /** top, sides and back of a cabinet */
  const shell = (w: number, h: number, d: number, mat: THREE.Material, top: THREE.Material = mat) => {
    box(w, t, d, top, [0, h / 2 - t / 2, 0]);
    box(t, h, d, mat, [-w / 2 + t / 2, 0, 0]);
    box(t, h, d, mat, [w / 2 - t / 2, 0, 0]);
    box(w, h, t, mat, [0, 0, -d / 2 + t / 2]);
  };
  const base = (w: number, d: number, h: number, mat: THREE.Material) => box(w, t * 2, d, mat, [0, -h / 2 + t, 0]);
  let w = 0.3, h = 0.36, d = 0.3;

  if (kind === 'washer') {
    const white = std(0xf2f3f5, 0.35), grey = std(0x9aa3ad), chrome = std(0xc8ced6, 0.25, 0.7);
    shell(w, h, d, white);
    box(w, h * 0.16, t * 1.6, grey, [0, h * 0.4, d / 2 - t * 0.2]);
    const door = add(new THREE.Mesh(new THREE.CylinderGeometry(w * 0.28, w * 0.28, 0.012, 28).rotateX(Math.PI / 2), std(0x223a55, 0.05, 0.2)), [0, -h * 0.06, d / 2 + 0.01]);
    door.add(new THREE.Mesh(new THREE.TorusGeometry(w * 0.3, 0.018, 12, 28), chrome));
    add(new THREE.Mesh(new THREE.CylinderGeometry(w * 0.34, w * 0.34, d * 0.8, 24).rotateX(Math.PI / 2), std(0x7d8691, 0.3, 0.8)), [0, -h * 0.06, 0]);
    base(w, d, h, grey);
  } else if (kind === 'stove') {
    w = 0.32; h = 0.34;
    const yellow = std(0xf2c230, 0.35), black = std(0x17181a, 0.5), coil = std(0x3a3c40, 0.4, 0.6);
    shell(w, h, d, yellow, black);
    const top = pieces[0].mesh;
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const burner = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.008, 8, 20).rotateX(Math.PI / 2), coil);
      burner.position.set(x * w * 0.24, t / 2 + 0.004, z * d * 0.22);
      top.add(burner);
    }
    box(w, 0.07, t, yellow, [0, h / 2 + 0.035, -d / 2 + t / 2]); // backsplash
    const oven = box(w - t * 2, h * 0.62, t, yellow, [0, -h * 0.12, d / 2 - t / 2]);
    const win = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.6, h * 0.28), black);
    win.position.z = t / 2 + 0.002;
    oven.add(win);
    box(w - t * 2, h * 0.14, t, black, [0, h * 0.34, d / 2 - t / 2]); // knob panel
    base(w, d, h, black);
  } else if (kind === 'fridge') {
    w = 0.28; h = 0.6; d = 0.28;
    const silver = std(0xc9ced4, 0.28, 0.65), chrome = std(0xe8ecf0, 0.15, 0.9), inner = std(0xf4f7fb, 0.6);
    shell(w, h, d, silver);
    const upper = box(w, h * 0.34, t * 1.5, silver, [0, h * 0.32, d / 2 - t / 2]);
    const lower = box(w, h * 0.6, t * 1.5, silver, [0, -h * 0.18, d / 2 - t / 2]);
    for (const [door, y] of [[upper, -h * 0.08], [lower, h * 0.18]] as const) {
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.015, h * 0.14, 0.02), chrome);
      handle.position.set(w * 0.38, y, t * 1.2);
      door.add(handle);
    }
    box(w - t * 2, t, d * 0.8, inner, [0, 0, 0]); // shelves
    box(w - t * 2, t, d * 0.8, inner, [0, h * 0.2, 0]);
    base(w, d, h, silver);
  } else if (kind === 'microwave') {
    h = 0.18; d = 0.22;
    const black = std(0x151619, 0.35, 0.2), glass = std(0x2c3440, 0.05, 0.3), grey = std(0x3b3f45, 0.4);
    shell(w, h, d, black);
    const door = box(w * 0.7, h - t, t, black, [-w * 0.15, 0, d / 2 - t / 2]);
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.52, h * 0.6), glass);
    pane.position.z = t / 2 + 0.002;
    door.add(pane);
    box(w * 0.3, h - t, t, grey, [w * 0.35, 0, d / 2 - t / 2]);
    add(new THREE.Mesh(new THREE.CylinderGeometry(w * 0.3, w * 0.3, 0.008, 24), std(0xdde6ee, 0.05, 0.1)), [0, -h / 2 + t * 2.5, 0]);
    base(w, d, h, black);
  } else if (kind === 'toaster') {
    w = 0.26; h = 0.18; d = 0.16;
    const chrome = std(0xd9dde2, 0.18, 0.9), black = std(0x1b1c1f, 0.6);
    shell(w, h, d, chrome);
    const slots = pieces[0].mesh;
    for (const z of [-0.035, 0.035]) { const slot = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 0.004, 0.018), black); slot.position.set(0, t / 2 + 0.002, z); slots.add(slot); }
    box(w - t * 2, h - t, t, chrome, [0, 0, d / 2 - t / 2]);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.025, 0.03), black), [w / 2 + 0.015, h * 0.2, 0]); // lever
    for (const z of [-0.035, 0.035]) add(new THREE.Mesh(new THREE.BoxGeometry(w * 0.6, 0.09, 0.012), std(0xc98b4a, 0.9)), [0, h / 2 + 0.03, z]); // toast
    base(w, d, h, black);
  } else if (kind === 'crt') {
    w = 0.3; h = 0.26; d = 0.28;
    const beige = std(0xd8cfb8, 0.7), glass = std(0x1d2a2a, 0.08, 0.3), dark = std(0x2a2a2a, 0.6);
    shell(w, h, d, beige);
    const screen = box(w - t * 2, h - t * 2, t, beige, [0, 0, d / 2 - t / 2]);
    const tube = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.72, h * 0.62), glass);
    tube.position.z = t / 2 + 0.002; tube.position.y = h * 0.06;
    screen.add(tube);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.012, 10).rotateX(Math.PI / 2), dark), [w * 0.32, -h * 0.36, d / 2 + 0.006]);
    add(new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, h * 0.7, d * 0.6), dark), [0, 0, -d * 0.1]); // the tube inside
    base(w, d, h, beige);
  } else if (kind === 'trash') {
    w = 0.22; h = 0.34; d = 0.22;
    const green = std(0x3f6b4a, 0.55, 0.3), lid = std(0x2f5238, 0.5, 0.3);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.1, 0.02, 20), lid), [0, h / 2 - 0.01, 0]);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      add(new THREE.Mesh(new THREE.BoxGeometry(0.15, h * 0.9, 0.012), green), [Math.sin(a) * 0.1, 0, Math.cos(a) * 0.1], new THREE.Euler(0, a, 0));
    }
    add(new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), std(0xe9e4d8, 0.9)), [0, h * 0.1, 0]); // paper ball
    base(w, d, h, lid);
  } else if (kind === 'heater') {
    w = 0.22; h = 0.55; d = 0.22;
    const white = std(0xeef0f2, 0.4), copper = std(0xb87333, 0.35, 0.8);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.03, 20), white), [0, h / 2 - 0.015, 0]);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, h * 0.8, 20, 1, true), white), [0, 0, 0]);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, h * 0.7, 16), std(0x7d8691, 0.35, 0.7)), [0, 0, 0]);
    for (const x of [-0.04, 0.04]) add(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.12, 8), copper), [x, h / 2 + 0.05, 0]);
    base(w, d, h, white);
  } else if (kind === 'arcade') {
    w = 0.26; h = 0.6; d = 0.28;
    const purple = std(0x3b1f6b, 0.5), black = std(0x111214, 0.6), neon = new THREE.MeshBasicMaterial({ color: 0x29f0ff, toneMapped: false });
    shell(w, h, d, purple);
    const bezel = box(w - t * 2, h * 0.3, t, black, [0, h * 0.14, d / 2 - t / 2]);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.66, h * 0.22), new THREE.MeshBasicMaterial({ color: 0x6b2cff, toneMapped: false }));
    screen.position.z = t / 2 + 0.002;
    bezel.add(screen);
    const marquee = box(w, h * 0.1, t * 1.5, black, [0, h * 0.42, d / 2 - t]);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.8, h * 0.05), neon);
    sign.position.z = t;
    marquee.add(sign);
    const panel = box(w, 0.03, 0.12, black, [0, -h * 0.05, d / 2 + 0.03]);
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.05, 6), black);
    stick.position.set(-0.05, 0.035, 0);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.016, 10, 8), std(0xe5484d, 0.4));
    ball.position.set(-0.05, 0.06, 0);
    panel.add(stick, ball);
    for (const x of [0.02, 0.06, 0.1]) { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.01, 12), std(x > 0.05 ? 0xffd166 : 0x4a9bff, 0.4)); b.position.set(x - 0.02, 0.018, 0); panel.add(b); }
    base(w, d, h, black);
  } else if (kind === 'duck') {
    // easter egg: a giant rubber duck
    w = 0.3; h = 0.34; d = 0.34;
    const yellow = std(0xffd23f, 0.35), orange = std(0xff8c1a, 0.4), black = std(0x111111, 0.3);
    add(new THREE.Mesh(new THREE.SphereGeometry(0.15, 20, 14).scale(1, 0.75, 1.15), yellow), [0, -h * 0.12, 0]);
    const head = add(new THREE.Mesh(new THREE.SphereGeometry(0.09, 18, 14), yellow), [0, h * 0.2, 0.08]);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.07, 12).rotateX(Math.PI / 2), orange);
    beak.position.set(0, -0.01, 0.1);
    head.add(beak);
    for (const x of [-0.04, 0.04]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), black); e.position.set(x, 0.025, 0.075); head.add(e); }
    add(new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8).scale(1, 0.6, 1.4), yellow), [0, -h * 0.02, -0.15]); // tail
    base(w * 0.6, d * 0.6, h, yellow);
  } else if (kind === 'cone') {
    // easter egg: a traffic cone, knocked over in one hit
    w = 0.22; h = 0.36; d = 0.22;
    const orange = std(0xff6a13, 0.5), white = std(0xf4f4f4, 0.5);
    add(new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.12, 16, 1, true), orange), [0, h * 0.28, 0]);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.08, 16, 1, true), white), [0, h * 0.06, 0]);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.1, 0.12, 16, 1, true), orange), [0, -h * 0.17, 0]);
    base(w, d, h, std(0x222222, 0.8));
  } else if (kind === 'gnome') {
    // easter egg: a garden gnome
    w = 0.2; h = 0.4; d = 0.2;
    const red = std(0xd62828, 0.6), blue = std(0x2b59c3, 0.6), skin = std(0xf1c6a7, 0.8), beardM = std(0xf7f7f2, 0.9);
    add(new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 16), red), [0, h * 0.33, 0]);
    add(new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 10), skin), [0, h * 0.13, 0.01]);
    add(new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.1, 14).rotateX(Math.PI), beardM), [0, h * 0.02, 0.04]);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.14, 14), blue), [0, -h * 0.17, 0]);
    base(w * 0.8, d * 0.8, h, std(0x5b3a1e, 0.9));
  } else if (kind === 'tower') {
    w = 0.14; h = 0.36; d = 0.3;
    const black = std(0x141518, 0.45, 0.4), rgb = new THREE.MeshBasicMaterial({ color: 0xff3df2, toneMapped: false }), glass = std(0x223040, 0.05, 0.2);
    shell(w, h, d, black);
    const side = box(t, h - t * 2, d - t * 2, glass, [w / 2 + t / 2, 0, 0]);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.004, h * 0.8, 0.006), rgb);
    strip.position.set(-0.01, 0, d * 0.4);
    side.add(strip);
    for (const y of [0.1, -0.02]) add(new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.006, 8, 20), rgb), [0, y, d / 2 + 0.004]); // fans
    add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.2), std(0x2e7d32, 0.5)), [0, 0.02, -0.02]); // graphics card
    base(w, d, h, black);
  } else if (kind === 'vending') {
    w = 0.32; h = 0.62; d = 0.26;
    const red = std(0xc1121f, 0.4, 0.2), glass = std(0x9fc5e8, 0.05, 0.1), dark = std(0x1a1a1a, 0.5);
    shell(w, h, d, red);
    const front = box(w * 0.64, h * 0.75, t, glass, [-w * 0.14, h * 0.08, d / 2 - t / 2]);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
      const can = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.05, 10), std([0xe63946, 0x2a9d8f, 0xf4a261][c], 0.4, 0.4));
      can.position.set((c - 1) * 0.06, (r - 1.5) * 0.1, -0.03);
      front.add(can);
    }
    box(w * 0.3, h * 0.75, t, dark, [w * 0.33, h * 0.08, d / 2 - t / 2]);
    base(w, d, h, dark);
  } else if (kind === 'lamp') {
    w = 0.22; h = 0.5; d = 0.22;
    const brass = std(0xb08d57, 0.35, 0.8), shade = std(0xf2e8cf, 0.9), glow = new THREE.MeshBasicMaterial({ color: 0xfff1c1, toneMapped: false });
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.11, 0.16, 20, 1, true), shade), [0, h * 0.3, 0]);
    add(new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 10), glow), [0, h * 0.22, 0]);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, h * 0.6, 8), brass), [0, -h * 0.05, 0]);
    base(w * 0.7, d * 0.7, h, brass);
  } else if (kind === 'tank') {
    // easter egg: a tiny fridge tank, googly eyes and all
    w = 0.22; h = 0.3; d = 0.28;
    const red = std(0xd62828, 0.35, 0.1), black = std(0x151515, 0.7), white = std(0xffffff, 0.3);
    shell(w, h * 0.8, d, red);
    const door = box(w - t, h * 0.8 - t, t, red, [0, 0, d / 2 - t / 2]);
    for (const x of [-0.05, 0.05]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.03, 14, 10), white);
      eye.position.set(x, 0.05, 0.02);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 8), black);
      pupil.position.set(x + 0.006, 0.045, 0.045);
      door.add(eye, pupil);
    }
    for (const x of [-1, 1]) add(new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, d * 1.05), black), [x * (w / 2 + 0.02), -h * 0.4, 0]); // treads
    base(w, d, h * 0.8, black);
  } else if (kind === 'printer') {
    w = 0.3; h = 0.16; d = 0.26;
    const grey = std(0xe6e6e6, 0.6), dark = std(0x333333, 0.5), paper = std(0xffffff, 0.9);
    shell(w, h, d, grey);
    box(w - t * 2, h * 0.4, t, dark, [0, -h * 0.15, d / 2 - t / 2]);
    add(new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 0.004, 0.2), paper), [0, h / 2 + 0.02, -0.02], new THREE.Euler(-0.5, 0, 0));
    add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.01, 0.03), std(0x57ab5a, 0.4)), [w * 0.35, h / 2 + 0.005, d * 0.35]);
    base(w, d, h, dark);
  } else {
    // plush Miku: big head, teal twin tails, grey outfit, sitting
    w = 0.26; h = 0.36; d = 0.18;
    const skin = std(0xf7e6d8, 0.9), teal = std(0x39c5bb, 0.85), grey = std(0x6b7078, 0.9), dark = std(0x24262b, 0.9), pink = std(0xe8457a, 0.8);
    const head = add(new THREE.Mesh(new THREE.SphereGeometry(0.085, 20, 16), skin), [0, h * 0.2, 0]);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.091, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), teal);
    hair.rotation.x = -0.35;
    head.add(hair);
    for (const x of [-0.03, 0.03]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), std(0x1f6f8b, 0.4));
      eye.position.set(x, -0.005, 0.08);
      head.add(eye);
    }
    for (const side of [-1, 1]) {
      add(new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.2, 4, 10), teal), [side * 0.11, h * 0.02, -0.02], new THREE.Euler(0, 0, side * 0.35));
      add(new THREE.Mesh(new THREE.CapsuleGeometry(0.022, 0.06, 4, 8), skin), [side * 0.065, -h * 0.2, 0.03], new THREE.Euler(0.4, 0, side * 0.5));
    }
    const body = add(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.07, 0.1, 16), grey), [0, -h * 0.17, 0]);
    const tie = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.05, 0.01), teal);
    tie.position.set(0, 0.015, 0.055);
    body.add(tie);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.02, 0.02), pink), [0, h * 0.3, -0.04]); // hair ties
    add(new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.04, 0.12), dark), [0, -h / 2 + 0.02, 0.02]); // legs and boots, stays
  }
  return { pieces, half: new THREE.Vector3(w / 2, h / 2, d / 2) };
}

export default function arena(ctx: EffectContext): Effect {
  const SCALE = 0.3;
  ctx.model.scale.setScalar(SCALE);
  const bot = new THREE.Box3().setFromObject(ctx.model, true);
  const botSize = bot.getSize(new THREE.Vector3());
  const botRadius = Math.max(botSize.x, botSize.z) * 0.5;

  const half = ctx.foot * 0.48;

  // ------------------------------------------------------------ spinning beater bar
  // The red vertical bar at the front spins about the robot's left-right axis. A translucent cylinder of
  // moving streaks around it reads as motion blur, and its speed follows the weapon: idle, spin-up, full.
  const spinU = { uPhase: { value: 0 }, uSpeed: { value: 0 } };
  const blur = new THREE.Mesh(
    new THREE.CylinderGeometry(0.36, 0.36, 2.2, 40, 1, true).rotateZ(Math.PI / 2),
    glowMaterial({
      uniforms: spinU,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uPhase; uniform float uSpeed; varying vec2 vUv;
        void main() {
          float a = fract(vUv.x * 2.0 - uPhase);
          // two bar tips per turn, smeared wider as the weapon speeds up
          float smear = mix(0.04, 0.45, uSpeed);
          float streak = smoothstep(smear, 0.0, a) * (1.0 - smoothstep(0.0, 0.02, -a + 0.0));
          float ends = smoothstep(0.08, 0.0, min(vUv.y, 1.0 - vUv.y));
          vec3 col = mix(vec3(1.0, 0.18, 0.12), vec3(1.0, 0.85, 0.7), streak * uSpeed);
          float alpha = (streak * 0.8 + 0.06) * uSpeed * (1.0 - ends * 0.7);
          gl_FragColor = vec4(col * alpha, 0.0);
        }`,
    }),
  );
  blur.position.set(0, 0.38, -0.78);
  blur.renderOrder = 4;
  ctx.model.add(blur);
  let spin = 0.15; // 0 idle, 1 full speed
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

  // ------------------------------------------------------------ the appliance
  const world: World = { gravity: 9.8, floor: floorY, bounds: { cx: 0, cz: 0, hx: half, hz: half }, bodies: [] };
  let chassis = new THREE.Group();
  let wm = appliance('washer');
  let machine = makeBody(chassis, 'box', wm.half, { restitution: 0.3, friction: 0.8, mass: 2 });
  let attached: Piece[] = [];
  let lineup = 0;
  let brokenFor = 0;
  let dissolve = 0; // > 0 while the wreck fades away
  const spawnAppliance = (kind: Kind, drop: boolean) => {
    wm = appliance(kind);
    chassis = new THREE.Group();
    ctx.body.add(chassis);
    for (const p of wm.pieces) {
      p.mesh.position.copy(p.home);
      p.mesh.quaternion.copy(p.homeQ);
      chassis.add(p.mesh);
    }
    machine = makeBody(chassis, 'box', wm.half, { restitution: 0.3, friction: 0.8, mass: 2 });
    machine.pos.set(rand(-0.3, 0.3) * half, floorY + wm.half.y + (drop ? 1.2 : 0), rand(-0.3, 0.1) * half);
    world.bodies = [machine];
    attached = wm.pieces.slice(0, -1);
  };
  spawnAppliance('washer', false);
  const everything = () => [chassis, ...wm.pieces.map((p) => p.mesh)];

  const detach = (piece: Piece, dir: THREE.Vector2, strength: number) => {
    chassis.updateMatrixWorld(true);
    const worldPos = new THREE.Vector3();
    const worldQ = new THREE.Quaternion();
    piece.mesh.getWorldPosition(worldPos);
    piece.mesh.getWorldQuaternion(worldQ);
    const toBody = new THREE.Matrix4().copy(ctx.body.matrixWorld).invert();
    worldPos.applyMatrix4(toBody);
    ctx.body.add(piece.mesh);
    piece.mesh.position.copy(worldPos);
    piece.mesh.quaternion.copy(new THREE.Quaternion().setFromRotationMatrix(toBody).multiply(worldQ));
    const b = makeBody(piece.mesh, 'box', piece.half, { restitution: 0.35, friction: 0.7, mass: 0.4 });
    b.vel.set(dir.x * strength * rand(0.8, 1.5) + rand(-0.6, 0.6), rand(1.8, 3.4), dir.y * strength * rand(0.8, 1.5) + rand(-0.6, 0.6));
    b.ang.set(rand(-12, 12), rand(-8, 8), rand(-12, 12));
    piece.body = b;
    world.bodies.push(b);
    attached = attached.filter((x) => x !== piece);
  };

  // ------------------------------------------------------------ sparks: big bright streaks
  const SPARKS = 260;
  const sPos = new Float32Array(SPARKS * 3);
  const sVel = new Float32Array(SPARKS * 3);
  const sLife = new Float32Array(SPARKS);
  const sGeo = new THREE.BufferGeometry();
  const sAttr = new THREE.Float32BufferAttribute(sPos, 3);
  sAttr.setUsage(THREE.DynamicDrawUsage);
  sGeo.setAttribute('position', sAttr);
  for (let k = 0; k < SPARKS; k++) sPos[k * 3 + 1] = -50;
  const sparks = new THREE.Points(sGeo, new THREE.PointsMaterial({
    color: 0xffc46b, size: 0.07, sizeAttenuation: true, transparent: true, depthWrite: false, toneMapped: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  }));
  sparks.frustumCulled = false;
  ctx.body.add(sparks);
  const flash = new THREE.PointLight(0xffa640, 0, 1.6, 2);
  ctx.body.add(flash);
  let cursor = 0;
  const burst = (at: THREE.Vector3, dir: THREE.Vector2, count: number) => {
    for (let k = 0; k < count; k++) {
      const i = cursor++ % SPARKS;
      const sp = rand(1.2, 3.6);
      sPos.set([at.x, at.y, at.z], i * 3);
      sVel.set([dir.x * sp + rand(-1.4, 1.4), rand(0.6, 2.8), dir.y * sp + rand(-1.4, 1.4)], i * 3);
      sLife[i] = rand(0.3, 0.75);
    }
    flash.position.copy(at).setY(at.y + 0.1);
    flash.intensity = 4;
  };

  // ------------------------------------------------------------ robot
  const robot = { pos: new THREE.Vector2(-half * 0.5, half * 0.4), yaw: 0, speed: 0 };
  type Mode = 'roam' | 'charge' | 'recoil';
  let mode: Mode = 'roam';
  let timer = rand(1.5, 3);
  let sinceHit = 0;
  let waypoint = new THREE.Vector2(rand(-half, half) * 0.6, rand(-half, half) * 0.6);
  ctx.model.position.y = floorY;

  return {
    update(_t, dt) {
      dt = Math.min(dt, 1 / 30);
      const lim = half - botRadius;
      const mpos = new THREE.Vector2(machine.pos.x, machine.pos.z);
      const toMachine = mpos.clone().sub(robot.pos);
      // only a machine that is actually moving counts as airborne; resting jitter or an odd resting height
      // used to block charges forever
      const flying = machine.vel.lengthSq() > 0.25;
      sinceHit += dt;

      timer -= dt;
      if (mode === 'roam') {
        if (robot.pos.distanceTo(waypoint) < 0.15) waypoint = new THREE.Vector2(rand(-lim, lim) * 0.8, rand(-lim, lim) * 0.8);
        robot.yaw = turnToward(robot.yaw, Math.atan2(waypoint.x - robot.pos.x, waypoint.y - robot.pos.y), dt * 2.5);
        robot.speed += (0.4 - robot.speed) * damp(3, dt);
        if (timer <= 0 && !flying && dissolve <= 0 && attached.length) { mode = 'charge'; timer = 3.5; }
      } else if (mode === 'charge') {
        const want = Math.atan2(toMachine.x, toMachine.y);
        robot.yaw = turnToward(robot.yaw, want, dt * 3.5);
        const aligned = Math.abs(wrapAngle(want - robot.yaw)) < 0.25;
        robot.speed += ((aligned ? 1.3 : 0.1) - robot.speed) * damp(4, dt);
        const reach = botRadius + Math.max(wm.half.x, wm.half.z) * 1.35 + 0.04;
        // a pinned or awkward wreck still counts as hit when the charge runs out nearby
        if (toMachine.length() < reach || (timer <= 0 && toMachine.length() < reach * 2)) {
          const dir = toMachine.clone().normalize();
          const at = new THREE.Vector3(robot.pos.x + dir.x * botRadius, floorY + 0.12, robot.pos.y + dir.y * botRadius);
          burst(at, dir, 90);
          // a panel or two comes loose each hit; the chassis gets shoved and spun
          const loose = Math.min(attached.length, Math.round(rand(2, 3)));
          for (let k = 0; k < loose; k++) detach(attached[Math.floor(rand(0, attached.length))], dir, 1.6);
          machine.vel.set(dir.x * rand(0.9, 1.4), rand(1.2, 2), dir.y * rand(0.9, 1.4));
          machine.ang.set(rand(-4, 4), rand(-5, 5), rand(-4, 4));
          mode = 'recoil';
          timer = 0.45;
          sinceHit = 0;
          spin = Math.max(0.55, spin - 0.35); // the hit bleeds off rotor speed
          robot.speed = -0.6;
        }
        if (timer <= 0) { mode = 'roam'; timer = rand(1.5, 3); }
      } else {
        robot.speed += (0 - robot.speed) * damp(2.5, dt);
        if (timer <= 0) { mode = 'roam'; timer = rand(0.5, 1.1); }
      }

      // keep the wreck off the walls so it can always be reached
      const wallLim = half - Math.max(wm.half.x, wm.half.z) - botRadius * 1.2;
      for (const k of ['x', 'z'] as const) {
        if (Math.abs(machine.pos[k]) > wallLim) machine.vel[k] -= Math.sign(machine.pos[k]) * dt * 3;
      }
      if (attached.length && dissolve <= 0 && sinceHit > 9) {
        // something went wrong (wedged in a corner, knocked on top of the wall): drop it back in the middle
        machine.pos.set(rand(-0.2, 0.2) * half, floorY + wm.half.y + 0.6, rand(-0.2, 0.2) * half);
        machine.vel.set(0, 0, 0);
        machine.ang.set(0, 0, 0);
        sinceHit = 4;
        mode = 'roam';
        timer = 0.8;
      }
      // weapon speed: winds up while hunting, peaks during a charge, winds down between machines
      const wantSpin = mode === 'charge' ? 1 : mode === 'recoil' ? 0.7 : attached.length ? 0.45 : 0.12;
      spin += (wantSpin - spin) * (1 - Math.exp(-dt * (wantSpin > spin ? 1.6 : 0.8)));
      spinU.uSpeed.value = spin;
      spinU.uPhase.value += dt * (2 + spin * 26);
      robot.pos.x = THREE.MathUtils.clamp(robot.pos.x + Math.sin(robot.yaw) * robot.speed * dt, -lim, lim);
      robot.pos.y = THREE.MathUtils.clamp(robot.pos.y + Math.cos(robot.yaw) * robot.speed * dt, -lim, lim);
      ctx.model.position.set(robot.pos.x, floorY, robot.pos.y);
      ctx.model.rotation.set(0, robot.yaw + FRONT, 0);

      // scraping sparks when the machine lands hard
      if (flying && machine.pos.y < floorY + wm.half.y * 1.2 && Math.hypot(machine.vel.x, machine.vel.z) > 0.8 && Math.random() < 0.5) {
        burst(new THREE.Vector3(machine.pos.x, floorY + 0.02, machine.pos.z), new THREE.Vector2(machine.vel.x, machine.vel.z).normalize(), 5);
      }

      // fully stripped: the wreck dissolves and the next appliance drops in
      if (!attached.length && dissolve <= 0) {
        brokenFor += dt;
        if (brokenFor > 1.8) {
          dissolve = 1.2;
          brokenFor = 0;
          for (const o of everything()) o.traverse((m) => {
            const mesh = m as THREE.Mesh;
            if (!mesh.material) return;
            mesh.material = (mesh.material as THREE.Material).clone();
            (mesh.material as THREE.Material).transparent = true;
          });
        }
      }
      if (dissolve > 0) {
        dissolve -= dt;
        const k = Math.max(0, dissolve / 1.2);
        for (const o of everything()) o.traverse((m) => {
          const mat = (m as THREE.Mesh).material as THREE.Material | undefined;
          if (mat) mat.opacity = k;
        });
        if (dissolve <= 0) {
          for (const o of everything()) {
            o.removeFromParent();
            o.traverse((m) => { const mesh = m as THREE.Mesh; mesh.geometry?.dispose(); (mesh.material as THREE.Material | undefined)?.dispose(); });
          }
          lineup = (lineup + 1) % LINEUP.length;
          spawnAppliance(LINEUP[lineup], true);
          mode = 'roam';
          timer = 1.4;
        }
      }

      step(world, dt);

      // sparks
      for (let i = 0; i < SPARKS; i++) {
        if (sLife[i] <= 0) continue;
        sLife[i] -= dt;
        const j = i * 3;
        sVel[j + 1] -= 7 * dt;
        sPos[j] += sVel[j] * dt;
        sPos[j + 1] += sVel[j + 1] * dt;
        sPos[j + 2] += sVel[j + 2] * dt;
        if (sPos[j + 1] < floorY) { sPos[j + 1] = floorY; sVel[j + 1] *= -0.35; sVel[j] *= 0.6; sVel[j + 2] *= 0.6; }
        if (sLife[i] <= 0) sPos[j + 1] = -50;
      }
      sAttr.needsUpdate = true;
      flash.intensity = Math.max(0, flash.intensity - dt * 18);
    },
  };
}
