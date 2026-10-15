// Small rigid-body solver for the arena wreckage: oriented boxes with real inertia, gravity, a floor and
// four walls (infinitely tall, so nothing leaves the arena), box-box contacts from corner tests, a
// kinematic box for the robot, Coulomb friction, and sleeping so resting pieces settle instead of jittering.
// Everything is solved with sequential impulses at the box corners, which is enough for convincing tumbles.

import * as THREE from '../three-lite';

export type Rigid = {
  obj: THREE.Object3D;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  vel: THREE.Vector3;
  /** Angular velocity, world frame (rad/s). */
  ang: THREE.Vector3;
  half: THREE.Vector3;
  invMass: number;
  /** Inverse inertia, body frame diagonal. */
  invI: THREE.Vector3;
  restitution: number;
  friction: number;
  sleeping: boolean;
  still: number;
  /** Seconds since the body last touched the floor or a wall (for "is it flying"). */
  air: number;
};

/** A box moved by code (the robot). Pushes bodies out and hands them its velocity. */
export type Kinematic = { pos: THREE.Vector3; quat: THREE.Quaternion; half: THREE.Vector3; vel: THREE.Vector3 };

export function makeRigid(obj: THREE.Object3D, half: THREE.Vector3, mass: number, opts: Partial<Rigid> = {}): Rigid {
  const h = half.clone().max(new THREE.Vector3(0.006, 0.006, 0.006));
  // solid box inertia, I = m/3 (b^2 + c^2) with half extents
  const ix = (mass / 3) * (h.y * h.y + h.z * h.z), iy = (mass / 3) * (h.x * h.x + h.z * h.z), iz = (mass / 3) * (h.x * h.x + h.y * h.y);
  return {
    obj, half: h, pos: obj.position.clone(), quat: obj.quaternion.clone(), vel: new THREE.Vector3(), ang: new THREE.Vector3(),
    invMass: 1 / mass, invI: new THREE.Vector3(1 / ix, 1 / iy, 1 / iz), restitution: 0.3, friction: 0.6,
    sleeping: false, still: 0, air: 0, ...opts,
  };
}

/** Change a body's box (when parts come off) keeping its mass. */
export function resize(b: Rigid, half: THREE.Vector3) {
  const m = 1 / b.invMass;
  const h = b.half.copy(half).max(new THREE.Vector3(0.006, 0.006, 0.006));
  b.invI.set(3 / (m * (h.y * h.y + h.z * h.z)), 3 / (m * (h.x * h.x + h.z * h.z)), 3 / (m * (h.x * h.x + h.y * h.y)));
}

export function wake(b: Rigid) { b.sleeping = false; b.still = 0; }

// scratch, so the hot loop never allocates
const tq = new THREE.Quaternion();
const ti = new THREE.Quaternion();
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();
const rA = new THREE.Vector3();
const rB = new THREE.Vector3();
const tn = new THREE.Vector3();
const tt = new THREE.Vector3();
const corner = new THREE.Vector3();

/** world-frame inverse inertia applied to v (in place) */
function invInertia(b: Rigid, v: THREE.Vector3) {
  ti.copy(b.quat).invert();
  v.applyQuaternion(ti);
  v.multiply(b.invI);
  return v.applyQuaternion(b.quat);
}

/** velocity of body point at offset r */
function pointVel(b: Rigid | null, r: THREE.Vector3, out: THREE.Vector3) {
  if (!b) return out.set(0, 0, 0);
  return out.crossVectors(b.ang, r).add(b.vel);
}

/** 1 / effective mass along n at offset r */
function kOf(b: Rigid | null, r: THREE.Vector3, n: THREE.Vector3) {
  if (!b) return 0;
  v3.crossVectors(r, n);
  invInertia(b, v3);
  return b.invMass + v3.cross(r).dot(n);
}

function applyImpulse(b: Rigid | null, r: THREE.Vector3, j: THREE.Vector3, sign: number) {
  if (!b) return;
  b.vel.addScaledVector(j, b.invMass * sign);
  v3.crossVectors(r, j).multiplyScalar(sign);
  b.ang.add(invInertia(b, v3));
}

/** Impulse at a world point on a body (used by hits). */
export function hitAt(b: Rigid, point: THREE.Vector3, impulse: THREE.Vector3) {
  wake(b);
  rA.subVectors(point, b.pos);
  applyImpulse(b, rA, impulse, 1);
}

type Contact = { a: Rigid; b: Rigid | null; kb: Kinematic | null; p: THREE.Vector3; n: THREE.Vector3; depth: number };
const pool: Contact[] = [];
let used = 0;
function contact(a: Rigid, b: Rigid | null, kb: Kinematic | null, p: THREE.Vector3, n: THREE.Vector3, depth: number) {
  if (used >= pool.length) pool.push({ a, b, kb, p: new THREE.Vector3(), n: new THREE.Vector3(), depth });
  const c = pool[used++];
  c.a = a; c.b = b; c.kb = kb; c.p.copy(p); c.n.copy(n); c.depth = depth;
}

/**
 * Corners of box A inside box B (position/orientation/half). For each, the push-out normal (pointing from B
 * toward A) is B's face axis with the least penetration.
 */
function cornersInBox(a: Rigid, bPos: THREE.Vector3, bQuat: THREE.Quaternion, bHalf: THREE.Vector3, emit: (p: THREE.Vector3, n: THREE.Vector3, d: number) => void) {
  tq.copy(bQuat).invert();
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? a.half.x : -a.half.x, i & 2 ? a.half.y : -a.half.y, i & 4 ? a.half.z : -a.half.z).applyQuaternion(a.quat).add(a.pos);
    v1.subVectors(corner, bPos).applyQuaternion(tq); // corner in B's frame
    const dx = bHalf.x - Math.abs(v1.x), dy = bHalf.y - Math.abs(v1.y), dz = bHalf.z - Math.abs(v1.z);
    if (dx <= 0 || dy <= 0 || dz <= 0) continue;
    if (dx < dy && dx < dz) tn.set(Math.sign(v1.x) || 1, 0, 0);
    else if (dy < dz) tn.set(0, Math.sign(v1.y) || 1, 0);
    else tn.set(0, 0, Math.sign(v1.z) || 1);
    tn.applyQuaternion(bQuat);
    emit(corner, tn, Math.min(dx, dy, dz));
  }
}

export class RigidWorld {
  bodies: Rigid[] = [];
  robots: Kinematic[] = [];
  gravity = 9.8;
  constructor(public floor: number, public hx: number, public hz: number) {}

  add(b: Rigid) { this.bodies.push(b); return b; }
  remove(b: Rigid) { const i = this.bodies.indexOf(b); if (i >= 0) this.bodies.splice(i, 1); }

  step(dt: number) {
    const sub = dt > 1 / 50 ? 3 : 2;
    const h = dt / sub;
    for (let s = 0; s < sub; s++) this.substep(h);
    for (const b of this.bodies) { b.obj.position.copy(b.pos); b.obj.quaternion.copy(b.quat); }
  }

  private collect() {
    used = 0;
    const { bodies, floor, hx, hz } = this;
    for (const a of bodies) {
      let touching = false;
      // floor and walls, per corner
      for (let i = 0; i < 8; i++) {
        corner.set(i & 1 ? a.half.x : -a.half.x, i & 2 ? a.half.y : -a.half.y, i & 4 ? a.half.z : -a.half.z).applyQuaternion(a.quat).add(a.pos);
        if (corner.y < floor + 0.002) { touching = true; if (!a.sleeping) contact(a, null, null, corner, tn.set(0, 1, 0), floor - corner.y); }
        if (a.sleeping) continue;
        if (corner.x < -hx) { touching = true; contact(a, null, null, corner, tn.set(1, 0, 0), -hx - corner.x); }
        if (corner.x > hx) { touching = true; contact(a, null, null, corner, tn.set(-1, 0, 0), corner.x - hx); }
        if (corner.z < -hz) { touching = true; contact(a, null, null, corner, tn.set(0, 0, 1), -hz - corner.z); }
        if (corner.z > hz) { touching = true; contact(a, null, null, corner, tn.set(0, 0, -1), corner.z - hz); }
      }
      if (touching) a.air = 0;
      // the robot
      for (const r of this.robots) {
        if (a.sleeping && r.vel.lengthSq() < 0.0025) continue;
        const reach = a.half.length() + r.half.length();
        if (a.pos.distanceToSquared(r.pos) > reach * reach) continue;
        cornersInBox(a, r.pos, r.quat, r.half, (p, n, d) => { wake(a); contact(a, null, r, p, n, d); });
        // robot corners poking into a big body
        const fake = { half: r.half, quat: r.quat, pos: r.pos } as Rigid;
        cornersInBox(fake, a.pos, a.quat, a.half, (p, n, d) => { wake(a); contact(a, null, r, p, n.negate(), d); });
      }
    }
    // body pairs
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        if (a.sleeping && b.sleeping) continue;
        const reach = a.half.length() + b.half.length();
        if (a.pos.distanceToSquared(b.pos) > reach * reach) continue;
        cornersInBox(a, b.pos, b.quat, b.half, (p, n, d) => { a.air = b.air = 0; contact(a, b, null, p, n, d); });
        cornersInBox(b, a.pos, a.quat, a.half, (p, n, d) => { a.air = b.air = 0; contact(b, a, null, p, n, d); });
      }
    }
  }

  private substep(h: number) {
    const g = this.gravity;
    for (const b of this.bodies) {
      if (b.sleeping) continue;
      b.vel.y -= g * h;
      b.air += h;
    }
    this.collect();

    // a sleeping body hit by an awake one wakes up (only if the push is real)
    for (let c = 0; c < used; c++) {
      const k = pool[c];
      if (k.b && k.b.sleeping !== k.a.sleeping) {
        const mover = k.a.sleeping ? k.b : k.a;
        if (mover.vel.lengthSq() + mover.ang.lengthSq() * 0.01 > 0.04) { wake(k.a); wake(k.b); }
      }
      // otherwise a sleeping body is static ground for the awake one: make the awake one side A
      if (k.b && k.a.sleeping && !k.b.sleeping) { const t = k.a; k.a = k.b; k.b = t; k.n.negate(); }
    }

    // velocity solve
    for (let it = 0; it < 4; it++) {
      for (let c = 0; c < used; c++) {
        const k = pool[c];
        const a = k.a, b = k.b && !k.b.sleeping ? k.b : null;
        if (a.sleeping) continue;
        rA.subVectors(k.p, a.pos);
        if (b) rB.subVectors(k.p, b.pos);
        // relative velocity of A's point against the other side
        pointVel(a, rA, v1);
        if (b) v1.sub(pointVel(b, rB, v2));
        else if (k.kb) v1.sub(k.kb.vel);
        const vn = v1.dot(k.n);
        if (vn >= 0) continue;
        const kn = kOf(a, rA, k.n) + kOf(b, rB, k.n);
        // bounce only on real impacts; resting contacts get none (that is what kills jitter)
        const e = vn < -0.6 ? Math.min(a.restitution, b ? b.restitution : a.restitution) : 0;
        const jn = (-(1 + e) * vn) / kn;
        tt.copy(k.n).multiplyScalar(jn);
        applyImpulse(a, rA, tt, 1);
        applyImpulse(b, rB, tt, -1);
        // friction
        pointVel(a, rA, v1);
        if (b) v1.sub(pointVel(b, rB, v2));
        else if (k.kb) v1.sub(k.kb.vel);
        tt.copy(k.n).multiplyScalar(v1.dot(k.n));
        v1.sub(tt);
        const vt = v1.length();
        if (vt < 1e-5) continue;
        tt.copy(v1).divideScalar(vt);
        const kt = kOf(a, rA, tt) + kOf(b, rB, tt);
        const mu = b ? Math.sqrt(a.friction * b.friction) : a.friction;
        const jt = Math.min(vt / kt, mu * jn);
        tt.multiplyScalar(-jt);
        applyImpulse(a, rA, tt, 1);
        applyImpulse(b, rB, tt, -1);
      }
    }

    // integrate
    for (const b of this.bodies) {
      if (b.sleeping) continue;
      b.pos.addScaledVector(b.vel, h);
      const w = b.ang.length();
      if (w > 1e-6) {
        tq.setFromAxisAngle(v1.copy(b.ang).divideScalar(w), w * h);
        b.quat.premultiply(tq).normalize();
      }
      // a little air drag and rolling resistance
      b.ang.multiplyScalar(Math.exp(-0.4 * h));
    }

    // position fix: push out most of each overlap, split between the two bodies
    for (let c = 0; c < used; c++) {
      const k = pool[c];
      if (k.a.sleeping) continue;
      const d = Math.max(0, k.depth - 0.001) * 0.45;
      if (d <= 0) continue;
      const b = k.b && !k.b.sleeping ? k.b : null;
      const wa = k.a.invMass, wb = b ? b.invMass : 0;
      const sa = b ? wa / (wa + wb) : 1;
      k.a.pos.addScaledVector(k.n, d * sa);
      if (b) b.pos.addScaledVector(k.n, -d * (1 - sa));
    }

    // sleep once a body has been nearly still for a moment
    for (const b of this.bodies) {
      if (b.sleeping) continue;
      const slow = b.vel.lengthSq() < 0.004 && b.ang.lengthSq() < 0.03 && b.air < 0.05;
      b.still = slow ? b.still + h : 0;
      if (b.still > 0.35) { b.sleeping = true; b.vel.set(0, 0, 0); b.ang.set(0, 0, 0); }
    }
  }
}
