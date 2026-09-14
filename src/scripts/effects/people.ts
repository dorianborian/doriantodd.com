// Little pictogram people in the style of Aperture Science signage: round head, shouldered torso,
// long coat, stubby legs. Eight instanced meshes (black parts plus their white rims) per crowd.

import * as THREE from '../three-lite';

export type Pose = 'idle' | 'walk' | 'run' | 'cheer' | 'wave' | 'panic';

export type Person = {
  pos: THREE.Vector3;
  yaw: number;
  /** Overall height in world units. */
  height: number;
  pose: Pose;
  phase: number;
  /** 1 = fully visible, 0 = gone (shrinks into the floor). */
  fade: number;
  /** Extra vertical offset, e.g. jumping. */
  hop: number;
  tint?: THREE.Color;
  alive: boolean;
};

// Paper thin black cut-outs with a hairline white edge, like the Aperture signage
const DEPTH = 0.012;
const EDGE = 0.022; // outline width, in person-height units
const BASE = new THREE.Color(0x000000);
const GONE = new THREE.Color(0x000000);

const rounded = (w: number, h: number, rTop: number, rBot: number) => {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + rBot, 0);
  s.lineTo(w / 2 - rBot, 0);
  s.quadraticCurveTo(w / 2, 0, w / 2, rBot);
  s.lineTo(w / 2, h - rTop);
  s.quadraticCurveTo(w / 2, h, w / 2 - rTop, h);
  s.lineTo(-w / 2 + rTop, h);
  s.quadraticCurveTo(-w / 2, h, -w / 2, h - rTop);
  s.lineTo(-w / 2, rBot);
  s.quadraticCurveTo(-w / 2, 0, -w / 2 + rBot, 0);
  return s;
};
const extrude = (s: THREE.Shape, x: number, y: number) =>
  new THREE.ExtrudeGeometry(s, { depth: DEPTH, bevelEnabled: false, curveSegments: 6 }).translate(x, y, -DEPTH / 2);

// Coat: a long rounded block from the shoulders to just above the knees
const torsoGeometry = () => extrude(rounded(0.46, 0.44, 0.1, 0.02), 0, 0.26);
// Stubby limbs hang from their pivot (top)
const limbGeometry = (w: number, len: number) => extrude(rounded(w, len, w / 2, w * 0.3), 0, -len);

/** A slightly larger, thinner copy that shows only as a rim around the black part. */
function outlineOf(g: THREE.BufferGeometry, grow = EDGE) {
  const o = g.clone();
  o.computeBoundingBox();
  const bb = o.boundingBox!;
  const c = bb.getCenter(new THREE.Vector3());
  const sz = bb.getSize(new THREE.Vector3());
  o.translate(-c.x, -c.y, -c.z).scale((sz.x + grow * 2) / sz.x, (sz.y + grow * 2) / sz.y, 0.5).translate(c.x, c.y, c.z);
  return o;
}

export class Crowd {
  readonly people: Person[] = [];
  private head: THREE.InstancedMesh;
  private torso: THREE.InstancedMesh;
  private arms: THREE.InstancedMesh;
  private legs: THREE.InstancedMesh;
  private rims: THREE.InstancedMesh[];
  private m = new THREE.Matrix4();
  private tmp = new THREE.Matrix4();
  private color = new THREE.Color();

  constructor(parent: THREE.Object3D, capacity: number) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    const rim = new THREE.MeshBasicMaterial({ color: 0xf4f6f8, side: THREE.DoubleSide });
    const head = new THREE.CylinderGeometry(0.2, 0.2, DEPTH, 32).rotateX(Math.PI / 2);
    const parts: [THREE.BufferGeometry, number][] = [[head, capacity], [torsoGeometry(), capacity], [limbGeometry(0.12, 0.3), capacity * 2], [limbGeometry(0.14, 0.3), capacity * 2]];
    const make = (g: THREE.BufferGeometry, m: THREE.Material, n: number) => {
      const im = new THREE.InstancedMesh(g, m, n);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.count = 0;
      im.frustumCulled = false;
      parent.add(im);
      return im;
    };
    [this.head, this.torso, this.arms, this.legs] = parts.map(([g, n]) => make(g, mat, n));
    this.rims = parts.map(([g, n]) => make(outlineOf(g), rim, n));
  }

  add(init: Partial<Person> = {}): Person {
    const p: Person = { pos: new THREE.Vector3(), yaw: 0, height: 0.3, pose: 'idle', phase: Math.random() * 10, fade: 1, hop: 0, alive: true, ...init };
    this.people.push(p);
    return p;
  }

  private rot = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private sc = new THREE.Vector3();

  /** Advance animation phases and write instance matrices. */
  update(dt: number) {
    let n = 0;
    for (const p of this.people) {
      if (!p.alive) continue;
      const speed = p.pose === 'run' || p.pose === 'panic' ? 14 : p.pose === 'walk' ? 8 : p.pose === 'cheer' ? 9 : 3;
      p.phase += dt * speed;
      const s = Math.sin(p.phase);

      // swing = forward/back (about x), raise = out to the side (about z)
      let armSwingL = 0, armSwingR = 0, armRaiseL = 0.12, armRaiseR = -0.12, legL = 0, legR = 0, bounce = 0, lean = 0;
      switch (p.pose) {
        case 'idle': armRaiseL = 0.1 + 0.03 * s; armRaiseR = -0.1 - 0.03 * s; bounce = 0.01 * Math.abs(s); break;
        case 'walk': legL = 0.45 * s; legR = -0.45 * s; armSwingL = -0.4 * s; armSwingR = 0.4 * s; bounce = 0.02 * Math.abs(s); break;
        case 'run': legL = 0.85 * s; legR = -0.85 * s; armSwingL = -0.9 * s; armSwingR = 0.9 * s; bounce = 0.05 * Math.abs(s); lean = 0.2; break;
        case 'panic': legL = 0.9 * s; legR = -0.9 * s; armRaiseL = 2.7 + 0.35 * s; armRaiseR = -2.7 - 0.35 * s; bounce = 0.06 * Math.abs(s); break;
        case 'cheer': armRaiseL = 2.6 + 0.3 * s; armRaiseR = -2.6 + 0.3 * s; bounce = 0.12 * Math.max(0, s); break;
        case 'wave': armRaiseL = 0.1; armRaiseR = -2.5 - 0.35 * s; break; // one arm up, like the sign
      }

      const k = p.height * Math.max(p.fade, 0.001);
      this.v.set(p.pos.x, p.pos.y + (bounce + p.hop) * p.height - (1 - p.fade) * p.height * 0.3, p.pos.z);
      this.q.setFromEuler(this.e.set(lean, p.yaw, 0, 'YXZ'));
      this.m.compose(this.v, this.q, this.sc.set(k, k, k));
      this.color.copy(p.tint ?? BASE).lerp(GONE, 1 - p.fade);

      this.tmp.copy(this.m).multiply(this.rot.makeTranslation(0, 0.9, 0));
      this.head.setMatrixAt(n, this.tmp);
      this.rims[0].setMatrixAt(n, this.tmp);
      this.torso.setMatrixAt(n, this.m);
      this.rims[1].setMatrixAt(n, this.m);
      this.head.setColorAt(n, this.color);
      this.torso.setColorAt(n, this.color);
      const limb = (im: THREE.InstancedMesh, idx: number, x: number, y: number, swing: number, raise: number) => {
        this.tmp.copy(this.m).multiply(this.rot.makeTranslation(x, y, 0));
        this.q.setFromEuler(this.e.set(swing, 0, raise, 'XYZ'));
        this.tmp.multiply(this.rot.makeRotationFromQuaternion(this.q));
        im.setMatrixAt(idx, this.tmp);
        im.setColorAt(idx, this.color);
        this.rims[im === this.arms ? 2 : 3].setMatrixAt(idx, this.tmp);
      };
      limb(this.arms, n * 2, -0.15, 0.64, armSwingL, armRaiseL);
      limb(this.arms, n * 2 + 1, 0.15, 0.64, armSwingR, armRaiseR);
      limb(this.legs, n * 2, -0.1, 0.3, legL, 0);
      limb(this.legs, n * 2 + 1, 0.1, 0.3, legR, 0);
      n++;
    }
    this.head.count = this.torso.count = n;
    this.arms.count = this.legs.count = n * 2;
    this.rims[0].count = this.rims[1].count = n;
    this.rims[2].count = this.rims[3].count = n * 2;
    for (const im of [this.head, this.torso, this.arms, this.legs, ...this.rims]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }
}
