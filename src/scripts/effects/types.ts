import type * as THREE from '../three-lite';

export type ModelRef = { url: string; up: 'y' | 'z'; rotation: [number, number, number] };

export type EffectContext = {
  /** The project's cell body group. Local space: ground at y = 0, footprint centred on the origin, front faces +z. */
  body: THREE.Group;
  /** Holder around the normalised model (empty for projects without one). Move or scale it freely. */
  model: THREE.Group;
  /** World units per model unit applied during normalisation. */
  modelScale: number;
  /** Footprint size of a cell. Keep effects inside roughly this square. */
  foot: number;
  assets: { robot: ModelRef | null; photos: string[] };
  /** Load another model, cloned, oriented but unscaled. */
  loadRaw: (url: string, up: 'y' | 'z', rotation: [number, number, number]) => Promise<THREE.Object3D>;
  /** Make meshes clickable as part of this project. */
  pickable: (o: THREE.Object3D) => void;
};

export type Effect = { update: (time: number, dt: number) => void };
export type EffectFactory = (ctx: EffectContext) => Effect | Promise<Effect>;
