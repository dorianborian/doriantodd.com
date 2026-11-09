// Article header for Sesame Drone: the rigged robot from its Fusion export (effects/drone-rig.ts), orbitable.
// Walk, Drone mode and Take off play the real sequence; the sliders pose it by hand. The thrust arrows show why the
// legs sit on hard end stops in drone mode: let an arm droop and its thrust tilts, swing a hip and it does not.

import { h, segmented, slider } from './ui';
import type { DronePose } from '../effects/drone-rig';

type Mode = 'walk' | 'drone' | 'fly' | 'manual';

const S = 10; // rig metres -> scene units
const ALT = 0.05; // hover height, CAD metres
const DEG = Math.PI / 180;
const DEMO: [Mode, number][] = [['walk', 4.5], ['drone', 2.2], ['fly', 5.5], ['drone', 1.6]];

export default async function droneHero(el: HTMLElement) {
  const THREE = await import('../three-lite');
  const [{ GLTFLoader }, { MeshoptDecoder }, { buildDroneRig, CENTER }] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/libs/meshopt_decoder.module.js'),
    import('../effects/drone-rig'),
  ]);
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync('/rigs/sesame-drone/rig.glb');

  // ---- DOM
  el.innerHTML = '';
  el.classList.add('sd-hero');
  const stage = h('div', { class: 'sd-stage' });
  const panel = h('div', { class: 'sd-panel' });
  const readout = h('div', { class: 'sd-readout' });
  const hint = h('div', { class: 'sd-hint' }, 'Drag to orbit, scroll to zoom');
  el.append(stage, panel, readout, hint);

  let mode: Mode = 'walk';
  let demo = true, demoStep = 0, demoT = 0;
  const target = { fold: 0, hip: 0, throttle: 0 };
  const pick = (m: Mode, fromUser: boolean) => {
    mode = m;
    if (fromUser) demo = false;
    seg.set(m === 'manual' ? '' : m);
  };
  const seg = segmented([{ id: 'walk', label: 'Walk' }, { id: 'drone', label: 'Drone mode' }, { id: 'fly', label: 'Take off' }], 'walk', (id) => pick(id as Mode, true));
  const foldS = slider('Leg fold', 0, 90, 1, 0, (v) => `${Math.round(v)}°`, (v) => { target.fold = v / 90; pick('manual', true); });
  const hipS = slider('Hip swing', -30, 30, 1, 0, (v) => `${Math.round(v)}°`, (v) => { target.hip = v * DEG; pick('manual', true); });
  const thrS = slider('Throttle', 0, 100, 1, 0, (v) => `${Math.round(v)}%`, (v) => { target.throttle = v / 100; pick('manual', true); });
  panel.append(h('div', { class: 'sd-title' }, 'Pose it'), seg.el, foldS.el, hipS.el, thrS.el);
  // ?sdmode=walk|drone|fly starts in that mode (screenshot checks); ?sdmode=manual&fold=60&throttle=80 poses it
  const params = new URLSearchParams(location.search);
  const forced = params.get('sdmode') as Mode | null;
  if (forced) {
    target.fold = Number(params.get('fold') ?? 90) / 90;
    target.throttle = Number(params.get('throttle') ?? 0) / 100;
    target.hip = Number(params.get('hip') ?? 0) * DEG;
    pick(forced, true);
    foldS.set(target.fold * 90); thrS.set(target.throttle * 100); hipS.set(target.hip / DEG);
  }

  // ---- three.js
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.append(renderer.domElement);
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xe6ecf5, 0x2a2c31, 0.7));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(2, 4, 3);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 60);
  camera.position.set(-2.1, 1.35, 2.5);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.42, 0);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.5;
  controls.minDistance = 1.4;
  controls.maxDistance = 7;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.enablePan = false;
  controls.addEventListener('start', () => { controls.autoRotate = false; });

  const grid = new THREE.GridHelper(6, 30, 0x3a4250, 0x262b33);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.55;
  scene.add(grid);
  const blob = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.6)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: blob, transparent: true, depthWrite: false }));
  shadow.position.y = 0.003;
  scene.add(shadow);

  // the rig faces +z with the hips' centre on the holder's origin (CAD (x, z) -> (z, -x) after the +90 deg turn)
  const holder = new THREE.Group();
  scene.add(holder);
  const cad = gltf.scene;
  cad.scale.setScalar(S);
  cad.rotation.y = Math.PI / 2;
  cad.position.set(-CENTER.z * S, 0, CENTER.x * S);
  holder.add(cad);
  const bot = await buildDroneRig(cad);

  // thrust arrows: one per prop, along the prop axis
  const arrowMat = new THREE.MeshBasicMaterial({ color: 0xf2b84b, transparent: true, opacity: 0.9, depthWrite: false });
  const arrows = bot.legs.map(() => {
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 10).translate(0, 0.5, 0), arrowMat);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.09, 14).translate(0, 0.045, 0), arrowMat);
    g.add(shaft, head);
    g.renderOrder = 3;
    scene.add(g);
    return { g, shaft, head };
  });

  // keep the orbit direction, pull back on narrow screens so the whole robot stays in frame
  const VIEW = new THREE.Vector3(-2.1, 0.93, 2.5).normalize();
  const resize = () => {
    const w = stage.clientWidth, hh = stage.clientHeight;
    if (!w || !hh) return;
    renderer.setSize(w, hh, false);
    camera.aspect = w / hh;
    const dir = camera.position.clone().sub(controls.target);
    if (!(dir.lengthSq() > 1e-6 && dir.lengthSq() < 1e6)) dir.copy(VIEW);
    camera.position.copy(controls.target).addScaledVector(dir.normalize(), 5.2 / Math.pow(Math.min(1, camera.aspect), 0.8));
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(stage);
  resize();

  // ---- state
  const pose: DronePose = { fold: 0, hips: [0, 0, 0, 0], lift: [0, 0, 0, 0], rps: 0 };
  let alt = 0, gait = 0, walkAmp = 1, lastFace = '';
  const v = new THREE.Vector3(), up = new THREE.Vector3(), bodyUp = new THREE.Vector3(), q = new THREE.Quaternion();
  const approach = (cur: number, to: number, rate: number, dt: number) => cur + Math.sign(to - cur) * Math.min(Math.abs(to - cur), rate * dt);

  const step = (time: number, dt: number) => {
    if (demo) {
      demoT += dt;
      if (demoT > DEMO[demoStep][1]) { demoT = 0; demoStep = (demoStep + 1) % DEMO.length; }
      if (mode !== DEMO[demoStep][0]) pick(DEMO[demoStep][0], false);
    }
    // what each mode asks for
    let foldTo = target.fold, rpsTo = target.throttle * 45, altTo = 0, hip = target.hip;
    if (mode === 'walk') { foldTo = 0; rpsTo = 0; hip = 0; }
    if (mode === 'drone') { foldTo = 1; rpsTo = pose.fold > 0.99 ? 5 : 0; hip = 0; }
    if (mode === 'fly') { foldTo = 1; rpsTo = pose.fold > 0.99 ? 42 : 0; altTo = pose.rps > 38 ? ALT : 0; hip = 0; }
    if (mode === 'manual') altTo = pose.fold > 0.995 && target.throttle > 0.72 ? ALT * Math.min(1, (target.throttle - 0.72) / 0.2) : 0;
    // drone mode lowers the legs onto the stops at servo speed; nothing moves the legs while it is in the air
    if (alt < 0.002) pose.fold = approach(pose.fold, foldTo, 1.3, dt);
    pose.rps = approach(pose.rps, rpsTo, pose.rps < rpsTo ? 45 : 60, dt);
    alt += (altTo - alt) * Math.min(1, dt * (altTo > alt ? 2.2 : 1.6));

    // trot in place while walking
    walkAmp = approach(walkAmp, mode === 'walk' && pose.fold < 0.02 ? 1 : 0, 3, dt);
    gait = (gait + dt / 0.9) % 1;
    for (let i = 0; i < 4; i++) {
      const ph = (gait + (i === 0 || i === 3 ? 0 : 0.5)) % 1;
      const swing = ph < 0.5, u = swing ? ph * 2 : (ph - 0.5) * 2;
      const wig = Math.sin(time * 5.1) * 0.08 * Math.min(1, alt / 0.02); // hips wander a little in the air
      pose.hips[i] = (swing ? -0.22 + 0.44 * u : 0.22 - 0.44 * u) * walkAmp + hip * (i < 2 ? 1 : -1) + (i === 0 || i === 3 ? wig : -wig);
      pose.lift[i] = (swing ? 0.5 * Math.sin(Math.PI * u) : 0) * walkAmp;
    }
    const face = alt > 0.01 ? 'happy' : mode === 'fly' || (mode === 'drone' && pose.fold > 0.99) ? 'excited' : 'idle';
    if (face !== lastFace) { lastFace = face; bot.face(face); }
    bot.pose(pose, time, dt);

    const air = Math.min(1, alt / 0.015);
    const ground = bot.ground();
    holder.position.y = (alt - ground) * S + air * Math.sin(time * 3.1) * 0.02;
    controls.target.y += (0.42 + alt * S * 0.6 - controls.target.y) * Math.min(1, dt * 2); // follow it up a little
    holder.rotation.set(Math.sin(time * 7.3) * 0.045 * air, Math.sin(time * 0.6) * 0.25 * air, Math.sin(time * 6.1 + 1.3) * 0.045 * air, 'YXZ');
    shadow.scale.setScalar(1 + alt * 8);
    (shadow.material as THREE.MeshBasicMaterial).opacity = 1 - air * 0.5;

    // arrows from each prop hub, along its axis, sized by thrust; tilt is measured against the body's own up
    holder.updateMatrixWorld(true);
    bodyUp.set(0, 1, 0).applyQuaternion(holder.getWorldQuaternion(q));
    let tilt = 0;
    const thrust = Math.min(1, pose.rps / 42);
    bot.legs.forEach((leg, i) => {
      const a = arrows[i];
      leg.disc.getWorldPosition(v);
      up.set(0, 1, 0).applyQuaternion(leg.prop.group.getWorldQuaternion(q));
      tilt = Math.max(tilt, Math.acos(Math.min(1, up.dot(bodyUp))) / DEG);
      a.g.position.copy(v).addScaledVector(up, 0.05);
      a.g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      const len = 0.12 + 0.48 * thrust;
      a.shaft.scale.set(1, len, 1);
      a.head.position.y = len;
      a.g.visible = thrust > 0.06;
    });
    arrowMat.color.set(tilt > 3 ? 0xff6b5a : 0xf2b84b);

    if (mode !== 'manual') { foldS.set(pose.fold * 90); thrS.set(Math.round(thrust * 100)); hipS.set(0); }
    const deg = Math.round(pose.fold * 90);
    const onStops = pose.fold > 0.995;
    const state = alt > 0.01 ? 'Flying' : onStops ? 'Drone mode' : pose.fold < 0.01 ? 'Walking' : 'Folding';
    readout.innerHTML = `<small>${state}</small>`
      + `<div class="sd-row"><span>Legs</span><b>${deg}°</b><i class="${onStops ? 'ok' : pose.fold > 0.01 ? 'warn' : ''}">${onStops ? 'on the end stops' : pose.fold > 0.01 ? 'held by the servos' : 'walking'}</i></div>`
      + `<div class="sd-row"><span>Thrust</span><b>${Math.round(thrust * 100)}%</b><i class="${thrust > 0.06 && tilt > 3 ? 'bad' : ''}">${thrust > 0.06 ? (tilt > 3 ? `tilted ${Math.round(tilt)}°, the controller has to fight it` : 'straight up') : 'off'}</i></div>`;
  };

  let visible = true, running = false, last = 0;
  const loop = () => {
    if (!visible) { running = false; return; }
    const now = performance.now() / 1000;
    const dt = Math.min(now - last, 0.05);
    last = now;
    step(now, dt);
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  const kick = () => { if (visible && !running) { running = true; last = performance.now() / 1000; requestAnimationFrame(loop); } };
  // screenshot checks: settle the forced mode first (software GL in virtual time runs few frames)
  if (forced) for (let k = 0; k < 240; k++) step(k / 30, 1 / 30);
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; kick(); }).observe(el);
  kick();
}
