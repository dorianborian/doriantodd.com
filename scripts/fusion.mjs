// Converts a "Fusion360-ThreeJSExporter" folder (assembly.json + models/*.obj/.mtl) into web assets:
//   <out>/rig.glb    one node per occurrence (node name = occurrence id), meshes in WORLD metres, CAD Z-up
//                    (rotate -90 deg about X in three.js), simplified with meshoptimizer, one material per colour
//   <out>/rig.json   { design, occurrences: [{ id, name, grounded, jointed, bbox }], joints } straight from the export
//
//   node scripts/fusion.mjs <exportDir> <outDir> [--ratio 0.15] [--error 0.002] [--min-size 0.004] [--skip regex]
//
// Export format notes (checked against the files, the bundled viewer.html gets this wrong):
//   - OBJ vertices are in the occurrence's LOCAL frame, in centimetres.
//   - world = world_transform_row_major (translation in metres) * (local * 0.01)
//   - joint origins/axes are world metres, Z-up. Joint data from the exporter is noisy: duplicated joints,
//     "cylindrical" joints for pin slots, parent/child sometimes reversed. Treat it as hints for pivots and axes.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const args = process.argv.slice(2);
const [src, out] = args;
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const RATIO = Number(opt('ratio', 0.15));
const ERROR = Number(opt('error', 0.002));
const MIN_SIZE = Number(opt('min-size', 0)); // drop parts whose largest extent (m) is below this
const SKIP = opt('skip', null) ? new RegExp(opt('skip'), 'i') : null;
if (!src || !out) { console.error('usage: node scripts/fusion.mjs <exportDir> <outDir> [--ratio 0.15]'); process.exit(1); }

const asm = JSON.parse(await fsp.readFile(path.join(src, 'assembly.json'), 'utf8'));

async function readMtl(file) {
  const colors = {};
  if (!file || !fs.existsSync(file)) return colors;
  let cur = null;
  for (const line of (await fsp.readFile(file, 'utf8')).split(/\r?\n/)) {
    if (line.startsWith('newmtl ')) cur = line.slice(7).trim();
    else if (cur && line.startsWith('Kd ')) colors[cur] = line.split(/\s+/).slice(1, 4).map(Number);
  }
  return colors;
}

/** Streams an OBJ: returns { positions: number[] (cm), groups: Map<material, number[] triangle vertex indices> } */
async function readObj(file) {
  const pos = [];
  const groups = new Map();
  let mat = 'default';
  let tri = groups.get(mat) ?? [];
  groups.set(mat, tri);
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    const c = line.charCodeAt(0);
    if (c === 118 && line.charCodeAt(1) === 32) { // 'v '
      const p = line.split(/\s+/);
      pos.push(+p[1], +p[2], +p[3]);
    } else if (c === 102 && line.charCodeAt(1) === 32) { // 'f '
      const p = line.split(/\s+/);
      const idx = [];
      for (let k = 1; k < p.length; k++) {
        if (!p[k]) continue;
        let n = parseInt(p[k], 10);
        if (n < 0) n = pos.length / 3 + n + 1;
        idx.push(n - 1);
      }
      for (let k = 1; k + 1 < idx.length; k++) tri.push(idx[0], idx[k], idx[k + 1]);
    } else if (line.startsWith('usemtl ')) {
      mat = line.slice(7).trim();
      tri = groups.get(mat) ?? [];
      groups.set(mat, tri);
    }
  }
  return { positions: pos, groups };
}

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene(asm.design?.name ?? 'assembly');
const materials = new Map();
const matFor = (rgb, rough = 0.5, metal = 0.1) => {
  const key = rgb.map((v) => v.toFixed(3)).join(',');
  if (!materials.has(key)) {
    materials.set(key, doc.createMaterial(`c${materials.size}`).setBaseColorFactor([...rgb, 1]).setRoughnessFactor(rough).setMetallicFactor(metal));
  }
  return materials.get(key);
};
// sRGB colour from the export to the linear factor glTF expects
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const occOut = [];
let tris = 0;
for (const occ of asm.occurrences) {
  if (SKIP && SKIP.test(occ.id)) continue;
  const file = path.join(src, occ.mesh_file ?? `models/${occ.id}.obj`);
  if (!fs.existsSync(file)) { console.warn('missing', occ.id); continue; }
  const { positions, groups } = await readObj(file);
  const M = occ.world_transform_row_major ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const world = new Float32Array(positions.length);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] * 0.01, y = positions[i + 1] * 0.01, z = positions[i + 2] * 0.01;
    for (let r = 0; r < 3; r++) {
      const v = M[r * 4] * x + M[r * 4 + 1] * y + M[r * 4 + 2] * z + M[r * 4 + 3];
      world[i + r] = v;
      lo[r] = Math.min(lo[r], v);
      hi[r] = Math.max(hi[r], v);
    }
  }
  if (MIN_SIZE && Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) < MIN_SIZE) continue;
  const mtl = await readMtl(path.join(src, occ.mtl_file ?? `models/${occ.id}.mtl`));
  const app = occ.appearance ?? occ.bodies?.find((b) => b.appearance)?.appearance;
  const mesh = doc.createMesh(occ.id);
  const posAcc = doc.createAccessor().setType('VEC3').setArray(world).setBuffer(buffer);
  for (const [name, idx] of groups) {
    if (!idx.length) continue;
    const rgb = (mtl[name] ?? app?.color_rgba?.slice(0, 3) ?? [0.6, 0.6, 0.6]).map(lin);
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', posAcc)
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(buffer))
      .setMaterial(matFor(rgb, app?.roughness ?? 0.5, app?.metallic ?? 0.1));
    mesh.addPrimitive(prim);
    tris += idx.length / 3;
  }
  if (!mesh.listPrimitives().length) continue;
  scene.addChild(doc.createNode(occ.id).setMesh(mesh));
  occOut.push({ id: occ.id, name: occ.name, grounded: !!occ.is_grounded, jointed: !!occ.is_jointed, bbox: [lo, hi] });
}

await doc.transform(
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: RATIO, error: ERROR }),
  dedup(),
  prune(),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);
await fsp.mkdir(out, { recursive: true });
await new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder }).write(path.join(out, 'rig.glb'), doc);
await fsp.writeFile(path.join(out, 'rig.json'), JSON.stringify({ design: asm.design, occurrences: occOut, joints: asm.joints }, null, 1));
const kb = fs.statSync(path.join(out, 'rig.glb')).size / 1024;
console.log(`${occOut.length} parts, ${Math.round(tris)} source tris -> rig.glb ${kb.toFixed(0)} KB`);
