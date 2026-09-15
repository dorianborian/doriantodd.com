// Per-cell greyscale for the home scene. Every material inside a project cell gets a shared `uSat`
// uniform mixed into its final colour: 0 is greyscale, 1 is full colour. Works for built-in materials
// (via onBeforeCompile, chained with any existing hook) and for custom ShaderMaterials.

import * as THREE from './three-lite';

const GREY = 'gl_FragColor.rgb = mix(vec3(dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722))) * 0.82, gl_FragColor.rgb, uSat);';

function injectEnd(src: string) {
  const end = src.lastIndexOf('}');
  return end < 0 ? src : `${src.slice(0, end)}\n${GREY}\n${src.slice(end)}`;
}

function injectFragment(src: string) {
  const head = `uniform float uSat;\n`;
  const body = src.includes('#include <dithering_fragment>')
    ? src.replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${GREY}`)
    : injectEnd(src);
  // declare after the precision / version lines three prepends, i.e. at the very top of the user code
  return head + body;
}

export class CellTint {
  readonly sat = { value: 1 };
  private mats = new Set<THREE.Material>();
  private owner = new WeakMap<THREE.Material, CellTint>();

  constructor(private registry: WeakMap<THREE.Material, CellTint>) {
    this.owner = registry;
  }

  /** Patch any material under `root` that is not patched yet. Cheap enough to call every second. */
  scan(root: THREE.Object3D) {
    root.traverse((o) => {
      const obj = o as THREE.Mesh;
      if (!obj.material) return;
      const list = Array.isArray(obj.material) ? obj.material : [obj.material];
      let changed = false;
      const next = list.map((m) => {
        const who = this.owner.get(m);
        if (who === this) return m;
        // a material already owned by another cell is cloned so each cell fades on its own
        const mat = who ? m.clone() : m;
        if (who) changed = true;
        this.patch(mat);
        return mat;
      });
      if (changed) obj.material = Array.isArray(obj.material) ? next : next[0];
    });
  }

  private patch(mat: THREE.Material) {
    this.owner.set(mat, this);
    this.mats.add(mat);
    const shader = mat as THREE.ShaderMaterial;
    if (shader.isShaderMaterial) {
      shader.uniforms.uSat = this.sat;
      shader.fragmentShader = injectFragment(shader.fragmentShader);
      shader.needsUpdate = true;
      return;
    }
    const prev = mat.onBeforeCompile;
    const prevKey = prev ? prev.toString() : '';
    mat.onBeforeCompile = (sh, renderer) => {
      prev?.call(mat, sh, renderer);
      sh.uniforms.uSat = this.sat;
      sh.fragmentShader = injectFragment(sh.fragmentShader);
    };
    mat.customProgramCacheKey = () => `cell-tint|${prevKey}`;
    mat.needsUpdate = true;
  }

  /** Push the new uniform value to every material (three only re-uploads when told to). */
  flush() {
    for (const m of this.mats) m.uniformsNeedUpdate = true;
  }
}
