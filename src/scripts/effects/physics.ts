// Just enough rigid-body physics for toys and flying washing machines: gravity, a floor,
// axis-aligned walls, sphere-approximated contacts between bodies, and spin.

import * as THREE from '../three-lite';

export type Body = {
  obj: THREE.Object3D;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  quat: THREE.Quaternion;
  ang: THREE.Vector3;
  /** Half extents for boxes; x only (radius) for spheres. */
  half: THREE.Vector3;
  shape: 'box' | 'sphere';
  mass: number;
  restitution: number;
  friction: number;
};

export type World = {
  gravity: number;
  floor: number;
  /** Walls: |x - cx| <= hx, |z - cz| <= hz. Null for no walls. */
  bounds: { cx: number; cz: number; hx: number; hz: number } | null;
  bodies: Body[];
};

export function makeBody(obj: THREE.Object3D, shape: 'box' | 'sphere', half: THREE.Vector3, opts: Partial<Body> = {}): Body {
  return {
    obj, shape, half,
    pos: obj.position.clone(), vel: new THREE.Vector3(), quat: obj.quaternion.clone(), ang: new THREE.Vector3(),
    mass: 1, restitution: 0.35, friction: 0.6, ...opts,
  };
}

const corner = new THREE.Vector3();
const q = new THREE.Quaternion();

/** Lowest point of a body relative to its centre. */
function lowestOffset(b: Body) {
  if (b.shape === 'sphere') return new THREE.Vector3(0, -b.half.x, 0);
  let best = new THREE.Vector3(0, Infinity, 0);
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? b.half.x : -b.half.x, i & 2 ? b.half.y : -b.half.y, i & 4 ? b.half.z : -b.half.z).applyQuaternion(b.quat);
    if (corner.y < best.y) best = corner.clone();
  }
  return best;
}

export const radiusOf = (b: Body) => (b.shape === 'sphere' ? b.half.x : Math.max(b.half.x, b.half.z));

export function step(world: World, dt: number) {
  const { bodies } = world;
  for (const b of bodies) {
    b.vel.y -= world.gravity * dt;
    b.pos.addScaledVector(b.vel, dt);
    const w = b.ang.length();
    if (w > 1e-5) {
      q.setFromAxisAngle(b.ang.clone().divideScalar(w), w * dt);
      b.quat.premultiply(q).normalize();
    }

    // floor
    const low = lowestOffset(b);
    const pen = world.floor - (b.pos.y + low.y);
    if (pen > 0) {
      b.pos.y += pen;
      if (b.vel.y < 0) b.vel.y = -b.vel.y * b.restitution;
      if (Math.abs(b.vel.y) < 0.05) b.vel.y = 0;
      // friction on the ground slows sliding and spinning
      const f = Math.exp(-b.friction * 6 * dt);
      b.vel.x *= f;
      b.vel.z *= f;
      b.ang.multiplyScalar(Math.exp(-3 * dt));
      // a box resting on a corner tips toward flat: nudge rotation toward the nearest face-down
      if (b.shape === 'box' && b.vel.lengthSq() < 0.05) {
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(b.quat.clone().invert());
        const ax = Math.abs(up.x), ay = Math.abs(up.y), az = Math.abs(up.z);
        const face = ax > ay && ax > az ? new THREE.Vector3(Math.sign(up.x), 0, 0) : ay > az ? new THREE.Vector3(0, Math.sign(up.y), 0) : new THREE.Vector3(0, 0, Math.sign(up.z));
        const target = new THREE.Quaternion().setFromUnitVectors(face.applyQuaternion(b.quat).normalize(), new THREE.Vector3(0, 1, 0)).multiply(b.quat);
        b.quat.slerp(target, 1 - Math.exp(-4 * dt));
      }
      if (b.shape === 'sphere') {
        // roll without slipping
        b.ang.set(b.vel.z / b.half.x, 0, -b.vel.x / b.half.x);
      }
    }

    // walls
    if (world.bounds) {
      const { cx, cz, hx, hz } = world.bounds;
      const r = radiusOf(b);
      if (b.pos.x - r < cx - hx) { b.pos.x = cx - hx + r; b.vel.x = Math.abs(b.vel.x) * b.restitution; }
      if (b.pos.x + r > cx + hx) { b.pos.x = cx + hx - r; b.vel.x = -Math.abs(b.vel.x) * b.restitution; }
      if (b.pos.z - r < cz - hz) { b.pos.z = cz - hz + r; b.vel.z = Math.abs(b.vel.z) * b.restitution; }
      if (b.pos.z + r > cz + hz) { b.pos.z = cz + hz - r; b.vel.z = -Math.abs(b.vel.z) * b.restitution; }
    }
  }

  // body-body contacts on the ground plane
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j];
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const d = Math.hypot(dx, dz);
      const min = radiusOf(a) + radiusOf(b);
      if (d >= min || d < 1e-6) continue;
      if (Math.abs(a.pos.y - b.pos.y) > Math.max(a.half.y, b.half.y) * 2) continue;
      const nx = dx / d, nz = dz / d;
      const overlap = min - d;
      const total = a.mass + b.mass;
      a.pos.x -= nx * overlap * (b.mass / total);
      a.pos.z -= nz * overlap * (b.mass / total);
      b.pos.x += nx * overlap * (a.mass / total);
      b.pos.z += nz * overlap * (a.mass / total);
      const rel = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
      if (rel < 0) {
        const jImp = (-(1 + Math.min(a.restitution, b.restitution)) * rel) / (1 / a.mass + 1 / b.mass);
        a.vel.x -= (jImp / a.mass) * nx; a.vel.z -= (jImp / a.mass) * nz;
        b.vel.x += (jImp / b.mass) * nx; b.vel.z += (jImp / b.mass) * nz;
        a.ang.y += rand(-1, 1) * jImp * 0.5;
        b.ang.y += rand(-1, 1) * jImp * 0.5;
      }
    }
  }

  for (const b of bodies) {
    b.obj.position.copy(b.pos);
    b.obj.quaternion.copy(b.quat);
  }
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Push a body away from a moving circle (a robot), transferring some of its velocity. */
export function shove(b: Body, center: THREE.Vector3, radius: number, velocity: THREE.Vector3, strength = 1) {
  const dx = b.pos.x - center.x, dz = b.pos.z - center.z;
  const d = Math.hypot(dx, dz);
  const min = radius + radiusOf(b);
  if (d >= min || d < 1e-6) return false;
  const nx = dx / d, nz = dz / d;
  b.pos.x += nx * (min - d);
  b.pos.z += nz * (min - d);
  const push = Math.max(0, velocity.x * nx + velocity.z * nz) * 1.4 * strength + 0.15;
  b.vel.x += nx * push;
  b.vel.z += nz * push;
  b.ang.y += rand(-2, 2) * push;
  return true;
}
