// Turns 3D models dropped into a project folder into one small, web-ready model.glb.
//
//   npm run models                 convert every project that has a new model
//   npm run models -- fridge-tank  just one project
//   npm run models -- --rebuild    reconvert from models-src/ (after changing budgets or material fixes)
//
// Put these next to src/content/projects/<slug>/index.md:
//   something.obj + something.mtl + its texture images      (textured OBJ)
//   or something.glb / something.gltf (+ .bin + textures)
//
// The script:
//   1. converts OBJ/MTL to glTF,
//   2. welds and deduplicates geometry, simplifies very dense meshes (over 150k triangles),
//   3. resizes textures to at most 1024px WebP,
//   4. applies meshopt compression, and writes model.glb,
//   5. sets `model: "./model.glb"` in the project's front matter,
//   6. moves the source files to models-src/<slug>/ (git-ignored) so they aren't committed.
//
// Optional front matter to adjust how the model sits on the home page:
//   modelUp: z                  # the file is Z-up (Fusion 360 exports usually are). Default y.
//   modelRotation: [0, 90, 0]   # extra rotation in degrees, so the front faces the label

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import obj2gltf from 'obj2gltf';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { cloneDocument, dedup, flatten, getBounds, join, meshopt, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS = path.join(ROOT, 'src', 'content', 'projects');
const SOURCES = path.join(ROOT, 'models-src');
// Budget per model. Ten of these load on the home page, so keep them light.
const MAX_TRIANGLES = Number(process.env.MAX_TRIANGLES) || 120_000;
const LITE_TRIANGLES = Number(process.env.LITE_TRIANGLES) || 30_000;
const REBUILD = process.argv.includes('--rebuild');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

/**
 * Fusion 360 OBJ exports store appearance colours as sRGB, but glTF expects linear values, which
 * made everything look washed out. Convert, add a little saturation, and give named appearances
 * (wood, fabric, clear acrylic) that export as black or white a sensible look.
 */
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function saturate([r, g, b], amount) {
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [r, g, b].map((c) => Math.min(1, Math.max(0, l + (c - l) * amount)));
}

function fixMaterials() {
  const set = (m, srgb, { rough = 0.6, metal = 0, alpha = 1, sat = 1.3 } = {}) => {
    m.setBaseColorFactor([...saturate(srgb, sat).map(toLinear), alpha]);
    m.setRoughnessFactor(rough);
    m.setMetallicFactor(metal);
    if (alpha < 1) { m.setAlphaMode('BLEND'); m.setDoubleSided(true); }
  };
  return (doc) => {
    for (const m of doc.getRoot().listMaterials()) {
      const name = m.getName() || '';
      const [r, g, b] = m.getBaseColorFactor(); // obj2gltf copies Kd straight through (sRGB)
      if (/acrylic.*clear|glass|clear/i.test(name)) set(m, [0.85, 0.9, 0.95], { rough: 0.05, alpha: 0.28, sat: 1 });
      else if (/cherry|walnut/i.test(name)) set(m, [0.55, 0.3, 0.18], { rough: 0.55 });
      else if (/bamboo|ash|oak|maple|wood|pine|birch/i.test(name)) set(m, [0.82, 0.66, 0.45], { rough: 0.6 });
      else if (/fabric.*green|felt.*green|turf|grass/i.test(name)) set(m, [0.16, 0.55, 0.26], { rough: 0.95 });
      else if (/steel|alumin|metal|chrome|iron|brass/i.test(name)) set(m, r + g + b === 0 ? [0.63, 0.63, 0.63] : [r, g, b], { rough: 0.4, metal: 0.45 });
      else if (r + g + b === 0) set(m, [0.07, 0.07, 0.08], { rough: 0.6 });
      else set(m, [r, g, b], { rough: 0.5 });
    }
    // construction / reference bodies exported by mistake
    for (const node of doc.getRoot().listNodes()) if (/reference|construction/i.test(node.getName())) node.dispose();
  };
}

/** Remove bodies that are tiny next to the whole model (screws, nuts, standoffs). */
function dropSmallParts(fraction, keepNamed = false) {
  return (doc) => {
    const scene = doc.getRoot().listScenes()[0];
    const diag = (b) => Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    const total = diag(getBounds(scene));
    let removed = 0;
    for (const node of doc.getRoot().listNodes()) {
      if (!node.getMesh() || node.listChildren().length) continue;
      if (keepNamed && !/^(Body|Component)/i.test(node.getName())) continue; // named parts (foot, face...) matter for rigs
      if (diag(getBounds(node)) < total * fraction) { node.dispose(); removed++; }
    }
    if (removed) console.log(`  lite: dropped ${removed} small parts`);
  };
}

function triangleCount(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      n += (idx ? idx.getCount() : pos?.getCount() ?? 0) / 3;
    }
  }
  return Math.round(n);
}

/** Every file an .mtl or .gltf points at, so the originals can be moved away together. */
async function referencedFiles(file) {
  const dir = path.dirname(file);
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const names = new Set();
  if (file.endsWith('.mtl')) {
    for (const m of text.matchAll(/^\s*(?:map_\w+|bump|disp|norm)\s+(?:-\S+\s+\S+\s+)*(.+?)\s*$/gim)) names.add(m[1]);
  } else if (file.endsWith('.obj')) {
    for (const m of text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gim)) names.add(m[1]);
  } else if (file.endsWith('.gltf')) {
    for (const m of text.matchAll(/"uri"\s*:\s*"([^"]+)"/g)) if (!m[1].startsWith('data:')) names.add(decodeURIComponent(m[1]));
  }
  return [...names].map((n) => path.resolve(dir, n));
}

async function convertProject(slug) {
  const dir = path.join(PROJECTS, slug);
  const stored = path.join(SOURCES, slug);
  const pick = (files) => files.find((f) => /.obj$/i.test(f)) ?? files.find((f) => /.(gltf|glb)$/i.test(f) && !/^model(-lite)?.glb$/.test(f));
  let source = pick(await fs.readdir(dir));
  let srcDir = dir;
  if (!source && REBUILD) {
    source = pick(await fs.readdir(stored).catch(() => []));
    srcDir = stored;
  }
  if (!source) return false;
  const srcPath = path.join(srcDir, source);
  console.log(`
${slug}: ${source}`);

  let base;
  if (/.obj$/i.test(source)) {
    const glb = await obj2gltf(srcPath, { binary: true, secure: true });
    base = await io.readBinary(new Uint8Array(glb));
  } else {
    base = await io.read(srcPath);
  }
  await base.transform(fixMaterials(), dedup());
  const before = triangleCount(base);

  // model.glb for the project page viewer, model-lite.glb for the home page
  const variants = [{ file: 'model.glb', max: MAX_TRIANGLES, error: 0.01, drop: 0 }, { file: 'model-lite.glb', max: LITE_TRIANGLES, error: 0.05, drop: 0.035 }];
  // rig: true in front matter keeps separate parts (for animated joints on the home page)
  const fm = await fs.readFile(path.join(dir, 'index.md'), 'utf8').catch(() => '');
  if (/^rig:\s*true/m.test(fm)) variants.push({ file: 'model-rig.glb', max: 45_000, error: 0.05, drop: 0.015, rig: true });
  for (const v of variants) {
    const doc = cloneDocument(base);
    if (v.drop) await doc.transform(dropSmallParts(v.drop, v.rig));
    await doc.transform(...(v.rig ? [flatten(), weld()] : [flatten(), join(), weld()]));
    const count = triangleCount(doc);
    const steps = [];
    if (count > v.max) steps.push(simplify({ simplifier: MeshoptSimplifier, ratio: v.max / count, error: v.error }));
    steps.push(
      textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 82 }),
      prune(),
      meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
    );
    await doc.transform(...steps);
    const out = path.join(dir, v.file);
    await io.write(out, doc);
    const { size } = await fs.stat(out);
    console.log(`  ${v.file}: ${triangleCount(doc).toLocaleString()} of ${before.toLocaleString()} triangles, ${(size / 1e6).toFixed(2)} MB`);
  }

  if (srcDir === stored) return true;
  // Move sources out of the content folder
  const moving = new Set([srcPath]);
  for (const ref of await referencedFiles(srcPath)) {
    moving.add(ref);
    for (const nested of await referencedFiles(ref)) moving.add(nested);
  }
  const dest = path.join(SOURCES, slug);
  await fs.mkdir(dest, { recursive: true });
  for (const f of moving) {
    if (!f.startsWith(dir)) continue;
    const exists = await fs.access(f).then(() => true, () => false);
    if (!exists) continue;
    const target = path.join(dest, path.relative(dir, f));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(f, target);
  }
  console.log(`  moved ${moving.size} source file(s) to models-src/${slug}/`);

  // Front matter
  const md = path.join(dir, 'index.md');
  let text = await fs.readFile(md, 'utf8');
  if (/^#?\s*model:.*$/m.test(text)) text = text.replace(/^#?\s*model:.*$/m, 'model: "./model.glb"');
  else text = text.replace(/^---\n/, '---\nmodel: "./model.glb"\n');
  await fs.writeFile(md, text);
  return true;
}

const slugs = only.length ? only : (await fs.readdir(PROJECTS, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
let converted = 0;
for (const slug of slugs) {
  try {
    if (await convertProject(slug)) converted++;
  } catch (e) {
    console.error(`  failed: ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(converted ? `\nConverted ${converted} model(s).` : 'No new .obj/.gltf/.glb files found in project folders.');
