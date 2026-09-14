// Each effect lives in its own chunk and is only downloaded when a project on the page uses it.
import type { EffectFactory } from './types';

const loaders: Record<string, () => Promise<{ default: EffectFactory }>> = {
  'led-mosaic': () => import('./mosaic'),
  scanner: () => import('./hexvision'),
  soccer: () => import('./soccer'),
  chase: () => import('./fridge'),
  playpen: () => import('./sesame'),
  arena: () => import('./arena'),
  photos: () => import('./photos'),
};

export async function loadEffect(name: string): Promise<EffectFactory | null> {
  const load = loaders[name];
  return load ? (await load()).default : null;
}
