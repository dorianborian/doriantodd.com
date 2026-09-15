// Digital mosaic: a 15 x 15 grid of glowing tiles fitted exactly onto the clear front panel.
// The panel in the model is slightly tilted, so its plane is measured from the mesh itself.

import * as THREE from '../three-lite';
import { glowMaterial } from './shared';
import type { EffectContext, Effect } from './types';

// Ten LED patterns, evaluated per tile. The effect cycles through them with a short crossfade.
const PATTERNS = /* glsl */ `
  uniform float uTime;
  uniform vec2 uGrid;
  uniform float uModeA;
  uniform float uModeB;
  uniform float uMix;
  varying vec2 vUv;
  vec3 hsv2rgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
  }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  // c: tile centre in 0..1 (y up), cell: integer tile, t: time
  vec3 pattern(float mode, vec2 c, vec2 cell, float t) {
    vec2 q = c - 0.5;
    float r = length(q);
    float a = atan(q.y, q.x);
    if (mode < 0.5) { // gradient waves
      float hue = fract(0.55 + 0.16 * sin(t * 0.25 + c.x * 2.4) + (c.x - c.y) * 0.35 + t * 0.04);
      return hsv2rgb(vec3(hue, 0.92, 1.0)) * (0.6 + 0.4 * sin(t * 1.3 - (c.x * 1.3 + c.y) * 5.5));
    }
    if (mode < 1.5) { // rainbow ripples from the centre
      float w = sin(r * 26.0 - t * 4.0);
      return hsv2rgb(vec3(fract(r * 1.5 - t * 0.15), 0.9, 1.0)) * smoothstep(0.0, 0.9, w * 0.5 + 0.5);
    }
    if (mode < 2.5) { // rain: a drop per column falling at its own speed
      float sp = 0.5 + hash(vec2(cell.x, 3.0)) * 0.9;
      float head = fract(t * sp * 0.55 + hash(vec2(cell.x, 9.0)));
      float y = 1.0 - c.y;
      float d = head - y;
      float trail = d >= 0.0 ? exp(-d * 9.0) : 0.0;
      return hsv2rgb(vec3(0.5 + 0.12 * sin(cell.x), 0.85, 1.0)) * trail + vec3(0.9) * step(abs(d), 0.03);
    }
    if (mode < 3.5) { // spiral arms
      float s = sin(a * 3.0 + r * 18.0 - t * 3.0);
      return hsv2rgb(vec3(fract(a / 6.2832 + t * 0.08), 0.95, 1.0)) * smoothstep(0.2, 1.0, s);
    }
    if (mode < 4.5) { // sparkle: random tiles flash and fade
      float seed = hash(cell);
      float ph = fract(t * (0.35 + seed * 0.5) + seed * 7.0);
      float flash = pow(1.0 - ph, 6.0);
      return hsv2rgb(vec3(fract(seed * 3.7 + t * 0.03), 0.6, 1.0)) * flash + vec3(0.02, 0.03, 0.08);
    }
    if (mode < 5.5) { // plasma
      float v = sin(c.x * 9.0 + t) + sin((c.y * 7.0 + t * 1.3)) + sin((c.x + c.y) * 6.0 + t * 0.7) + sin(r * 14.0 - t * 1.6);
      return hsv2rgb(vec3(fract(v * 0.12 + t * 0.05), 0.85, 0.55 + 0.45 * sin(v * 1.5)));
    }
    if (mode < 6.5) { // checkerboard that flips in diagonal waves
      float chk = mod(cell.x + cell.y, 2.0);
      float flip = step(0.0, sin(t * 2.2 - (cell.x + cell.y) * 0.45));
      vec3 x = hsv2rgb(vec3(fract(t * 0.07), 0.9, 1.0)), y = hsv2rgb(vec3(fract(t * 0.07 + 0.5), 0.9, 1.0));
      return mix(x, y, abs(chk - flip)) * 0.9;
    }
    if (mode < 7.5) { // radar sweep with fading trail
      float sweep = fract((a / 6.2832) - t * 0.35);
      float trail = pow(1.0 - sweep, 5.0) * smoothstep(0.72, 0.1, r);
      return vec3(0.15, 1.0, 0.45) * trail + vec3(0.0, 0.15, 0.05) * step(abs(fract(r * 5.0) - 0.5), 0.08);
    }
    if (mode < 8.5) { // fire rising from the bottom
      float n = hash(vec2(cell.x, floor(t * 9.0 + cell.y * 0.5)));
      float heat = clamp((1.0 - c.y * 1.25) + (n - 0.5) * 0.5 + 0.12 * sin(t * 3.0 + cell.x), 0.0, 1.0);
      return vec3(1.0, 0.25, 0.02) * heat + vec3(1.0, 0.85, 0.2) * pow(heat, 3.0);
    }
    // expanding square rings, like a heartbeat
    float ring = max(abs(q.x), abs(q.y));
    float beat = fract(t * 0.6);
    float wave = exp(-abs(ring - beat * 0.75) * 22.0);
    return hsv2rgb(vec3(fract(0.95 + ring * 0.4 + t * 0.02), 0.9, 1.0)) * wave;
  }
  vec3 leds(vec2 c, vec2 cell) {
    return mix(pattern(uModeA, c, cell, uTime), pattern(uModeB, c, cell, uTime), uMix);
  }
`;
const FRAG = /* glsl */ `
  ${PATTERNS}
  void main() {
    vec2 g = vUv * uGrid;
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;
    vec3 col = leds((cell + 0.5) / uGrid, cell);
    float d = max(abs(f.x), abs(f.y));
    float tile = smoothstep(0.45, 0.37, d);
    float halo = exp(-length(f) * 5.0) * 0.2;
    gl_FragColor = vec4(col * (tile * 0.85 + halo), 0.0);
  }
`;
const GLOW = /* glsl */ `
  ${PATTERNS}
  void main() {
    // the glow around the panel takes the colour of the nearest edge tiles
    vec2 c = clamp((vUv - 0.5) * 1.9 + 0.5, 0.0, 1.0);
    vec2 cell = floor(c * uGrid * 0.999);
    vec3 col = leds((cell + 0.5) / uGrid, cell);
    vec2 e = abs(vUv - 0.5) * 2.0;
    float falloff = pow(clamp(1.0 - max(e.x, e.y), 0.0, 1.0), 2.5);
    gl_FragColor = vec4(col * falloff * 0.22, 0.0);
  }
`;
const VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/** Eigen-decomposition of a symmetric 3x3 matrix (Jacobi). Returns eigenvectors sorted by eigenvalue, largest first. */
function eigen(m: number[][]) {
  const a = m.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-12) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return [0, 1, 2]
    .map((i) => ({ value: a[i][i], vec: new THREE.Vector3(v[0][i], v[1][i], v[2][i]).normalize() }))
    .sort((x, y) => y.value - x.value);
}

export default function mosaic(ctx: EffectContext): Effect {
  ctx.body.updateMatrixWorld(true);
  const toBody = new THREE.Matrix4().copy(ctx.body.matrixWorld).invert();

  const pts: THREE.Vector3[] = [];
  let fallback = true;
  ctx.model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const mat = mesh.material as THREE.Material | undefined;
    if (!mesh.isMesh || !mat || !/acrylic|clear/i.test(mat.name)) return;
    fallback = false;
    const pos = mesh.geometry.attributes.position;
    const m = new THREE.Matrix4().multiplyMatrices(toBody, mesh.matrixWorld);
    const stepN = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += stepN) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m));
  });
  if (fallback) {
    const b = new THREE.Box3().setFromObject(ctx.model, true).applyMatrix4(toBody);
    for (let i = 0; i < 8; i++) pts.push(new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
  }

  // Plane fit
  const mean = pts.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(pts.length);
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) {
    const d = [p.x - mean.x, p.y - mean.y, p.z - mean.z];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[r][c] += d[r] * d[c];
  }
  const [e0, e1, e2] = eigen(cov);
  let u = e0.vec, v = e1.vec, n = e2.vec;
  // n faces the viewer (+z), u runs along +x, v completes a right-handed basis
  if (n.z < 0) n.negate();
  if (Math.abs(u.y) > Math.abs(u.x)) [u, v] = [v, u];
  if (u.x < 0) u.negate();
  v = new THREE.Vector3().crossVectors(n, u).normalize();

  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity, nmax = -Infinity;
  for (const p of pts) {
    const d = p.clone().sub(mean);
    const pu = d.dot(u), pv = d.dot(v), pn = d.dot(n);
    umin = Math.min(umin, pu); umax = Math.max(umax, pu);
    vmin = Math.min(vmin, pv); vmax = Math.max(vmax, pv);
    nmax = Math.max(nmax, pn);
  }
  const inset = fallback ? 0.8 : 0.96;
  const w = (umax - umin) * inset;
  const h = (vmax - vmin) * inset;
  const center = mean.clone().addScaledVector(u, (umin + umax) / 2).addScaledVector(v, (vmin + vmax) / 2).addScaledVector(n, nmax + 0.02);
  const basis = new THREE.Matrix4().makeBasis(u, v, n);

  const uniforms = { uTime: { value: 0 }, uGrid: { value: new THREE.Vector2(15, 15) }, uModeA: { value: 0 }, uModeB: { value: 1 }, uMix: { value: 0 } };
  // play every pattern for a few seconds, crossfading into the next in a shuffled order
  const MODES = 10, HOLD = 6.5, FADE = 1.2;
  const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  if (!new URLSearchParams(location.search).has('debug')) order.sort(() => Math.random() - 0.5);
  const tiles = new THREE.Mesh(new THREE.PlaneGeometry(w, h), glowMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG }));
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.9, h * 1.9), glowMaterial({ uniforms, vertexShader: VERT, fragmentShader: GLOW }));
  for (const [mesh, off] of [[tiles, 0], [glow, 0.02]] as const) {
    mesh.quaternion.setFromRotationMatrix(basis);
    mesh.position.copy(center).addScaledVector(n, off);
    mesh.renderOrder = 5;
  }
  // dark tile bed behind the LEDs so colours stay saturated over the light wood
  const bed = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0x050607 }));
  bed.quaternion.setFromRotationMatrix(basis);
  bed.position.copy(center).addScaledVector(n, -0.01);
  ctx.body.add(bed);
  const light = new THREE.PointLight(0x66ccff, 1.2, 3, 1.6);
  light.position.copy(center).addScaledVector(n, 0.7);
  ctx.body.add(tiles, glow, light);

  return {
    update(t) {
      uniforms.uTime.value = t;
      const slot = Math.floor(t / HOLD);
      const into = t - slot * HOLD;
      uniforms.uModeA.value = order[((slot % MODES) + MODES) % MODES];
      uniforms.uModeB.value = order[(((slot + 1) % MODES) + MODES) % MODES];
      const m = Math.min(1, Math.max(0, (into - (HOLD - FADE)) / FADE));
      uniforms.uMix.value = m * m * (3 - 2 * m);
      light.color.setHSL((0.87 + t * 0.04) % 1, 0.8, 0.55);
    },
  };
}
