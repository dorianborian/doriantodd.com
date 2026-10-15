// Home page: every project sits on the top plane as a 3D model with a sketch-style label.
// Projects without a model yet show their cover image on a plate. Hover to preselect, click to
// select, double-click (or Enter) to open. Renders on demand only.
// Sub-projects (frontmatter `parent`) park as small ghosts at their parent's cell; clicking the group
// splits it into one mini cell per project (see "groups" below).

import * as THREE from './three-lite';
import type { Effect, EffectContext } from './effects/types';
import { CellTint } from './desaturate';
const { OrbitControls } = THREE;

type ModelRef = { url: string; up: 'y' | 'z'; rotation: [number, number, number] };

type Item = {
  slug: string; year: number | null; modelScale: number; title: string; summary: string; tags: string[]; status: string; url: string; no: string;
  thumb: string | null; aspect: number; model: ModelRef | null; effect: string | null;
  /** slug of the parent project; `borrowed` = the effect is a sub-project's, shown while the group is collapsed */
  parent: string | null; borrowed: boolean;
};
type Data = { parts: Item[]; logo: { src: string; aspect: number }; assets: { robot: ModelRef | null; photos: string[] } };
type State = 'none' | 'preselect' | 'select';

const COLOR = {
  sketch: '#aeb6c2',
  preselect: '#f2b84b',
  select: '#4a9bff',
  plate: 0x8a929e,
  edge: 0x0c0d0f,
  ghost: 0x9db7d8,
};
const EMISSIVE: Record<State, number> = { none: 0x000000, preselect: 0x3a2a08, select: 0x0b2547 };

const FOOT = 3.0;        // max model footprint
const MAX_H = 2.6;       // max model height
const CELL_W = 4.6;
const CELL_D = 5.0;
const LABEL_H = 0.78;
// groups: ghost size and spots (parent cell local, x/z), size of each project once split, split duration
const GHOST = 0.3;
const GHOST_Y = 1.25;
const GHOST_SPOTS: [number, number][] = [[1.75, -1.55], [-1.75, -1.55], [1.75, 0.55], [-1.75, 0.55]];
const SPLIT = 0.68;
const SPLIT_MS = 950;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

/** Label drawn the way sketch text looks in Onshape: outlined glyphs, a construction line, sketch points. */
function drawLabel(canvas: HTMLCanvasElement, title: string, no: string, color: string) {
  const ctx = canvas.getContext('2d')!;
  const { width: W, height: H } = canvas;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  const pad = 24;
  const text = title.toUpperCase();
  let size = 92;
  ctx.font = `600 ${size}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
  while (ctx.measureText(text).width > W - pad * 2 && size > 30) {
    size -= 4;
    ctx.font = `600 ${size}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
  }
  const textW = ctx.measureText(text).width;
  const baseline = 40 + size;
  ctx.lineWidth = 2.6;
  ctx.lineJoin = 'round';
  ctx.strokeText(text, pad, baseline);

  // construction line under the text, with sketch points at both ends
  const y = baseline + 26;
  ctx.setLineDash([14, 10]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, y);
  ctx.lineTo(pad + textW, y);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const x of [pad, pad + textW]) ctx.fillRect(x - 6, y - 6, 12, 12);

  // project number, like a dimension value
  ctx.font = `500 34px ui-monospace, Consolas, monospace`;
  ctx.fillText(no, pad, y + 52);
}

const stamp = (p: Item) => (p.year ? `${p.no}   ${p.year}` : p.no);

export function mountAssembly(root: HTMLElement, data: Data) {
  if (!webglAvailable()) return fallback(root, data);

  // ------------------------------------------------------------ renderer / scene
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  root.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 400);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = !reducedMotion;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = true;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 3;
  controls.maxDistance = 120;

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xe6ecf5, 0x2a2c31, 0.9));
  const headlight = new THREE.DirectionalLight(0xffffff, 1.2);
  headlight.position.set(0.4, 1, 0.2);
  camera.add(headlight);
  scene.add(camera);

  // ------------------------------------------------------------ layout
  // Only top-level projects get a grid cell; sub-projects sit as ghosts at their parent's cell.
  const slugIndex = new Map(data.parts.map((p, i) => [p.slug, i]));
  const parentOf = data.parts.map((p) => {
    const j = p.parent ? slugIndex.get(p.parent) ?? -1 : -1;
    return j >= 0 && !data.parts[j].parent ? j : -1;
  });
  const topLevel = data.parts.map((_, i) => i).filter((i) => parentOf[i] < 0);
  // keyboard / tree order: each top-level project followed by its sub-projects
  const navOrder = topLevel.flatMap((i) => [i, ...data.parts.map((_, j) => j).filter((j) => parentOf[j] === i)]);
  const n = topLevel.length;
  const cols = n <= 4 ? n : n <= 6 ? 3 : 4;
  const rows = Math.ceil(n / cols);

  const gridSize = Math.ceil(Math.max(cols * CELL_W, rows * CELL_D) + 16);
  const grid = new THREE.GridHelper(gridSize, gridSize, 0x3d4048, 0x2a2d33);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.5;
  scene.add(grid);

  const loader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  type Part = {
    i: number;
    group: THREE.Group;       // cell origin on the ground
    body: THREE.Group;        // model or plate
    footprint: THREE.LineLoop;
    /** resting spot: the grid slot, or the ghost spot for a sub-project */
    home: THREE.Vector3;
    /** the group this project belongs to (as parent or sub-project) */
    fam: Family | null;
    /** sub-projects only: x-ray look while parked */
    ghost: Ghost | null;
    /** effect frozen (parked ghost, or a parent whose borrowed scene is handed over while split) */
    paused: boolean;
    label: { mesh: THREE.Mesh; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture };
    mats: THREE.MeshStandardMaterial[];
    edges: THREE.LineSegments[];
    state: State | null;
    /** Idle cells play in slow motion and greyscale until hovered, selected or tapped. */
    tint: CellTint;
    clock: number;
    speed: number;
  };
  const tintRegistry = new WeakMap<THREE.Material, CellTint>();
  const IDLE_SPEED = 0.15;
  // ?active=all or ?active=<slug> keeps cells in colour for screenshot checks
  const activeParam = new URLSearchParams(location.search).get('active');
  const activeAll = activeParam === 'all';
  const parts: Part[] = [];
  const pickables: THREE.Object3D[] = [];

  function footprintLoop(w: number, d: number) {
    const hw = w / 2, hd = d / 2;
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-hw, 0.004, -hd), new THREE.Vector3(hw, 0.004, -hd),
      new THREE.Vector3(hw, 0.004, hd), new THREE.Vector3(-hw, 0.004, hd),
    ]);
    return new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: COLOR.sketch, transparent: true, opacity: 0.55 }));
  }

  data.parts.forEach((p, i) => {
    const slot = topLevel.indexOf(i);
    const col = slot % cols;
    const row = Math.floor(slot / cols);
    const group = new THREE.Group();
    const home = slot >= 0 ? new THREE.Vector3((col - (cols - 1) / 2) * CELL_W, 0, (row - (rows - 1) / 2) * CELL_D - 0.6) : new THREE.Vector3();
    group.position.copy(home);
    scene.add(group);

    const body = new THREE.Group();
    group.add(body);

    // sketch label on the ground in front of the project
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 256;
    drawLabel(canvas, p.title, stamp(p), COLOR.sketch);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAniso;
    const labelW = CELL_W - 0.5;
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(labelW, labelW / 4),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    label.rotation.x = -Math.PI / 2;
    label.position.set(0.1, 0.006, FOOT / 2 + 0.35 + LABEL_H / 2);
    group.add(label);

    const footprint = footprintLoop(FOOT + 0.3, FOOT + 0.3);
    group.add(footprint);

    const part: Part = { i, group, body, footprint, home, fam: null, ghost: null, paused: false, label: { mesh: label, canvas, tex }, mats: [], edges: [], state: null, tint: new CellTint(tintRegistry), clock: 0, speed: activeAll ? 1 : IDLE_SPEED };
    part.tint.sat.value = activeAll ? 1 : 0;
    label.userData.index = i;
    pickables.push(label);
    const hit = new THREE.Mesh(new THREE.BoxGeometry(FOOT + 0.3, 1.6, FOOT + 0.3), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 0.8;
    hit.userData.index = i;
    group.add(hit);
    pickables.push(hit);
    parts.push(part);

    if (!p.model && !p.effect) addPlate(part, p);
    part.tint.scan(group);
  });

  function addPlate(part: Part, p: Item) {
    const w = FOOT;
    const d = THREE.MathUtils.clamp(w / (p.aspect || 1.6), 1.6, FOOT);
    const side = new THREE.MeshStandardMaterial({ color: COLOR.plate, roughness: 0.55, metalness: 0.1 });
    const face = new THREE.MeshStandardMaterial({ color: p.thumb ? 0xffffff : COLOR.plate, roughness: 0.7 });
    if (p.thumb) {
      loader.load(p.thumb, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = maxAniso;
        face.map = t;
        face.needsUpdate = true;
        requestRender();
      });
    }
    const plate = new THREE.Mesh(new THREE.BoxGeometry(w, 0.14, d), [side, side, face, side, side, side]);
    plate.position.y = 0.07;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(plate.geometry), new THREE.LineBasicMaterial({ color: COLOR.edge }));
    plate.add(edges);
    plate.userData.index = part.i;
    part.body.add(plate);
    part.mats.push(side, face);
    part.edges.push(edges);
    pickables.push(plate);
    part.tint.scan(part.group);
  }

  // ------------------------------------------------------------ groups (parent + sub-projects)
  // Collapsed: the parent fills its cell and each sub-project hovers at a corner as a small x-ray ghost
  // on a dashed tether, its scene not started yet (or frozen). Split: every member flies to its own mini
  // cell in a row (same-row neighbours slide aside), a scan sheet passes over each one as it turns solid
  // and a chain dimension spans the row. `t` runs 0..1 and the layout is a pure function of it, so
  // collapsing is the same animation played backwards.
  type Ghost = {
    mat: THREE.MeshBasicMaterial;
    real: Map<THREE.Mesh, THREE.Material | THREE.Material[]>;
    hidden: Set<THREE.Object3D>;
    on: boolean;
    /** the scene may start (first split) */
    wake: boolean;
    phase: number;
    dash: THREE.LineDashedMaterial;
    solid: THREE.Material;
  };
  type Family = {
    parent: Part; kids: Part[]; members: Part[];
    t: number; target: number;
    /** split offsets from the parent's slot, and how far same-row neighbours move aside */
    opt: THREE.Vector3[]; shift: number;
    /** tethers, scan sheets and the dimension: outside the cells so the greyscale tint leaves them alone */
    ov: THREE.Group;
    tethers: { line: THREE.LineSegments; pos: THREE.BufferAttribute; dist: THREE.BufferAttribute }[];
    scans: THREE.Mesh[];
    dim: THREE.Group; dimLines: THREE.Object3D; dimMats: THREE.Material[];
    /** borrowed parents only: the parent's own model, shown in its mini cell while split */
    alt: THREE.Group | null; altLoading: boolean;
  };
  const families: Family[] = [];
  let expanded: Family | null = null;
  /** sub-project scenes waiting for their first split */
  const deferred = new Map<Part, () => void>();
  // ?splitT=0.5 freezes every split at that progress (with &expand=<slug>, for screenshots)
  const splitParam = new URLSearchParams(location.search).get('splitT');
  const frozenT = splitParam === null ? null : THREE.MathUtils.clamp(Number(splitParam) || 0, 0, 1);
  const scanGeo = new THREE.PlaneGeometry(FOOT + 0.3, 0.9).translate(0, 0.45, 0);
  const scanColor = new THREE.Color(COLOR.select);
  // scan sheet: bright at the floor, fading out upwards (additive, so black is invisible)
  scanGeo.setAttribute('color', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1], 3));
  const clamp01 = (x: number) => THREE.MathUtils.clamp(x, 0, 1);
  const lerp = THREE.MathUtils.lerp;
  // chain dimension in front of the split row's labels
  const DIM_Z = (FOOT / 2 + 0.35 + LABEL_H + 0.25) * SPLIT + 0.45;

  for (const i of topLevel) {
    const kids = parts.filter((pt) => parentOf[pt.i] === i);
    if (!kids.length) continue;
    const parent = parts[i];
    const members = [parent, ...kids];
    const m = members.length;
    const span = CELL_W * SPLIT;
    const opt = members.map((_, k) => new THREE.Vector3((k - (m - 1) / 2) * span, 0, 0));
    const ov = new THREE.Group();
    scene.add(ov);
    const fam: Family = { parent, kids, members, t: 0, target: 0, opt, shift: Math.max(0, (m * span - CELL_W) / 2), ov, tethers: [], scans: [], dim: new THREE.Group(), dimLines: new THREE.Group(), dimMats: [], alt: null, altLoading: false };
    members.forEach((pt) => (pt.fam = fam));
    kids.forEach((kid, k) => {
      const [gx, gz] = GHOST_SPOTS[k % GHOST_SPOTS.length];
      kid.home.set(parent.home.x + gx, GHOST_Y, parent.home.z + gz);
      kid.group.position.copy(kid.home);
      kid.group.scale.setScalar(GHOST);
      kid.footprint.computeLineDistances();
      kid.ghost = {
        mat: new THREE.MeshBasicMaterial({ color: COLOR.ghost, transparent: true, opacity: 0.22, depthWrite: false }),
        real: new Map(), hidden: new Set(), on: false, wake: false, phase: k * 1.9,
        dash: new THREE.LineDashedMaterial({ color: COLOR.sketch, transparent: true, opacity: 0.35, dashSize: 0.22, gapSize: 0.16 }),
        solid: kid.footprint.material as THREE.Material,
      };
      setGhost(kid, true);
      // tether: parent centre -> ground under the ghost -> ghost
      const pos = new THREE.BufferAttribute(new Float32Array(12), 3);
      const dist = new THREE.BufferAttribute(new Float32Array(4), 1);
      const line = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute('position', pos).setAttribute('lineDistance', dist),
        new THREE.LineDashedMaterial({ color: COLOR.sketch, transparent: true, opacity: 0.3, dashSize: 0.12, gapSize: 0.1, depthWrite: false }),
      );
      line.frustumCulled = false;
      ov.add(line);
      fam.tethers.push({ line, pos, dist });
    });
    for (let k = 0; k < m; k++) {
      const sc = new THREE.Mesh(scanGeo, new THREE.MeshBasicMaterial({
        color: 0, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
        // additive, leaving destination alpha alone so it composites over the page like the effects' glows
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      }));
      sc.visible = false;
      ov.add(sc);
      fam.scans.push(sc);
    }
    buildDimension(fam);
    families.push(fam);
  }

  /** Chain dimension behind the split row: extension lines, slash ticks and the group name. */
  function buildDimension(f: Family) {
    const y = 0.01;
    const x0 = f.opt[0].x, x1 = f.opt[f.opt.length - 1].x;
    const front = DIM_Z - 0.4; // starts just past each mini cell's label
    const pts: THREE.Vector3[] = [new THREE.Vector3(x0 - 0.25, y, DIM_Z), new THREE.Vector3(x1 + 0.25, y, DIM_Z)];
    for (const o of f.opt) {
      // extension line at each project's centre, through the dimension line
      pts.push(new THREE.Vector3(o.x, y, front), new THREE.Vector3(o.x, y, DIM_Z + 0.18));
      pts.push(new THREE.Vector3(o.x - 0.12, y, DIM_Z + 0.12), new THREE.Vector3(o.x + 0.12, y, DIM_Z - 0.12));
    }
    const lineMat = new THREE.LineBasicMaterial({ color: COLOR.sketch, transparent: true, opacity: 0, depthWrite: false });
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat);
    f.dimLines = lines;
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 96;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = COLOR.sketch;
    ctx.font = '500 46px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${data.parts[f.parent.i].title.toUpperCase()} / ${f.members.length} PROJECTS`, 512, 50, 1000);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAniso;
    const textMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false });
    const text = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 0.45), textMat);
    text.rotation.x = -Math.PI / 2;
    text.position.set(0, 0.012, DIM_Z + 0.34);
    f.dim.add(lines, text);
    f.dimMats = [lineMat, textMat];
    f.dim.visible = false;
    f.ov.add(f.dim);
  }

  /** X-ray look for a parked sub-project: one translucent material, lines and points hidden. Idempotent. */
  function setGhost(part: Part, on: boolean) {
    const g = part.ghost!;
    if (on) {
      part.body.traverse((o) => {
        const mesh = o as THREE.Mesh;
        const first = mesh.isMesh ? ((Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material) : null;
        // glows (shader or additive materials) would read as solid slabs: hide them
        const overlay = !!first && first !== g.mat && ((first as THREE.ShaderMaterial).isShaderMaterial || first.blending !== THREE.NormalBlending);
        if (mesh.isMesh && !overlay) {
          if (mesh.material !== g.mat) { g.real.set(mesh, mesh.material); mesh.material = g.mat; }
        } else if ((overlay || (o as THREE.Line).isLine || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite) && o.visible) {
          o.visible = false;
          g.hidden.add(o);
        }
      });
    } else {
      // an effect that swapped a material while starting up keeps its own
      for (const [mesh, mat] of g.real) if (mesh.material === g.mat) mesh.material = mat;
      for (const o of g.hidden) o.visible = true;
      g.real.clear();
      g.hidden.clear();
    }
    g.on = on;
    part.footprint.material = on ? g.dash : g.solid;
    (part.label.mesh.material as THREE.MeshBasicMaterial).opacity = on ? 0.5 : 1;
  }

  /** Start a sub-project's scene the first time its group splits. */
  function wake(kid: Part) {
    const g = kid.ghost;
    if (!g || g.wake) return;
    g.wake = true;
    const run = deferred.get(kid);
    deferred.delete(kid);
    run?.();
  }

  /** Borrowed parents (red.HEX shows HEX-VISION's scene) get their own static model for the split. */
  async function ensureAlt(f: Family) {
    const p = data.parts[f.parent.i];
    if (!p.borrowed || !p.model || f.alt || f.altLoading) return;
    f.altLoading = true;
    try {
      const { outer, model } = await orient(p.model);
      const pivot = new THREE.Group();
      pivot.add(outer);
      pivot.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(pivot, true);
      const size = box.getSize(new THREE.Vector3());
      pivot.scale.setScalar(Math.min(FOOT / Math.max(size.x, size.z, 1e-6), MAX_H / Math.max(size.y, 1e-6)));
      pivot.updateMatrixWorld(true);
      box.setFromObject(pivot, true);
      const c = box.getCenter(new THREE.Vector3());
      pivot.position.set(-c.x, -box.min.y, -c.z);
      model.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const list = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => (m as THREE.MeshStandardMaterial).clone());
        mesh.material = Array.isArray(mesh.material) ? list : list[0];
        f.parent.mats.push(...(list.filter((m) => 'emissive' in m) as THREE.MeshStandardMaterial[]));
      });
      const alt = new THREE.Group();
      alt.add(pivot);
      alt.scale.setScalar(p.modelScale ?? 1);
      alt.visible = false;
      f.parent.group.add(alt);
      f.parent.tint.scan(f.parent.group);
      f.alt = alt;
      f.parent.state = null;
      paint();
    } catch (err) {
      console.warn(`model failed for ${p.title}`, err);
    }
  }

  /** Same-row neighbours slide aside while a group is split. */
  function rowShift(home: THREE.Vector3, skip: Family | null) {
    let dx = 0;
    for (const f of families) {
      if (f === skip || f.t <= 0 || Math.abs(f.parent.home.z - home.z) > 0.01 || home.x === f.parent.home.x) continue;
      dx += Math.sign(home.x - f.parent.home.x) * f.shift * ease(f.t);
    }
    return dx;
  }

  /** Progress of one member: the parent leads, sub-projects follow a little staggered. */
  const memberT = (f: Family, k: number) => (k === 0 ? clamp01(f.t / 0.8) : clamp01((f.t - 0.12 * (k - 1)) / (1 - 0.12 * Math.max(0, f.members.length - 2))));

  function layout(now: number) {
    for (const i of topLevel) {
      const p = parts[i];
      if (!p.fam) p.group.position.set(p.home.x + rowShift(p.home, null), 0, p.home.z);
    }
    for (const f of families) {
      const bx = f.parent.home.x + rowShift(f.parent.home, f), bz = f.parent.home.z;
      f.ov.visible = f.parent.group.visible;
      f.members.forEach((pt, k) => {
        const l = memberT(f, k);
        const e = ease(l);
        const ox = bx + f.opt[k].x, oz = bz + f.opt[k].z;
        if (k === 0) {
          pt.group.position.set(lerp(bx, ox, e), 0, bz);
          pt.group.scale.setScalar(lerp(1, SPLIT, e));
          // a borrowed scene hands over to the parent's own model as the scan passes
          const own = !!f.alt && l >= 0.6;
          pt.body.visible = !own;
          if (f.alt) f.alt.visible = own;
          pt.paused = own;
        } else {
          const g = pt.ghost!;
          const drift = reducedMotion ? 0 : now * 0.001 + g.phase;
          const gx = bx + (pt.home.x - f.parent.home.x) + Math.cos(drift * 0.5) * 0.08;
          const gz = pt.home.z + Math.sin(drift * 0.5) * 0.08;
          const gy = GHOST_Y + Math.sin(drift * 1.3) * 0.06;
          pt.group.position.set(lerp(gx, ox, e), lerp(gy, 0, e) + Math.sin(Math.PI * e) * 0.6, lerp(gz, oz, e));
          pt.group.scale.setScalar(lerp(GHOST, SPLIT, e));
          const ghosted = l < 0.6;
          // re-applied while moving: a scene that starts mid-flight is ghosted too
          if (ghosted !== g.on || (ghosted && l > 0)) setGhost(pt, ghosted);
          pt.paused = ghosted;
          (pt.label.mesh.material as THREE.MeshBasicMaterial).opacity = ghosted ? lerp(0.5, 0.8, e) : 1;
          // tether
          const tt = f.tethers[k - 1];
          const a = f.parent.group.position, b = pt.group.position;
          tt.pos.setXYZ(0, a.x, 0.01, a.z);
          tt.pos.setXYZ(1, b.x, 0.01, b.z);
          tt.pos.setXYZ(2, b.x, 0.01, b.z);
          tt.pos.setXYZ(3, b.x, b.y, b.z);
          const d1 = Math.hypot(b.x - a.x, b.z - a.z);
          tt.dist.setX(1, d1);
          tt.dist.setX(2, d1);
          tt.dist.setX(3, d1 + b.y);
          tt.pos.needsUpdate = tt.dist.needsUpdate = true;
          (tt.line.material as THREE.LineDashedMaterial).opacity = 0.3 * (1 - e) + 0.6 * Math.sin(Math.PI * e);
          tt.line.visible = e < 0.999;
        }
        // scan sheet sweeps each project as it turns solid
        const sc = f.scans[k];
        const s = clamp01((l - 0.4) / 0.45);
        sc.visible = s > 0 && s < 1;
        if (sc.visible) {
          const sz = pt.group.scale.x;
          sc.position.set(pt.group.position.x, pt.group.position.y, pt.group.position.z + lerp(-1, 1, s) * ((FOOT + 0.3) / 2) * sz);
          sc.scale.setScalar(sz);
          (sc.material as THREE.MeshBasicMaterial).color.copy(scanColor).multiplyScalar(Math.sin(Math.PI * s) * 0.5);
        }
      });
      const grow = ease(clamp01((f.t - 0.45) / 0.55));
      f.dim.visible = grow > 0.001;
      f.dim.position.set(bx, 0, bz);
      f.dimLines.scale.x = Math.max(grow, 0.001);
      for (const m of f.dimMats) m.opacity = grow * 0.8;
    }
  }

  // ------------------------------------------------------------ models + effects
  const effects: { part: Part; effect: Effect }[] = [];
  let loadGltf: ((url: string) => Promise<THREE.Object3D>) | null = null;
  const gltfCache = new Map<string, Promise<THREE.Object3D>>();

  async function getLoader() {
    if (loadGltf) return loadGltf;
    const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      import('three/examples/jsm/libs/meshopt_decoder.module.js'),
    ]);
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    loadGltf = (url) => {
      if (!gltfCache.has(url)) gltfCache.set(url, loader.loadAsync(url).then((g) => g.scene));
      return gltfCache.get(url)!.then((scene) => scene.clone(true));
    };
    return loadGltf;
  }

  /** Model with its orientation applied: Z-up files stood up, then the extra rotation. */
  async function orient(ref: ModelRef) {
    const load = await getLoader();
    const model = await load(ref.url);
    const inner = new THREE.Group();
    inner.add(model);
    if (ref.up === 'z') inner.rotation.x = -Math.PI / 2;
    const outer = new THREE.Group();
    outer.rotation.set(...(ref.rotation.map((d) => THREE.MathUtils.degToRad(d)) as [number, number, number]), 'YXZ');
    outer.add(inner);
    outer.updateMatrixWorld(true);
    return { outer, model };
  }

  async function loadModels() {
    const withModels = parts.filter((pt) => data.parts[pt.i].model || data.parts[pt.i].effect);
    await Promise.all(
      withModels.map(async (part) => {
        const p = data.parts[part.i];
        const holder = new THREE.Group();
        part.body.add(holder);
        try {
          if (!p.model) {
            await startEffect(part, p, holder, 1);
            return;
          }
          const { outer, model } = await orient(p.model!);
          const pivot = new THREE.Group();
          pivot.add(outer);
          pivot.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(pivot, true);
          const size = box.getSize(new THREE.Vector3());
          const s = Math.min(FOOT / Math.max(size.x, size.z, 1e-6), MAX_H / Math.max(size.y, 1e-6));
          pivot.scale.setScalar(s);
          pivot.updateMatrixWorld(true);
          box.setFromObject(pivot, true);
          const c = box.getCenter(new THREE.Vector3());
          pivot.position.set(-c.x, -box.min.y, -c.z);

          model.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            const cloned = list.map((m) => (m as THREE.MeshStandardMaterial).clone());
            mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
            part.mats.push(...(cloned.filter((m) => 'emissive' in m) as THREE.MeshStandardMaterial[]));
          });
          holder.add(pivot);
          holder.scale.setScalar(p.modelScale ?? 1);
          part.tint.scan(part.group);
          part.state = null;
          paint();
          if (p.effect) await startEffect(part, p, holder, s);
        } catch (err) {
          console.warn(`model failed for ${p.title}, showing cover instead`, err);
          addPlate(part, p);
          paint();
        }
      }),
    );
  }

  async function startEffect(part: Part, p: Item, holder: THREE.Group, modelScale: number) {
    // grouping: a parked sub-project starts its scene on its group's first split (see wake())
    if (part.ghost && !part.ghost.wake) { deferred.set(part, () => void startEffect(part, p, holder, modelScale)); return; }
    const { loadEffect } = await import('./effects/index');
    const make = await loadEffect(p.effect!);
    if (!make) return;
    const ctx: EffectContext = {
      body: part.body,
      model: holder,
      modelScale,
      assets: data.assets,
      foot: FOOT,
      loadRaw: async (url, up, rotation) => (await orient({ url, up, rotation })).outer,
      pickable: (o) => { o.traverse((c) => { if ((c as THREE.Mesh).isMesh) { c.userData.index = part.i; pickables.push(c); } }); },
    };
    const effect = await make(ctx);
    // ?simulate=12 fast-forwards effects by that many seconds (for headless screenshot checks)
    const sim = Number(new URLSearchParams(location.search).get('simulate')) || 0;
    for (let k = 0; k < sim * 30; k++) effect.update(k / 30, 1 / 30);
    part.clock = sim;
    effects.push({ part, effect });
    part.tint.scan(part.group);
    requestRender();
  }

  // Effects animate continuously, but only while the viewport is on screen and the tab is visible.
  let effectsVisible = true;
  const forceEffects = new URLSearchParams(location.search).has('debug'); // headless screenshots report the page as hidden
  let last = performance.now();
  new IntersectionObserver((entries) => {
    effectsVisible = entries.some((e) => e.isIntersecting);
    if (effectsVisible) requestRender();
  }).observe(root);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) requestRender(); });

  // the dimensioned name sketch, in front of everything
  const sketchW = Math.min(cols * CELL_W * 0.8, 14);
  const sketchH = sketchW / data.logo.aspect;
  const sketch = new THREE.Mesh(
    new THREE.PlaneGeometry(sketchW, sketchH),
    new THREE.MeshBasicMaterial({ transparent: true, color: 0xd7dde6, depthWrite: false }),
  );
  sketch.rotation.x = -Math.PI / 2;
  sketch.position.set(0, 0.002, ((rows - 1) / 2) * CELL_D - 0.6 + CELL_D / 2 + 0.8 + sketchH / 2);
  loader.load(data.logo.src, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    (sketch.material as THREE.MeshBasicMaterial).map = t;
    (sketch.material as THREE.MeshBasicMaterial).needsUpdate = true;
    requestRender();
  });
  scene.add(sketch);

  // ------------------------------------------------------------ state
  let hovered = -1;
  let selected = -1;
  let mode: 'shaded' | 'wire' = 'shaded';

  function paint() {
    for (const p of parts) {
      const state: State = p.i === selected ? 'select' : p.i === hovered ? 'preselect' : 'none';
      const color = state === 'select' ? COLOR.select : state === 'preselect' ? COLOR.preselect : COLOR.sketch;
      if (p.state !== state) {
        drawLabel(p.label.canvas, data.parts[p.i].title, stamp(data.parts[p.i]), color);
        p.label.tex.needsUpdate = true;
        p.state = state;
      }
      const fm = p.footprint.material as THREE.LineBasicMaterial;
      fm.color.set(color);
      fm.opacity = state === 'none' ? 0.35 : 1;
      for (const m of p.mats) {
        m.emissive?.setHex(EMISSIVE[state]);
        m.wireframe = mode === 'wire';
      }
      for (const e of p.edges) (e.material as THREE.LineBasicMaterial).color.set(state === 'none' ? COLOR.edge : color);
      if (p.ghost?.on) {
        setGhost(p, true); // picks up meshes that loaded since
        p.ghost.mat.color.set(state === 'none' ? COLOR.ghost : color);
        p.ghost.mat.wireframe = mode === 'wire';
      }
    }
    document.querySelectorAll<HTMLElement>('a[data-part]').forEach((el) => {
      el.classList.toggle('is-preselect', el.dataset.part === String(hovered));
      el.classList.toggle('is-selected', el.dataset.part === String(selected));
    });
    root.classList.toggle('is-hovering', hovered >= 0);
    requestRender();
  }

  // ------------------------------------------------------------ properties panel
  const propsDefault = document.getElementById('props-default');
  const propsPart = document.getElementById('props-part');

  function showProps(i: number) {
    if (!propsDefault || !propsPart) return;
    propsDefault.hidden = i >= 0;
    propsPart.hidden = i < 0;
    if (i < 0) return;
    const p = data.parts[i];
    const bind = (k: string) => propsPart.querySelectorAll<HTMLElement>(`[data-bind="${k}"]`);
    bind('title').forEach((e) => (e.textContent = p.title));
    bind('no').forEach((e) => (e.textContent = p.no));
    bind('year').forEach((e) => (e.textContent = p.year ? String(p.year) : ''));
    bind('summary').forEach((e) => (e.textContent = p.summary));
    bind('status').forEach((e) => { e.textContent = p.status.replace('-', ' '); e.dataset.status = p.status; });
    bind('url').forEach((e) => ((e as HTMLAnchorElement).href = p.url));
    bind('thumb').forEach((e) => { const img = e as HTMLImageElement; if (p.thumb) img.src = p.thumb; img.parentElement!.hidden = !p.thumb; });
    bind('tags')[0]?.replaceChildren(...p.tags.map((t) => Object.assign(document.createElement('span'), { className: 'chip', textContent: t })));
    propsPart.querySelector<HTMLElement>('[data-row="tags"]')!.hidden = !p.tags.length;
  }

  // camera pose before a group split, restored when it collapses back with nothing else selected
  let camBefore: [THREE.Vector3, THREE.Vector3] | null = null;
  let lastSplitTick = performance.now();
  let splitAt = -Infinity;

  /** Split one group (collapsing any other), or collapse with null. Returns true if anything changed. */
  function setExpanded(f: Family | null) {
    if (f === expanded) return false;
    lastSplitTick = performance.now();
    if (expanded) expanded.target = 0;
    if (f && !camBefore) camBefore = [controls.target.clone(), camera.position.clone()];
    expanded = f;
    if (f) {
      f.target = 1;
      splitAt = performance.now();
      f.kids.forEach(wake);
      void ensureAlt(f);
    }
    if (frozenT !== null) for (const g of families) g.t = g.target * frozenT;
    requestRender();
    return true;
  }

  /** Camera on a split group: the row of mini cells and its dimension, from the current direction. */
  function frameFamily(f: Family, animate = !reducedMotion && frozenT === null) {
    const bounds = new THREE.Box3();
    const cell = new THREE.Box3();
    const half = (FOOT / 2 + 0.15) * SPLIT;
    for (const o of f.opt) {
      const x = f.parent.home.x + o.x, z = f.parent.home.z + o.z;
      cell.min.set(x - half, 0, z - half);
      cell.max.set(x + half, MAX_H * SPLIT, z + DIM_Z + 0.6);
      bounds.union(cell);
    }
    // current direction, but looking down at least ~50 degrees so the row in front does not crowd it
    const dir = camera.position.clone().sub(controls.target).normalize();
    const flat = Math.hypot(dir.x, dir.z) || 1;
    if (dir.y < 0.77) dir.set((dir.x / flat) * 0.64, 0.77, (dir.z / flat) * 0.64);
    fitBox(bounds, dir, animate, 0.72, SPLIT_MS);
  }

  function select(i: number, focus = false) {
    const fam = i >= 0 ? parts[i].fam : null;
    const changed = setExpanded(fam);
    selected = i;
    paint();
    showProps(i);
    if (fam) {
      if (changed) frameFamily(fam);
    } else if (i >= 0) {
      camBefore = null;
      if (focus) {
        const target = parts[i].home.clone().add(new THREE.Vector3(0, 0.8, 0.6));
        const offset = camera.position.clone().sub(controls.target);
        flyTo(target, target.clone().add(offset.setLength(Math.min(offset.length(), 13))));
      }
    } else if (changed && camBefore) {
      // collapsed with nothing selected: back to where the camera was before the split
      flyTo(camBefore[0], camBefore[1], SPLIT_MS);
      camBefore = null;
    }
  }

  // ------------------------------------------------------------ camera
  let flight: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t0: number; dur: number } | null = null;

  function flyTo(target: THREE.Vector3, position: THREE.Vector3, dur = 520, animate = !reducedMotion) {
    if (!animate) {
      controls.target.copy(target);
      camera.position.copy(position);
      requestRender();
      return;
    }
    flight = { from: [controls.target.clone(), camera.position.clone()], to: [target, position], t0: performance.now(), dur };
    requestRender();
  }

  function fitDirection(dir: THREE.Vector3, animate = !reducedMotion) {
    const bounds = new THREE.Box3();
    // cell footprints, not the objects inside: effects park unused particles far below the floor
    const cell = new THREE.Box3();
    for (const p of parts) {
      if (!p.group.visible) continue;
      const c = p.group.position;
      const s = p.group.scale.x; // groups: ghosts and split cells are scaled
      cell.min.set(c.x - (FOOT / 2) * s, c.y, c.z - (FOOT / 2) * s);
      cell.max.set(c.x + (FOOT / 2) * s, c.y + MAX_H * s, c.z + (FOOT / 2 + LABEL_H + 0.4) * s);
      bounds.union(cell);
    }
    bounds.expandByObject(sketch);
    fitBox(bounds, dir, animate);
  }

  /** Camera along `dir` with the box filling `fill` of the view. */
  function fitBox(bounds: THREE.Box3, dir: THREE.Vector3, animate = !reducedMotion, fill = 0.9, dur = 520) {
    // Fit the actual box corners on screen (tighter than a bounding sphere).
    const center = bounds.getCenter(new THREE.Vector3());
    const unit = dir.clone().normalize();
    const probe = camera.clone();
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => new THREE.Vector3(
      k & 1 ? bounds.max.x : bounds.min.x, k & 2 ? bounds.max.y : bounds.min.y, k & 4 ? bounds.max.z : bounds.min.z,
    ));
    let dist = 40;
    for (let it = 0; it < 6; it++) {
      probe.position.copy(center).addScaledVector(unit, dist);
      probe.lookAt(center);
      probe.updateMatrixWorld();
      let extent = 0;
      for (const c of corners) {
        const p = c.clone().project(probe);
        extent = Math.max(extent, Math.abs(p.x), Math.abs(p.y));
      }
      dist *= extent / fill;
    }
    // Re-centre: the box centre isn't the centre of its projection under perspective
    for (let it = 0; it < 3; it++) {
      probe.position.copy(center).addScaledVector(unit, dist);
      probe.lookAt(center);
      probe.updateMatrixWorld();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const c of corners) {
        const p = c.clone().project(probe);
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      }
      const halfH = Math.tan(THREE.MathUtils.degToRad(probe.fov / 2)) * dist;
      const right = new THREE.Vector3().setFromMatrixColumn(probe.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(probe.matrixWorld, 1);
      center.addScaledVector(right, ((x0 + x1) / 2) * halfH * probe.aspect).addScaledVector(up, ((y0 + y1) / 2) * halfH);
      dist *= Math.max(x1 - x0, y1 - y0) / 2 / (fill + 0.02);
    }
    flyTo(center, center.clone().addScaledVector(unit, dist), dur, animate);
  }

  const VIEWS: Record<string, THREE.Vector3> = {
    iso: new THREE.Vector3(0.55, 1.0, 1.45),
    top: new THREE.Vector3(0, 1, 0.0001),
    bottom: new THREE.Vector3(0, -1, 0.0001),
    front: new THREE.Vector3(0, 0.12, 1),
    back: new THREE.Vector3(0, 0.12, -1),
    right: new THREE.Vector3(1, 0.12, 0),
    left: new THREE.Vector3(-1, 0.12, 0),
  };
  const setView = (name: string) => (name === 'fit' ? fitDirection(camera.position.clone().sub(controls.target)) : fitDirection(VIEWS[name]));

  // ------------------------------------------------------------ view cube + triad
  const cube = root.querySelector<HTMLElement>('.viewcube-inner');
  const triad = root.querySelector<SVGSVGElement>('.triad');
  const inv = new THREE.Matrix4();
  const q = new THREE.Quaternion();

  function updateOverlays() {
    if (cube) {
      inv.makeRotationFromQuaternion(camera.quaternion).invert();
      const e = inv.elements;
      cube.style.transform = `matrix3d(${e[0]},${-e[1]},${e[2]},0,${-e[4]},${e[5]},${-e[6]},0,${e[8]},${-e[9]},${e[10]},0,0,0,0,1)`;
    }
    if (triad) {
      q.copy(camera.quaternion).invert();
      // CAD convention: Z up. three Y -> Z, three -Z -> Y.
      const axes: Record<string, THREE.Vector3> = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 0, -1), z: new THREE.Vector3(0, 1, 0) };
      for (const [k, v] of Object.entries(axes)) {
        v.applyQuaternion(q);
        const x = v.x * 20, y = -v.y * 20;
        const line = triad.querySelector(`[data-axis="${k}"]`)!;
        line.setAttribute('x2', String(x));
        line.setAttribute('y2', String(y));
        const label = triad.querySelector(`[data-label="${k}"]`)!;
        label.setAttribute('x', String(x * 1.35 - 3.5));
        label.setAttribute('y', String(y * 1.35 + 3.5));
      }
    }
  }
  root.querySelectorAll<HTMLElement>('.viewcube-face').forEach((f) => f.addEventListener('click', () => setView(f.dataset.face!)));

  // ------------------------------------------------------------ render loop (on demand)
  let frame = 0;
  function requestRender() {
    if (!frame) frame = requestAnimationFrame(tick);
  }

  let intro: { t0: number } | null = reducedMotion ? null : { t0: performance.now() };
  // Performance: only ambient animation running -> cap at ~30 fps; resolution adapts to frame time.
  const maxDpr = Math.min(devicePixelRatio, 2);
  let dpr = maxDpr;
  let lastRender = 0;
  let slowFrames = 0, fastFrames = 0;
  let scanFrame = 0;
  function tick(now: number) {
    frame = 0;
    let moving = false;
    let interactive = false;
    if (flight) {
      const t = THREE.MathUtils.clamp((now - flight.t0) / flight.dur, 0, 1); // rAF time can trail performance.now()
      const k = ease(t);
      controls.target.lerpVectors(flight.from[0], flight.to[0], k);
      camera.position.lerpVectors(flight.from[1], flight.to[1], k);
      if (t >= 1) flight = null;
      moving = true;
      interactive = true;
    }
    if (intro) {
      // projects rise into place from below the top plane
      const t = Math.min((now - intro.t0) / 1100, 1);
      for (const p of parts) {
        const local = THREE.MathUtils.clamp(t * 1.6 - p.i * 0.05, 0, 1);
        p.body.scale.setScalar(Math.max(ease(local), 0.001));
      }
      if (t >= 1) { intro = null; for (const p of parts) p.body.scale.setScalar(1); } else moving = true;
    }
    if (controls.update()) { moving = true; interactive = true; }
    if (intro) interactive = true;
    if (frozenT === null && families.some((f) => f.t !== f.target)) { moving = true; interactive = true; } // group split
    if (!interactive && effects.length && now - lastRender < 31 && !forceEffects) {
      requestRender(); // skip this frame, keep the loop alive
      return;
    }
    const frameMs = now - lastRender;
    lastRender = now;
    if (frameMs < 100) {
      if (frameMs > (interactive ? 24 : 40)) { slowFrames++; fastFrames = 0; } else { fastFrames++; slowFrames = 0; }
      if (slowFrames > 20 && dpr > 1) { dpr = Math.max(1, dpr - 0.25); renderer.setPixelRatio(dpr); resize(); slowFrames = 0; }
      if (fastFrames > 240 && dpr < maxDpr) { dpr = Math.min(maxDpr, dpr + 0.25); renderer.setPixelRatio(dpr); resize(); fastFrames = 0; }
    }
    const dt = THREE.MathUtils.clamp((now - last) / 1000, 0, 0.1); // rAF time can trail performance.now() on the first frames
    last = now;
    // groups: advance any split / collapse, then place every cell (ghosts drift, so this runs each frame)
    // own clock (dt above is capped at 0.1 s): a frame stalled by shader compiles must not slow the split down
    const splitDt = THREE.MathUtils.clamp(now - lastSplitTick, 0, 400);
    lastSplitTick = now;
    for (const f of families) {
      if (frozenT !== null || f.t === f.target) continue;
      const step = reducedMotion ? 1 : splitDt / SPLIT_MS;
      f.t = f.target > f.t ? Math.min(f.target, f.t + step) : Math.max(f.target, f.t - step);
    }
    layout(now);
    // colour and speed ease toward full for the hovered / selected cell, and back to slow grey for the rest
    const k = 1 - Math.exp(-dt * 6);
    let tinting = false;
    for (const p of parts) {
      const active = activeAll || p.i === hovered || p.i === selected || data.parts[p.i].slug === activeParam;
      const speed = active ? 1 : IDLE_SPEED;
      const sat = active ? 1 : 0;
      if (Math.abs(p.speed - speed) > 0.002 || Math.abs(p.tint.sat.value - sat) > 0.002) {
        p.speed += (speed - p.speed) * k;
        p.tint.sat.value += (sat - p.tint.sat.value) * k;
        p.tint.flush();
        tinting = true;
      }
    }
    if (tinting) moving = true;
    if (effects.length && ((effectsVisible && !document.hidden) || forceEffects)) {
      for (const { part: p, effect } of effects) {
        if (p.paused) continue; // parked ghost, or a borrowed scene handed over while split
        const step = reducedMotion ? 0 : dt * p.speed;
        p.clock += step;
        effect.update(reducedMotion ? 2 : p.clock, step);
      }
      // effects spawn new objects (sparks, appliances, toys): pick up their materials now and then
      if (++scanFrame % 45 === 0) for (const { part: p } of effects) p.tint.scan(p.group);
      if (!reducedMotion) moving = true;
    }
    renderer.render(scene, camera);
    updateOverlays();
    if (moving) requestRender();
  }
  controls.addEventListener('change', requestRender);

  // ------------------------------------------------------------ picking
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tip = root.querySelector<HTMLElement>('.vp-tip');

  function pick(ev: PointerEvent | MouseEvent) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(pickables.filter((o) => parts[o.userData.index]?.group.visible), false)[0];
    return hit ? (hit.object.userData.index as number) : -1;
  }

  let down: { x: number; y: number } | null = null;
  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  let pendingMove: PointerEvent | null = null;
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons) { if (tip) tip.hidden = true; return; }
    if (!pendingMove) requestAnimationFrame(() => { const ev = pendingMove!; pendingMove = null; hover(ev); });
    pendingMove = e;
  });
  // hovering a group fetches what its split needs (sub-project scene code, the parent's own model)
  const warmed = new WeakSet<Family>();
  function warm(f: Family) {
    if (warmed.has(f)) return;
    warmed.add(f);
    void ensureAlt(f);
    void import('./effects/index').then(({ loadEffect }) => f.kids.forEach((k) => data.parts[k.i].effect && loadEffect(data.parts[k.i].effect!)));
  }
  function hover(e: PointerEvent) {
    const i = pick(e);
    if (i !== hovered) { hovered = i; paint(); }
    const fam = i >= 0 ? parts[i].fam : null;
    if (fam) warm(fam);
    if (tip) {
      tip.hidden = i < 0 || e.pointerType === 'touch';
      if (i >= 0) {
        const r = root.getBoundingClientRect();
        // collapsed groups say what is inside; parked ghosts say whose they are
        const extra = fam && fam !== expanded ? (i === fam.parent.i ? `+${fam.kids.length} inside, click to split` : `in ${data.parts[fam.parent.i].title}`) : '';
        tip.replaceChildren(data.parts[i].title, Object.assign(document.createElement('small'), { textContent: extra ? `${data.parts[i].no} · ${extra}` : data.parts[i].no }));
        tip.style.left = `${e.clientX - r.left + 14}px`;
        tip.style.top = `${e.clientY - r.top + 16}px`;
      }
    }
  }
  canvas.addEventListener('pointerleave', () => { hovered = -1; if (tip) tip.hidden = true; paint(); });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || e.button !== 0) return;
    // the second click of a double-click on a group that just split keeps the selection (dblclick opens it)
    if (e.pointerType !== 'touch' && performance.now() - splitAt < 450) return;
    const i = pick(e);
    if (i >= 0 && i === selected && e.pointerType === 'touch') location.href = data.parts[i].url;
    else select(i, i >= 0);
  });
  canvas.addEventListener('dblclick', (e) => {
    const i = performance.now() - splitAt < 700 ? selected : pick(e);
    if (i >= 0) location.href = data.parts[i].url;
  });

  root.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).closest('input')) return;
    const k = e.key;
    // tree order: each project followed by its sub-projects
    const at = navOrder.indexOf(selected), len = navOrder.length;
    if (k === 'ArrowRight' || k === 'ArrowDown') { select(navOrder[(at + 1) % len], true); e.preventDefault(); }
    else if (k === 'ArrowLeft' || k === 'ArrowUp') { select(navOrder[at < 0 ? len - 1 : (at - 1 + len) % len], true); e.preventDefault(); }
    else if (k === 'Enter' && selected >= 0) location.href = data.parts[selected].url;
    else if (k === 'Escape') select(-1);
    else if (k === 'f' || k === 'F') setView('fit');
    else if (k === '0') setView('iso');
    else if (k === '1') setView('top');
    else if (k === '2') setView('front');
  });

  // ------------------------------------------------------------ DOM hooks
  document.querySelectorAll<HTMLAnchorElement>('a[data-part]').forEach((a) => {
    const i = Number(a.dataset.part);
    a.addEventListener('mouseenter', () => { hovered = i; paint(); });
    a.addEventListener('mouseleave', () => { hovered = -1; paint(); });
    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || selected === i) return; // second click follows the link
      e.preventDefault();
      select(i, true);
    });
  });
  document.querySelector('[data-action="deselect"]')?.addEventListener('click', () => select(-1));
  document.querySelectorAll<HTMLElement>('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view!)));
  document.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      mode = b.dataset.mode as typeof mode;
      document.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      paint();
    }),
  );

  const filter = document.querySelector<HTMLInputElement>('[data-filter]');
  filter?.addEventListener('input', () => {
    const term = filter.value.trim().toLowerCase();
    const match = (i: number) => !term || data.parts[i].title.toLowerCase().includes(term);
    document.querySelectorAll<HTMLElement>('a[data-part]').forEach((a) => {
      const i = Number(a.dataset.part);
      const fam = parts[i].fam;
      // a group stays whole in the scene if any member matches; the tree keeps the parent of a match
      const any = fam ? fam.members.some((m) => match(m.i)) : match(i);
      a.hidden = !(match(i) || (fam && any && (i === fam.parent.i || match(fam.parent.i))));
      parts[i].group.visible = any;
    });
    requestRender();
  });

  // ------------------------------------------------------------ sizing + start
  function resize() {
    const { clientWidth: w, clientHeight: h } = root;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    requestRender();
  }
  new ResizeObserver(resize).observe(root);
  resize();
  layout(performance.now());
  fitDirection(VIEWS.iso, false);
  paint();
  // ?expand=<slug> splits that project's group on load (add &splitT=0..1 to freeze the animation)
  const expandSlug = new URLSearchParams(location.search).get('expand');
  if (expandSlug && slugIndex.has(expandSlug)) select(slugIndex.get(expandSlug)!, true);
  const focusSlug = new URLSearchParams(location.search).get('view');
  loadModels().then(() => {
    const i = focusSlug ? data.parts.findIndex((p) => p.slug === focusSlug) : -1;
    if (i < 0) return;
    const target = parts[i].group.position.clone().add(new THREE.Vector3(0, 0.9, 0));
    const q = new URLSearchParams(location.search);
    const dir = (q.get('dir') || '').split(',').map(Number);
    const d = dir.length === 3 && dir.every(Number.isFinite) ? new THREE.Vector3(...dir) : VIEWS.iso.clone();
    flyTo(target, target.clone().addScaledVector(d.normalize(), Number(q.get('dist')) || 9), 520, false);
  });
}

function fallback(root: HTMLElement, data: Data) {
  const wrap = document.createElement('div');
  wrap.className = 'cards';
  wrap.style.cssText = 'position:absolute;inset:0;overflow:auto';
  for (const p of data.parts) {
    const a = document.createElement('a');
    a.className = 'card';
    a.href = p.url;
    if (p.thumb) a.append(Object.assign(document.createElement('img'), { src: p.thumb, alt: '', loading: 'lazy' }));
    const d = document.createElement('div');
    d.append(Object.assign(document.createElement('small'), { textContent: p.no }), document.createElement('br'), p.title);
    a.append(d);
    wrap.append(a);
  }
  root.querySelectorAll('.viewcube, .triad, .vp-hint').forEach((e) => e.remove());
  root.append(wrap);
}
