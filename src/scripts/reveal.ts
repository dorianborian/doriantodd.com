// Detail reveal for the home scene. Instead of popping in, a model first scans in as a faceted, blue CAD
// hologram (its super decimated lod0), and every detail upgrade sweeps a bright scan band up through it:
// below the band the finer geometry is already in place, above it the previous level is still drawn.
//
// How: every model material gets one shared onBeforeCompile hook (so all of them still share programs, and
// src/scripts/desaturate.ts chains onto it with a constant cache key). The hook adds per-cell uniforms:
//   uRv     x: band height (world y), y: band half width, z: hologram amount below the band, w: above it
//   uRvSide 0 for the real mesh (drawn below the band), 1 for a ghost copy holding the previous geometry
//           (drawn above the band) that only exists while a band is sweeping
//   uRvGlow band brightness, uRvT time (scanline drift)
// Idle cells park the band far above everything, so the patch costs a couple of uniform branches.

import * as THREE from './three-lite';

type Uniforms = { uRv: { value: THREE.Vector4 }; uRvSide: { value: number }; uRvGlow: { value: number }; uRvT: { value: number } };

const PARKED = 1e4;
const time = { value: 0 };
const bags = new WeakMap<THREE.Material, Uniforms>();
// Materials cloned elsewhere lose the hook, but a program shared through the cache key still needs its uniforms
const idleBag: Uniforms = { uRv: { value: new THREE.Vector4(PARKED, 1, 0, 0) }, uRvSide: { value: 0 }, uRvGlow: { value: 0 }, uRvT: time };

const VERT_HEAD = 'varying vec3 vRvPos;\n';
const VERT_BODY = /* glsl */ `#include <project_vertex>
	vec4 rvW = vec4( transformed, 1.0 );
	#ifdef USE_INSTANCING
	rvW = instanceMatrix * rvW;
	#endif
	vRvPos = ( modelMatrix * rvW ).xyz;`;
const FRAG_HEAD = 'uniform vec4 uRv;\nuniform float uRvSide;\nuniform float uRvGlow;\nuniform float uRvT;\nvarying vec3 vRvPos;\n';
const FRAG_START = /* glsl */ `void main() {
	if ( uRvSide < 0.5 ? vRvPos.y > uRv.x : vRvPos.y < uRv.x ) discard;
	float rvHolo = uRvSide < 0.5 ? uRv.z : uRv.w;`;
// faceted shading while the hologram shows the low poly shape
const FRAG_FACETS = /* glsl */ `#include <normal_fragment_maps>
	if ( rvHolo > 0.0 ) normal = normalize( mix( normal, normalize( cross( dFdx( vViewPosition ), dFdy( vViewPosition ) ) ), rvHolo ) );`;
// after the cell greyscale (desaturate.ts inserts its line straight after the include), so the blue stays blue
const FRAG_END = /* glsl */ `#include <dithering_fragment>
	if ( rvHolo > 0.0 || uRvGlow > 0.0 ) {
		vec3 rvAcc = vec3( 0.29, 0.608, 1.0 );
		vec3 rvN = normalize( cross( dFdx( vRvPos ), dFdy( vRvPos ) ) );
		float rvRim = 1.0 - abs( dot( rvN, normalize( cameraPosition - vRvPos ) ) );
		float rvLum = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
		vec3 rvG = vRvPos * 9.0;
		vec3 rvGw = abs( fract( rvG ) - 0.5 ) / max( fwidth( rvG ) * 1.2, vec3( 1e-4 ) );
		float rvGrid = 1.0 - clamp( min( min( rvGw.x, rvGw.y ), rvGw.z ), 0.0, 1.0 );
		float rvS = vRvPos.y * 70.0 - uRvT * 2.0;
		float rvLine = 1.0 - clamp( abs( fract( rvS ) - 0.5 ) / max( fwidth( rvS ) * 1.5, 1e-4 ), 0.0, 1.0 );
		vec3 rvCol = rvAcc * ( 0.08 + 0.5 * rvLum + 1.1 * rvRim * rvRim + 0.45 * rvGrid + 0.16 * rvLine );
		gl_FragColor.rgb = mix( gl_FragColor.rgb, rvCol, rvHolo );
		// the scan band: a hot edge line, a soft halo, and a fading trail over the freshly resolved part below it
		float rvD = ( vRvPos.y - uRv.x ) / uRv.y;
		float rvB = exp( - rvD * rvD ) * uRvGlow;
		float rvE = exp( - rvD * rvD * 24.0 ) * uRvGlow;
		float rvTrail = rvD < 0.0 ? exp( rvD * 0.7 ) * uRvGlow : 0.0;
		gl_FragColor.rgb += rvAcc * ( rvB * 0.55 + rvTrail * ( 0.1 + 0.3 * rvGrid ) ) + vec3( 0.75, 0.9, 1.0 ) * rvE;
		gl_FragColor.a = max( gl_FragColor.a, rvE );
	}`;

type Shader = { uniforms: Record<string, unknown>; vertexShader: string; fragmentShader: string };

// One function for every material: desaturate.ts keys programs on its source text.
function revealHook(this: THREE.Material, sh: Shader) {
  Object.assign(sh.uniforms, bags.get(this) ?? idleBag);
  if (!sh.vertexShader.includes('#include <project_vertex>') || !sh.fragmentShader.includes('#include <dithering_fragment>')) return;
  sh.vertexShader = VERT_HEAD + sh.vertexShader.replace('#include <project_vertex>', VERT_BODY);
  sh.fragmentShader = FRAG_HEAD + sh.fragmentShader
    .replace('void main() {', FRAG_START)
    .replace('#include <normal_fragment_maps>', FRAG_FACETS)
    .replace('#include <dithering_fragment>', FRAG_END);
}

const materials = (mesh: THREE.Mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.Material[];

/** Give a material the hook with these uniforms. Skips materials that already have their own shader hooks. */
function patch(mat: THREE.Material, bag: Uniforms) {
  if (bags.has(mat)) { bags.set(mat, bag); return; }
  if (Object.prototype.hasOwnProperty.call(mat, 'onBeforeCompile') || (mat as THREE.ShaderMaterial).isShaderMaterial) return;
  bags.set(mat, bag);
  mat.onBeforeCompile = revealHook as THREE.Material['onBeforeCompile'];
  mat.customProgramCacheKey = () => 'reveal';
  mat.needsUpdate = true;
}

const params = new URLSearchParams(location.search);
// ?lodhold=L,P freezes the sweep that brings in level L (0 scan in, 1 lod1, 2 full) at progress P, for screenshots
const hold = (params.get('lodhold') ?? '').split(',').map(Number);
const holdLevel = params.has('lodhold') ? hold[0] : -1;
const holdAt = Number.isFinite(hold[1]) ? hold[1] : 0.5;
// ?lodstep=S makes every sweep last S seconds (the loader also waits S seconds between levels)
export const lodStep = Number(params.get('lodstep')) || 0;
// No animation for reduced motion, and none for ?debug screenshot checks (software GL in virtual time is too
// slow to finish the sweeps) unless lodhold / lodstep ask for it
const instant = matchMedia('(prefers-reduced-motion: reduce)').matches || (params.has('debug') && !params.has('lodhold') && !params.has('lodstep'));

type Sweep = { t0: number; dur: number; from: number; to: number; level: number; glow: number; ghosts: THREE.Mesh[]; done: () => void };

/** Reveal state of one project cell. `range` gives the world height span the band travels. */
export class CellReveal {
  private readonly main: Uniforms;
  private readonly ghost: Uniforms;
  /** Hologram amount once the current sweep is over (1: blue hologram, 0: real materials). */
  holo = 1;
  private sweep: Sweep | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private range: () => [number, number], private adopt: (o: THREE.Object3D) => void) {
    const rv = { value: new THREE.Vector4(PARKED, 1, 1, 1) };
    const glow = { value: 0 };
    this.main = { uRv: rv, uRvSide: { value: 0 }, uRvGlow: glow, uRvT: time };
    this.ghost = { uRv: rv, uRvSide: { value: 1 }, uRvGlow: glow, uRvT: time };
    if (instant) this.holo = 0;
    rv.value.z = rv.value.w = this.holo;
  }

  /** Hook every material under `root` to this cell (call before the cell tint patches them). */
  patch(root: THREE.Object3D) {
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh) for (const m of materials(o as THREE.Mesh)) patch(m, this.main); });
  }

  get sweeping() { return !!this.sweep; }

  /** Resolves when no sweep is running or queued. */
  idle() { return this.chain; }

  /** Scan the hologram in from the ground up (nothing above the band). */
  materialize() {
    return this.queue(0, 0.75, 1, instant ? 0 : 1, 0.9, null);
  }

  /**
   * Sweep after geometry was swapped: `old` maps each upgraded geometry to a copy holding its previous
   * buffers. Meshes under `root` using them get a ghost with the old shape above the band.
   * `level` 1 also resolves the hologram into the real materials.
   */
  upgrade(root: THREE.Object3D, old: Map<THREE.BufferGeometry, THREE.BufferGeometry> | null, level: number) {
    return this.queue(level, level === 1 ? 1.1 : 0.85, null, 0, level === 1 ? 1 : 0.6, { root, old });
  }

  private queue(level: number, dur: number, from: number | null, to: number, glow: number, swap: { root: THREE.Object3D; old: Map<THREE.BufferGeometry, THREE.BufferGeometry> | null } | null) {
    this.chain = this.chain.then(() => new Promise<void>((done) => {
      const ghosts: THREE.Mesh[] = [];
      if (swap && !instant) {
        swap.root.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh || mesh.userData.revealGhost) return;
          const mats = materials(mesh);
          if (!mats.every((m) => bags.get(m) === this.main)) return;
          // the previous geometry if it was swapped, otherwise the same one (a resolve sweep without new detail)
          const geo = swap.old?.get(mesh.geometry) ?? (swap.old ? null : mesh.geometry);
          if (!geo) return;
          const copies = mats.map((m) => { const c = m.clone(); patch(c, this.ghost); return c; });
          const g = new THREE.Mesh(geo, Array.isArray(mesh.material) ? copies : copies[0]);
          g.userData.revealGhost = true;
          g.userData.ownsGeometry = geo !== mesh.geometry;
          g.raycast = () => {};
          mesh.add(g);
          this.adopt(g);
          ghosts.push(g);
        });
      }
      this.sweep = { t0: -1, dur: (lodStep || dur) * 1000, from: from ?? this.holo, to, level, glow, ghosts, done };
      if (instant) this.finish();
    }));
    return this.chain;
  }

  private finish() {
    const s = this.sweep!;
    this.sweep = null;
    this.holo = s.to;
    const u = this.main.uRv.value;
    u.set(PARKED, 1, this.holo, this.holo);
    this.main.uRvGlow.value = 0;
    for (const g of s.ghosts) {
      g.removeFromParent();
      for (const m of materials(g)) m.dispose();
      // a ghost owns the previous buffers (the live geometry already holds the new ones)
      if (g.userData.ownsGeometry) g.geometry.dispose();
    }
    s.done();
  }

  /** Per frame. Returns true while something is animating. */
  update(now: number) {
    time.value = now / 1000;
    const s = this.sweep;
    if (!s) return this.holo > 0;
    if (s.t0 < 0) s.t0 = now;
    let p = Math.min((now - s.t0) / s.dur, 1);
    if (s.level === holdLevel) p = Math.min(p, holdAt);
    const [y0, y1] = this.range();
    const h = Math.max(y1 - y0, 0.2);
    const k = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const u = this.main.uRv.value;
    u.set(y0 - 0.06 * h + k * h * 1.12, 0.05 + h * 0.05, s.to, s.from);
    this.main.uRvGlow.value = s.glow * Math.min(1, p * 8, (1 - p) * 5);
    if (p >= 1 && s.level !== holdLevel) this.finish();
    return true;
  }
}
