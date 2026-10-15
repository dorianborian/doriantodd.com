// Progressive detail levels for the GLB files the home scene loads.
//
//   npm run lods                      every src/content/projects/*/model-lite.glb and every GLB under public/
//   npm run lods -- public/rigs/x/rig.glb   just these files
//   npm run lods -- --force           rebuild files that look up to date
//
// For <name>.glb it writes <name>.lod0.glb (a few percent of the triangles, a few KB) and <name>.lod1.glb
// (about a quarter of the triangles) next to it. Nodes, names, hierarchy, transforms, materials and vertex
// attribute types are left exactly as they are, only each primitive's triangles are reduced, so the home page
// can show lod0 at once and later swap finer geometry into the same meshes (src/scripts/progressive.ts).
// The extreme vertices of every primitive stay in its vertex buffer, so bounding boxes (model sizing, effects that measure
// parts) come out the same at every level. Primitives under MIN_TRIS triangles are kept whole.
//
// It also writes src/scripts/lods.json (URL of the full file -> level URLs, triangles, bytes), which the home
// page reads to know which files have levels. Rerun after `npm run models`, scripts/fusion.mjs or
// scripts/sesame-rig.mjs, then rebuild the site.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS = path.join(ROOT, 'src', 'content', 'projects');
const PUBLIC = path.join(ROOT, 'public');
const MANIFEST = path.join(ROOT, 'src', 'scripts', 'lods.json');
// Files below this size load fast enough on their own; an extra request would not help.
const MIN_BYTES = 100_000;
// Consumers that copy the geometry out of the file (so a later swap could not reach it) get no levels.
const EXCLUDE = new Set(['public/sesame/rig.glb']); // effects/sesame-rig.ts bakes its own geometry copies
const MIN_TRIS = 200; // small parts stay whole: effects measure some of them (e.g. the mosaic plane-fits its clear panel)
const LEVELS = [
  { ratio: 0.035, error: 0.15, sloppy: true }, // lod0: the silhouette, a few percent of the triangles
  { ratio: 0.3, error: 0.03 }, // lod1: close to the real thing at home page sizes
];

const FORCE = process.argv.includes('--force');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const lodPath = (file, i) => file.replace(/\.glb$/i, `.lod${i}.glb`);
const isLod = (f) => /\.lod\d\.glb$/i.test(f);

/** Site URL a source file is served at. */
function urlOf(file) {
  const r = rel(file);
  if (r.startsWith('src/content/')) return `/content-assets/${r.slice('src/content/'.length)}`;
  if (r.startsWith('public/')) return `/${r.slice('public/'.length)}`;
  throw new Error(`${r} is not served by the site`);
}

async function* walk(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (/\.glb$/i.test(e.name) && !isLod(e.name)) yield full;
  }
}

async function sources() {
  if (only.length) return only.map((f) => path.resolve(ROOT, f));
  const list = [];
  for (const d of await fs.readdir(PROJECTS, { withFileTypes: true })) {
    const f = path.join(PROJECTS, d.name, 'model-lite.glb');
    if (d.isDirectory() && (await fs.stat(f).catch(() => null))) list.push(f);
  }
  for await (const f of walk(PUBLIC)) list.push(f);
  return list;
}

const triangles = (doc) => doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives())
  .reduce((n, p) => n + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')?.getCount() ?? 0) / 3, 0);

/** Reduce one primitive's triangles in place, keeping its attribute layout. */
function simplifyPrimitive(doc, prim, level) {
  if (prim.getMode() !== 4) return; // triangles only
  const posAcc = prim.getAttribute('POSITION');
  if (!posAcc) return;
  const count = posAcc.getCount();
  const idxAcc = prim.getIndices();
  const original = idxAcc ? Uint32Array.from(idxAcc.getArray()) : Uint32Array.from({ length: count }, (_, i) => i);
  const tris = original.length / 3;
  if (tris < MIN_TRIS) return;

  // positions (dequantised) and normals as floats
  const positions = new Float32Array(count * 3);
  const el = [0, 0, 0];
  for (let i = 0; i < count; i++) positions.set(posAcc.getElement(i, el), i * 3);
  const nAcc = prim.getAttribute('NORMAL');
  const normals = nAcc ? new Float32Array(count * 3) : null;
  if (normals) for (let i = 0; i < count; i++) normals.set(nAcc.getElement(i, el), i * 3);

  // Simplify on positions only: CAD exports split vertices along every hard edge, which would otherwise pin
  // the simplifier. Corners are mapped back to a real vertex afterwards.
  const weld = MeshoptSimplifier.generatePositionRemap(positions, 3);
  const indices = original.map((v) => weld[v]);

  // lock the extreme vertices on every axis so the bounding box never changes
  const lock = new Uint8Array(count);
  for (let a = 0; a < 3; a++) {
    let lo = indices[0], hi = indices[0];
    for (const v of indices) {
      if (positions[v * 3 + a] < positions[lo * 3 + a]) lo = v;
      if (positions[v * 3 + a] > positions[hi * 3 + a]) hi = v;
    }
    lock[lo] = lock[hi] = 1;
  }

  const target = Math.max(Math.floor(tris * level.ratio) * 3, 12 * 3);
  const run = (flags) => MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, new Float32Array(count), 1, [0], lock, target, level.error, flags)[0];
  // Prune drops shells smaller than the error; when that would leave the part nearly empty, keep them
  let out = run(['Permissive', 'Prune']);
  if (out.length < Math.min(target, indices.length) * 0.3) out = run(['Permissive']);
  // separate shells and tiny details can stall well above the target: fall back to clustering
  if (level.sloppy && out.length > target * 2) {
    const [sloppy] = MeshoptSimplifier.simplifySloppy(indices, positions, 3, lock, target, 1);
    if (sloppy.length < out.length) out = sloppy;
  }
  if (out.length >= indices.length) return;
  // glTF needs at least one index: a degenerate triangle draws nothing
  if (!out.length) out = Uint32Array.of(indices[0], indices[0], indices[0]);

  // Back from welded positions to real vertices: each corner takes the split copy whose normal best matches
  // the new face, so hard edges stay hard.
  if (normals) {
    const copies = new Map();
    for (const v of original) {
      const w = weld[v];
      const list = copies.get(w);
      if (!list) copies.set(w, [v]);
      else if (!list.includes(v)) list.push(v);
    }
    const n = [0, 0, 0];
    for (let t = 0; t < out.length; t += 3) {
      const [a, b, c] = [out[t], out[t + 1], out[t + 2]];
      const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
      const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
      n[0] = uy * vz - uz * vy; n[1] = uz * vx - ux * vz; n[2] = ux * vy - uy * vx;
      for (let k = 0; k < 3; k++) {
        const list = copies.get(out[t + k]);
        if (!list || list.length < 2) continue;
        let best = list[0], score = -Infinity;
        for (const v of list) {
          const d = normals[v * 3] * n[0] + normals[v * 3 + 1] * n[1] + normals[v * 3 + 2] * n[2];
          if (d > score) { score = d; best = v; }
        }
        out[t + k] = best;
      }
    }
  }

  // compact to the referenced vertices, triangles and vertices in GPU cache order (also compresses far better)
  const tri = Uint32Array.from(out);
  const [order0, unique] = MeshoptEncoder.reorderMesh(tri, true, true); // renumbers `tri` in place
  const remap = new Int32Array(count).fill(-1);
  for (let v = 0; v < order0.length; v++) if (order0[v] !== 0xffffffff) remap[v] = order0[v];
  let used = unique;
  // the extreme vertices stay in the vertex buffer even when no triangle uses them any more: bounding boxes
  // (and anything measuring vertices) come out exactly as for the full file
  for (let v = 0; v < count; v++) if (lock[v] && remap[v] < 0) remap[v] = used++;
  const order = new Uint32Array(used);
  for (let v = 0; v < count; v++) if (remap[v] >= 0) order[remap[v]] = v;

  for (const semantic of prim.listSemantics()) {
    const acc = prim.getAttribute(semantic);
    const src = acc.getArray();
    const k = acc.getElementSize();
    const dst = new src.constructor(used * k);
    for (let i = 0; i < used; i++) for (let c = 0; c < k; c++) dst[i * k + c] = src[order[i] * k + c];
    const next = doc.createAccessor(acc.getName()).setType(acc.getType()).setArray(dst).setNormalized(acc.getNormalized()).setBuffer(acc.getBuffer());
    prim.setAttribute(semantic, next);
    if (acc.listParents().every((p) => p.propertyType === 'Root')) acc.dispose();
  }
  const idx = used < 65536 ? new Uint16Array(out.length) : new Uint32Array(out.length);
  idx.set(tri);
  const nextIdx = doc.createAccessor().setType('SCALAR').setArray(idx).setBuffer((idxAcc ?? posAcc).getBuffer());
  prim.setIndices(nextIdx);
  if (idxAcc && idxAcc.listParents().every((p) => p.propertyType === 'Root')) idxAcc.dispose();
}

/** Node tree, transforms, materials, attribute sets and per-primitive bounds: must match between levels. */
function signature(doc) {
  const out = [];
  const el = [0, 0, 0];
  const walk = (n, at) => {
    const prims = n.getMesh()?.listPrimitives().map((p) => {
      const a = p.getAttribute('POSITION');
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let i = 0; i < a.getCount(); i++) { a.getElement(i, el); for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], el[k]); b[k + 3] = Math.max(b[k + 3], el[k]); } }
      return `${b.map((x) => x.toFixed(5))}|${p.listSemantics().sort()}|${p.getMaterial()?.getName()}`;
    });
    out.push(`${at}:${n.getName()} ${n.getTranslation()} ${n.getRotation()} ${n.getScale()} ${prims?.join(';')}`);
    n.listChildren().forEach((c, i) => walk(c, `${at}/${i}`));
  };
  doc.getRoot().listScenes().forEach((sc, k) => sc.listChildren().forEach((n, i) => walk(n, `${k}/${i}`)));
  return out.join(' || ');
}

const manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8').catch(() => '{}'));
const files = await sources();
let built = 0;
for (const file of files) {
  const r = rel(file);
  const url = urlOf(file);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) { console.warn(`${r}: missing`); continue; }
  if (stat.size < MIN_BYTES || EXCLUDE.has(r)) {
    delete manifest[url];
    for (let i = 0; i < LEVELS.length; i++) await fs.rm(lodPath(file, i), { force: true });
    console.log(`${r}: ${stat.size < MIN_BYTES ? `${(stat.size / 1024).toFixed(0)} KB, small enough as is` : 'excluded'}`);
    continue;
  }
  const outs = LEVELS.map((_, i) => lodPath(file, i));
  const stats = await Promise.all(outs.map((f) => fs.stat(f).catch(() => null)));
  if (!FORCE && manifest[url] && stats.every((s) => s && s.mtimeMs >= stat.mtimeMs)) {
    console.log(`${r}: up to date`);
    continue;
  }

  const source = await io.read(file);
  const full = triangles(source);
  const entry = { levels: [], tris: [], bytes: [] };
  for (let i = 0; i < LEVELS.length; i++) {
    const doc = await io.read(file); // fresh copy: same nodes, same quantisation
    for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) simplifyPrimitive(doc, prim, LEVELS[i]);
    if (signature(doc) !== signature(source)) throw new Error(`${r}: level ${i} changed the node tree or bounds`);
    await io.write(outs[i], doc);
    const size = (await fs.stat(outs[i])).size;
    entry.levels.push(urlOf(outs[i]));
    entry.tris.push(Math.round(triangles(doc)));
    entry.bytes.push(size);
  }
  entry.levels.push(url);
  entry.tris.push(Math.round(full));
  entry.bytes.push(stat.size);
  manifest[url] = entry;
  built++;
  console.log(`${r}: ${entry.tris.map((t, i) => `${t.toLocaleString()} tris ${(entry.bytes[i] / 1024).toFixed(0)} KB`).join('  |  ')}`);
}

// drop entries whose source file is gone
for (const url of Object.keys(manifest)) {
  const file = url.startsWith('/content-assets/') ? path.join(ROOT, 'src', 'content', url.slice('/content-assets/'.length)) : path.join(PUBLIC, url.slice(1));
  if (!(await fs.stat(file).catch(() => null))) delete manifest[url];
}
const sorted = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]));
await fs.writeFile(MANIFEST, `${JSON.stringify(sorted, null, 1)}\n`);
console.log(`\n${built} file(s) rebuilt, ${Object.keys(sorted).length} in ${rel(MANIFEST)}`);
