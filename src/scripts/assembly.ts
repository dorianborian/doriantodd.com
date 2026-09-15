// Home page: every project sits on the top plane as a 3D model with a sketch-style label.
// Projects without a model yet show their cover image on a plate. Hover to preselect, click to
// select, double-click (or Enter) to open. Renders on demand only.

import * as THREE from './three-lite';
import type { Effect, EffectContext } from './effects/types';
import { CellTint } from './desaturate';
const { OrbitControls } = THREE;

type ModelRef = { url: string; up: 'y' | 'z'; rotation: [number, number, number] };

type Item = {
  slug: string; year: number | null; modelScale: number; title: string; summary: string; tags: string[]; status: string; url: string; no: string;
  thumb: string | null; aspect: number; model: ModelRef | null; effect: string | null;
};
type Data = { parts: Item[]; logo: { src: string; aspect: number }; assets: { robot: ModelRef | null; photos: string[] } };
type State = 'none' | 'preselect' | 'select';

const COLOR = {
  sketch: '#aeb6c2',
  preselect: '#f2b84b',
  select: '#4a9bff',
  plate: 0x8a929e,
  edge: 0x0c0d0f,
};
const EMISSIVE: Record<State, number> = { none: 0x000000, preselect: 0x3a2a08, select: 0x0b2547 };

const FOOT = 3.0;        // max model footprint
const MAX_H = 2.6;       // max model height
const CELL_W = 4.6;
const CELL_D = 5.0;
const LABEL_H = 0.78;
const LIFT = 1.4;

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
  const n = data.parts.length;
  const cols = n <= 4 ? n : n <= 9 ? 3 : 4;
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
    body: THREE.Group;        // model or plate; lifted by explode
    footprint: THREE.LineLoop;
    mate: THREE.Line;
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
    const col = i % cols;
    const row = Math.floor(i / cols);
    const group = new THREE.Group();
    group.position.set((col - (cols - 1) / 2) * CELL_W, 0, (row - (rows - 1) / 2) * CELL_D - 0.6);
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

    const mate = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)]),
      new THREE.LineDashedMaterial({ color: COLOR.select, dashSize: 0.08, gapSize: 0.08 }),
    );
    mate.computeLineDistances();
    mate.visible = false;
    group.add(mate);

    const part: Part = { i, group, body, footprint, mate, label: { mesh: label, canvas, tex }, mats: [], edges: [], state: null, tint: new CellTint(tintRegistry), clock: 0, speed: activeAll ? 1 : IDLE_SPEED };
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
  let explode = Number(document.querySelector<HTMLInputElement>('[data-explode]')?.value ?? 0) / 100;
  let hovered = -1;
  let selected = -1;
  let mode: 'shaded' | 'wire' = 'shaded';

  function applyExplode() {
    for (const p of parts) {
      const lift = explode * LIFT;
      p.body.position.y = lift;
      p.mate.visible = lift > 0.03;
      p.mate.scale.y = Math.max(lift, 0.001);
    }
    requestRender();
  }

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

  function select(i: number, focus = false) {
    selected = i;
    paint();
    showProps(i);
    if (i >= 0 && focus) {
      const target = parts[i].group.position.clone().add(new THREE.Vector3(0, 0.8, 0.6));
      const offset = camera.position.clone().sub(controls.target);
      flyTo(target, target.clone().add(offset.setLength(Math.min(offset.length(), 13))));
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
    for (const p of parts) if (p.group.visible) bounds.expandByObject(p.group);
    bounds.expandByObject(sketch);
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
      dist *= extent / 0.9;
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
      dist *= Math.max(x1 - x0, y1 - y0) / 2 / 0.92;
    }
    flyTo(center, center.clone().addScaledVector(unit, dist), 520, animate);
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
      const t = Math.min((now - flight.t0) / flight.dur, 1);
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
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
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
  function hover(e: PointerEvent) {
    const i = pick(e);
    if (i !== hovered) { hovered = i; paint(); }
    if (tip) {
      tip.hidden = i < 0 || e.pointerType === 'touch';
      if (i >= 0) {
        const r = root.getBoundingClientRect();
        tip.replaceChildren(data.parts[i].title, Object.assign(document.createElement('small'), { textContent: data.parts[i].no }));
        tip.style.left = `${e.clientX - r.left + 14}px`;
        tip.style.top = `${e.clientY - r.top + 16}px`;
      }
    }
  }
  canvas.addEventListener('pointerleave', () => { hovered = -1; if (tip) tip.hidden = true; paint(); });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || e.button !== 0) return;
    const i = pick(e);
    if (i >= 0 && i === selected && e.pointerType === 'touch') location.href = data.parts[i].url;
    else select(i, i >= 0);
  });
  canvas.addEventListener('dblclick', (e) => {
    const i = pick(e);
    if (i >= 0) location.href = data.parts[i].url;
  });

  root.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).closest('input')) return;
    const k = e.key;
    if (k === 'ArrowRight' || k === 'ArrowDown') { select((selected + 1) % n, true); e.preventDefault(); }
    else if (k === 'ArrowLeft' || k === 'ArrowUp') { select((selected - 1 + n) % n, true); e.preventDefault(); }
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
  document.querySelector<HTMLInputElement>('[data-explode]')?.addEventListener('input', (e) => {
    explode = Number((e.target as HTMLInputElement).value) / 100;
    applyExplode();
  });

  const filter = document.querySelector<HTMLInputElement>('[data-filter]');
  filter?.addEventListener('input', () => {
    const term = filter.value.trim().toLowerCase();
    document.querySelectorAll<HTMLElement>('a[data-part]').forEach((a) => {
      const match = !term || a.dataset.title!.includes(term);
      a.hidden = !match;
      parts[Number(a.dataset.part)].group.visible = match;
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
  fitDirection(VIEWS.iso, false);
  applyExplode();
  paint();
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
