// Article header for Fly Brain Bridge: the sampled MaleCNS point cloud, orbitable, with the
// project's circuits as buttons. Picking one fires its stimulus neurons, a wave crosses the brain,
// and the command neurons light up with the firing rate measured in the real simulation.

import { h } from './ui';

type Group = { id: string; label: string; color: string; idx: number[] };
type Episode = { stim: Group; cmd: Group; action: string };

const FAMILY = [0x2ec4b6, 0x3a5bff, 0x4cc9f0, 0x8b5cf6, 0xff9f1c, 0xffd166, 0x2a9d8f, 0xef476f];
const FAMILY_NAMES = ['sensory', 'optic lobe', 'visual projection', 'central brain', 'descending', 'ascending', 'nerve cord', 'motor'];
// peak rates from scripts/behavior_check.py in the project
const RESULT: Record<string, { hz: number; behavior: string }> = {
  feed: { hz: 45, behavior: 'Feeding' }, escape: { hz: 380, behavior: 'Escape' }, groom: { hz: 94, behavior: 'Grooming' },
  walk: { hz: 109, behavior: 'Walk forward' }, left: { hz: 113, behavior: 'Turn left' }, dance: { hz: 171, behavior: 'Courtship song' },
  back: { hz: 50, behavior: 'Back away' },
};

const VERT = /* glsl */ `
  attribute float aAct;
  attribute vec3 aColor;
  attribute vec3 aHot;
  uniform float uSize;
  varying vec3 vCol;
  varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (1.0 + aAct * 2.5) / -mv.z;
    vCol = mix(aColor * 0.6, aHot, clamp(aAct, 0.0, 1.0));
    vA = 0.45 + aAct * 1.7;
  }
`;
const FRAG = /* glsl */ `
  varying vec3 vCol;
  varying float vA;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = dot(p, p) * 4.0;
    if (d > 1.0) discard;
    float k = 1.0 - d;
    gl_FragColor = vec4(vCol * k * k * vA, 1.0);
  }
`;

export default async function hero(el: HTMLElement) {
  const THREE = await import('../three-lite');
  const [buf, data] = await Promise.all([
    fetch('/flybrain/brain.bin').then((r) => r.arrayBuffer()),
    fetch('/flybrain/brain-groups.json').then((r) => r.json() as Promise<{ episodes: Episode[] }>),
  ]);
  const n = new DataView(buf).getUint32(0, true);
  const q = new Int16Array(buf, 8, n * 3);
  const fam = new Uint8Array(buf, 8 + n * 6, n);

  // normalise to a unit box centred on the brain (the nerve cord trails toward -z)
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), hot = new Float32Array(n * 3).fill(1), act = new Float32Array(n);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { const v = a === 2 ? -q[i * 3 + a] : q[i * 3 + a]; lo[a] = Math.min(lo[a], v); hi[a] = Math.max(hi[a], v); }
  const s = 2 / Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (q[i * 3] - (lo[0] + hi[0]) / 2) * s;
    pos[i * 3 + 1] = (q[i * 3 + 1] - (lo[1] + hi[1]) / 2) * s;
    pos[i * 3 + 2] = (-q[i * 3 + 2] - (lo[2] + hi[2]) / 2) * s;
    c.setHex(FAMILY[fam[i]] ?? 0xffffff);
    col.set([c.r, c.g, c.b], i * 3);
  }

  // ---- DOM: canvas, circuit buttons, readout, legend
  el.innerHTML = '';
  el.classList.add('fb-hero');
  const stage = h('div', { class: 'fb-stage' });
  const menu = h('div', { class: 'fb-menu' }, h('div', { class: 'fb-menu-title' }, 'Stimulate'));
  const readout = h('div', { class: 'fb-readout' });
  const legend = h('div', { class: 'fb-legend' }, ...FAMILY_NAMES.map((name, i) => h('span', { style: `--c:#${FAMILY[i].toString(16).padStart(6, '0')}` }, name)));
  const hint = h('div', { class: 'fb-hint' }, 'Drag to orbit, scroll to zoom');
  el.append(stage, menu, readout, legend, hint);

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  stage.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 50);
  camera.position.set(0.9, 0.5, 2.6);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.6;
  controls.minDistance = 0.8;
  controls.maxDistance = 6;
  controls.enablePan = false;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  const hotAttr = new THREE.BufferAttribute(hot, 3);
  const actAttr = new THREE.BufferAttribute(act, 1);
  geo.setAttribute('aHot', hotAttr);
  geo.setAttribute('aAct', actAttr);
  const uniforms = { uSize: { value: 11 * renderer.getPixelRatio() } };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const cloud = new THREE.Points(geo, mat);
  cloud.rotation.x = -0.25;
  scene.add(cloud);

  const point = (i: number) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  const centroid = (g: Group) => g.idx.reduce((v, i) => v.add(point(i)), new THREE.Vector3()).multiplyScalar(1 / Math.max(1, g.idx.length));
  const episodes = data.episodes.map((e) => {
    const a = centroid(e.stim), b = centroid(e.cmd), ab = b.clone().sub(a);
    const path: { i: number; t: number }[] = [];
    for (let i = 0; i < n; i += 2) {
      const p = point(i);
      const t = Math.min(1, Math.max(0, p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-6)));
      if (p.distanceTo(a.clone().addScaledVector(ab, t)) < 0.1 + Math.sin(t * Math.PI) * 0.12) path.push({ i, t });
    }
    return { ...e, path, sc: new THREE.Color(e.stim.color), cc: new THREE.Color(e.cmd.color) };
  });

  let current = 0, start = -10, auto = true, lastPick = -99;
  const buttons = episodes.map((e, k) => {
    const b = h('button', { type: 'button', style: `--c:${e.stim.color}` }, h('span', {}, e.stim.label), h('small', {}, RESULT[e.action]?.behavior ?? ''));
    b.addEventListener('click', () => { auto = false; lastPick = performance.now() / 1000; fire(k); });
    menu.append(b);
    return b;
  });
  const fire = (k: number) => {
    current = k;
    start = performance.now() / 1000;
    const e = episodes[k];
    hot.fill(1);
    for (const p of e.path) hot.set([0.75, 0.82, 1], p.i * 3);
    for (const i of e.stim.idx) hot.set([e.sc.r, e.sc.g, e.sc.b], i * 3);
    for (const i of e.cmd.idx) hot.set([e.cc.r, e.cc.g, e.cc.b], i * 3);
    hotAttr.needsUpdate = true;
    buttons.forEach((b, j) => b.setAttribute('aria-pressed', String(j === k)));
  };

  const resize = () => {
    const w = stage.clientWidth, hh = stage.clientHeight;
    renderer.setSize(w, hh, false);
    camera.aspect = w / Math.max(1, hh);
    // pull back on narrow screens so the whole brain stays in frame
    camera.position.setLength(2.8 / Math.pow(Math.min(1, camera.aspect), 0.85));
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(stage);
  resize();

  let visible = true, running = false;
  const kick = () => { if (visible && !running) { running = true; last = performance.now() / 1000; requestAnimationFrame(loop); } };
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; kick(); }).observe(el);
  let last = performance.now() / 1000;
  fire(0);
  function loop() {
    if (!visible) { running = false; return; }
    const now = performance.now() / 1000;
    const dt = Math.min(now - last, 0.05);
    last = now;
    if (!auto && now - lastPick > 12) auto = true;
    const t = (now - start) / 5;
    if (t > 1 && auto) fire((current + 1) % episodes.length);
    const e = episodes[current];
    const decay = Math.exp(-dt * 4.5);
    for (let i = 0; i < n; i++) act[i] *= decay;
    const pulse = (a: number, b: number) => (t > a && t < b ? Math.sin(((t - a) / (b - a)) * Math.PI) : 0);
    const sAmp = pulse(0, 0.4), cAmp = pulse(0.35, 0.9);
    for (const i of e.stim.idx) if (Math.random() < 0.6 * sAmp) act[i] = Math.max(act[i], 1 + Math.random() * 0.4);
    if (t > 0.1 && t < 0.6) { const f = (t - 0.1) / 0.45; for (const p of e.path) if (Math.abs(p.t - f) < 0.08 && Math.random() < 0.35) act[p.i] = Math.max(act[p.i], 0.6 + Math.random() * 0.3); }
    for (const i of e.cmd.idx) if (Math.random() < 0.75 * cAmp) act[i] = Math.max(act[i], 1.2 + Math.random() * 0.5);
    for (let j = 0; j < 80; j++) { const i = (Math.random() * n) | 0; act[i] = Math.max(act[i], 0.3 * Math.random()); }
    actAttr.needsUpdate = true;

    const r = RESULT[e.action];
    const hz = Math.round((r?.hz ?? 0) * cAmp);
    readout.innerHTML = `<small>${t < 0.35 ? 'Stimulus' : 'Command neurons'}</small><strong style="color:${t < 0.35 ? e.stim.color : e.cmd.color}">${t < 0.35 ? e.stim.label : e.cmd.label}</strong>`
      + `<div class="fb-meter"><i style="width:${Math.min(100, (hz / 400) * 100)}%;background:${e.cmd.color}"></i></div><span class="fb-hz">${hz} Hz per neuron</span>`
      + `<span class="fb-behavior${cAmp > 0.3 ? ' on' : ''}">${r?.behavior ?? ''}</span>`;
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  kick();
}
