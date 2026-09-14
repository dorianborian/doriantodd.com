// Scaffold a new project article.
//
//   npm run new "Robot Arm"
//   npm run new "Robot Arm" -- --draft
//
// Creates src/content/projects/robot-arm/index.md. Drop images into that folder and
// reference them as ![caption](./photo.jpg).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const title = args.filter((a) => !a.startsWith('--')).join(' ').trim();
const draft = args.includes('--draft');

if (!title) {
  console.error('Usage: npm run new "Project title"');
  process.exit(1);
}

const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const dir = path.join(ROOT, 'src', 'content', 'projects', slug);
const file = path.join(dir, 'index.md');

if (await fs.access(file).then(() => true, () => false)) {
  console.error(`Already exists: ${path.relative(ROOT, file)}`);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
await fs.mkdir(dir, { recursive: true });
await fs.writeFile(file, `---
title: ${JSON.stringify(title)}
summary: "One or two sentences. Shown on the projects list and when the project is selected on the home page."
date: ${today}
# cover: "./cover.jpg"        # image in this folder; shown until the project has a 3D model
# model: "./model.glb"        # set by `npm run models` after you drop in an .obj + .mtl + textures
tags: []                      # e.g. ["ESP32", "ROS2"]
links: []                     # e.g. [{ label: "Source code", url: "https://github.com/..." }]
status: in-progress           # released | in-progress | archived
order: 0                      # lower numbers come first
draft: ${draft}
---

Intro paragraph.

## First section

Write here.

<!--
Cheat sheet (delete when done). Put files in this folder next to index.md.

  ![Caption](./photo.jpg)                         image, resized and converted to WebP at build
  ![Caption](./clip.mp4)                          looping muted video (run \`npm run media\` to turn big GIFs into these)
  ![Caption](./part.stl)                          interactive 3D viewer (.stl, .glb, .gltf, .obj, .3mf)
  https://www.youtube.com/watch?v=VIDEO_ID        on its own line: click-to-play YouTube player
  [Download the STEP file](./part.step)           link to any file in this folder

Each of the above (except links) must be on its own line, with blank lines around it.
-->
`);

console.log(`Created ${path.relative(ROOT, file)}`);
console.log('Next: add images to that folder, then run `npm run dev` and open http://localhost:4321' + `/projects/${slug}`);
