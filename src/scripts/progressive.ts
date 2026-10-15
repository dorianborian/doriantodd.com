// Progressive detail for the home scene GLBs. scripts/lods.mjs writes <name>.lod0.glb / .lod1.glb next to a
// model with the same node tree, and src/scripts/lods.json lists them. A model is first loaded at lod0; later
// levels are parsed separately and their geometry buffers are moved into the existing BufferGeometry objects
// (matched node by node), so every clone, re-parented node or effect holding a mesh sees the finer shape
// without anything being rebuilt.

import * as THREE from './three-lite';
import manifest from './lods.json';

type Entry = { levels: string[]; tris: number[]; bytes: number[] };
const LODS = manifest as Record<string, Entry>;

/** Level URLs for a model, coarsest first; the last one is the file itself. */
export const levelsOf = (url: string) => LODS[url]?.levels ?? [url];

export type LodAsset = {
  url: string;
  levels: string[];
  /** Level currently in the geometry. */
  level: number;
  /** The pristine parsed scene. Never added to the page: callers get clones sharing its geometry. */
  scene: THREE.Object3D;
};

export function createLodLoader(parse: (url: string) => Promise<THREE.Object3D>) {
  const assets = new Map<string, Promise<LodAsset>>();
  const fetched = new Map<string, Promise<THREE.Object3D>>();

  const fetchLevel = (asset: LodAsset, level: number) => {
    const url = asset.levels[level];
    if (!fetched.has(url)) fetched.set(url, parse(url));
    return fetched.get(url)!;
  };

  return {
    /** The asset at its lowest level (loaded once per URL). */
    get(url: string) {
      if (!assets.has(url)) {
        const levels = levelsOf(url);
        assets.set(url, parse(levels[0]).then((scene) => ({ url, levels, level: 0, scene })));
      }
      return assets.get(url)!;
    },
    fetchLevel,
    /**
     * Move a parsed level's geometry into the asset. Returns, for every upgraded geometry, a geometry holding
     * its previous buffers (for the reveal ghost; dispose it when done), or null if the node trees differ.
     */
    swap(asset: LodAsset, next: THREE.Object3D, level: number) {
      const pairs = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
      const match = (a: THREE.Object3D, b: THREE.Object3D): boolean => {
        if (a.children.length !== b.children.length || a.name !== b.name) return false;
        const ma = a as THREE.Mesh, mb = b as THREE.Mesh;
        if (ma.isMesh !== mb.isMesh) return false;
        if (ma.isMesh && !pairs.has(ma.geometry)) pairs.set(ma.geometry, mb.geometry);
        return a.children.every((c, i) => match(c, b.children[i]));
      };
      if (!match(asset.scene, next)) {
        console.warn(`detail levels of ${asset.url} do not match, staying at level ${asset.level}`);
        asset.levels = asset.levels.slice(0, asset.level + 1);
        return null;
      }
      const old = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
      for (const [geo, src] of pairs) {
        const prev = new THREE.BufferGeometry();
        for (const k of Object.keys(geo.attributes)) prev.setAttribute(k, geo.attributes[k]);
        prev.setIndex(geo.index);
        prev.boundingBox = geo.boundingBox;
        prev.boundingSphere = geo.boundingSphere;
        // free the current GPU buffers (the ghost re-uploads them while it lives), then take the new ones
        geo.dispose();
        for (const k of Object.keys(geo.attributes)) if (!(k in src.attributes)) geo.deleteAttribute(k);
        for (const k of Object.keys(src.attributes)) geo.setAttribute(k, src.attributes[k]);
        geo.setIndex(src.index);
        geo.boundingBox = src.boundingBox;
        geo.boundingSphere = src.boundingSphere;
        old.set(geo, prev);
      }
      asset.level = level;
      fetched.delete(asset.levels[level]);
      return old;
    },
  };
}

const params = new URLSearchParams(location.search);

/**
 * Highest detail level worth loading here: 1 (lod1) on weak devices, slow or metered connections, 2 (full)
 * otherwise. ?lod=N forces it; ?debug (headless screenshot checks) always goes to full detail.
 */
export function detailCap() {
  if (params.has('lod')) return Number(params.get('lod'));
  if (params.has('debug')) return 2;
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean; effectiveType?: string } };
  if (nav.connection?.saveData || /(^|-)(2g|3g)$/.test(nav.connection?.effectiveType ?? '')) return 1;
  if ((nav.deviceMemory ?? 8) <= 2 || (nav.hardwareConcurrency ?? 8) <= 2) return 1;
  return 2;
}

/** Frame time watch: median animation frame interval over the last ~half second. */
export class FrameProbe {
  private samples: number[] = [];
  private last = 0;
  private raf = 0;
  start() {
    const loop = (t: number) => {
      if (this.last) { this.samples.push(t - this.last); if (this.samples.length > 30) this.samples.shift(); }
      this.last = t;
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    return this;
  }
  stop() { cancelAnimationFrame(this.raf); }
  /** True when the page is clearly struggling (well under 40 fps). */
  slow() {
    if (this.samples.length < 20 || params.has('debug')) return false;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] > 26;
  }
}

/** Wait for an idle moment (or at most `timeout` ms), so heavy steps never land in the middle of a frame. */
export const idle = (timeout = 250) => new Promise<void>((resolve) => {
  if ('requestIdleCallback' in window) requestIdleCallback(() => resolve(), { timeout });
  else setTimeout(resolve, 16);
});

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
