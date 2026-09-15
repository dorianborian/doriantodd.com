// Builds the posable Sesame used by the home page playpen from the Sesame repository:
//   public/sesame/rig.glb   the 11 printed parts (frame, covers, 8 limbs) as separate meshes, simplified + meshopt
//   public/sesame/rig.json  Sesame Studio's joint rig (pivots, axes, parents, offsets) and its built-in sequences
//
//   node scripts/sesame-rig.mjs [path-to-sesame-robot]
//
// Sequences come from software/sesame-studio/app/builtin_sequences.py (transcribed from the firmware),
// exported through Python so the frame accumulation logic is Studio's own.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt, simplify, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.argv[2] ?? 'C:/Users/doria/Documents/Projects/sesame-robot';
const STL = path.join(REPO, 'hardware/printing/stl');
const STUDIO = path.join(REPO, 'software/sesame-studio');
const OUT = path.join(ROOT, 'public/sesame');

const rig = JSON.parse(await fs.readFile(path.join(STUDIO, 'assets/joints_config.json'), 'utf8'));
delete rig._comment;
const files = [rig.body.frame_stl, rig.body.bottom_stl, rig.body.cover_stl, ...Object.values(rig.joints).map((j) => j.stl)].filter(Boolean);

function readStl(buf) {
  const text = buf.subarray(0, 5).toString() === 'solid' && !buf.subarray(80, 84).readUInt32LE() ;
  if (text) throw new Error('ASCII STL not supported');
  const count = buf.readUInt32LE(80);
  const pos = new Float32Array(count * 9);
  for (let i = 0; i < count; i++) {
    const o = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k++) pos[i * 9 + k] = buf.readFloatLE(o + k * 4);
  }
  return pos;
}

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('sesame');
for (const file of files) {
  const pos = readStl(await fs.readFile(path.join(STL, file)));
  const acc = doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', acc);
  const mesh = doc.createMesh(file).addPrimitive(prim);
  scene.addChild(doc.createNode(file).setMesh(mesh));
}
await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 0.3, error: 0.002 }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
await fs.mkdir(OUT, { recursive: true });
await new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder }).write(path.join(OUT, 'rig.glb'), doc);

const py = `
import json, sys
sys.path.insert(0, r"${STUDIO}")
from app.builtin_sequences import BUILTIN_SEQUENCES, BUILTIN_ORDER
out = {}
for name in BUILTIN_ORDER:
    seq = BUILTIN_SEQUENCES[name]
    out[name] = [{"ms": f.delay_ms, "a": f.angles, "face": f.face} for f in seq.frames]
print(json.dumps(out))
`;
const sequences = JSON.parse(execFileSync('python', ['-c', py], { encoding: 'utf8' }));
await fs.writeFile(path.join(OUT, 'rig.json'), JSON.stringify({ rig, sequences }));
const glb = await fs.stat(path.join(OUT, 'rig.glb'));
console.log(`rig.glb ${(glb.size / 1024).toFixed(0)} KB, ${files.length} parts, ${Object.keys(sequences).length} sequences`);
