// Runtime side of scripts/fusion.mjs: loads <base>/rig.glb + <base>/rig.json (a Fusion 360 export) and lets an
// effect build its own joint pivots. Parts stay the original meshes (no geometry copies), so geometry swaps
// done by the progressive loader still reach them.
//
// Coordinates: rig.json joint origins/axes and the meshes are CAD world metres, Z-up. `scene` below is that
// CAD frame (loadRaw already stands it up), so pivots created with `pivot()` use rig.json numbers directly.

import * as THREE from '../three-lite';
import type { EffectContext } from './types';

export type FusionJoint = {
  id: string; name: string; type: 'revolute' | 'slider' | 'cylindrical' | 'fixed' | string;
  parent: string; child: string; origin: [number, number, number]; axis: [number, number, number];
  limits?: { min?: number | null; max?: number | null; rest?: number };
};
export type FusionInfo = {
  design: { name: string; upVector: number[] };
  occurrences: { id: string; name: string; grounded: boolean; jointed: boolean; bbox: [number[], number[]] }[];
  joints: FusionJoint[];
};

// GLTFLoader sanitises node names the way three's PropertyBinding does
const key = (name: string) => name.replace(/[[\].:/]/g, '').replace(/\s/g, '_');

export async function loadFusionRig(ctx: EffectContext, base: string) {
  const [outer, info] = await Promise.all([
    ctx.loadRaw(`${base}/rig.glb`, 'z', [0, 0, 0]),
    fetch(`${base}/rig.json`).then((r) => r.json() as Promise<FusionInfo>),
  ]);
  outer.updateMatrixWorld(true);
  // outer (orientation) > inner (Z-up to Y-up) > gltf scene: the gltf scene is the CAD frame
  let scene: THREE.Object3D = outer;
  outer.traverse((o) => { if (!scene.userData.cad && o.children.some((c) => (c as THREE.Mesh).isMesh || c.children.some((g) => (g as THREE.Mesh).isMesh))) { scene = o; scene.userData.cad = true; } });

  const parts: Record<string, THREE.Object3D> = {};
  scene.traverse((o) => { if (o.name) parts[o.name] = o; });
  const part = (id: string) => parts[key(id)] ?? parts[id];

  /**
   * A pivot at a CAD-frame point turning about a CAD-frame axis. The given parts are re-parented into it
   * keeping their current world pose. Nest pivots by passing a pivot group as `parent`.
   */
  const pivot = (ids: (string | THREE.Object3D)[], origin: number[], axis: number[], parent: THREE.Object3D = scene) => {
    const g = new THREE.Group();
    parent.add(g);
    g.position.copy(parent === scene ? new THREE.Vector3(...origin) : parent.worldToLocal(scene.localToWorld(new THREE.Vector3(...origin))));
    g.updateMatrixWorld(true);
    for (const id of ids) {
      const o = typeof id === 'string' ? part(id) : id;
      if (o) g.attach(o);
    }
    const ax = new THREE.Vector3(...axis).normalize();
    const rest = g.quaternion.clone();
    const q = new THREE.Quaternion();
    return {
      group: g,
      /** revolute: radians about the axis */
      set(angle: number) { g.quaternion.copy(rest).multiply(q.setFromAxisAngle(ax, angle)); },
    };
  };

  return { root: outer, scene, info, parts, part, pivot };
}
