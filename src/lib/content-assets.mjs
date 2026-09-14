// Publishes non-image files that live next to Markdown posts (videos, 3D models, PDFs, zips)
// at /content-assets/<collection>/<slug>/<file>. Images are handled by Astro's image pipeline.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../content', import.meta.url));
const PUBLISH = /(\.poster\.jpg|\.(mp4|webm|mov|stl|glb|gltf|bin|obj|3mf|step|stp|pdf|zip|csv))$/i;
const TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.jpg': 'image/jpeg', '.stl': 'model/stl', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.pdf': 'application/pdf' };

async function* walk(dir) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (PUBLISH.test(e.name)) yield full;
  }
}

export default function contentAssets() {
  return {
    name: 'content-assets',
    hooks: {
      'astro:server:setup': ({ server }) => {
        server.middlewares.use('/content-assets', (req, res, next) => {
          const rel = decodeURIComponent((req.url || '').split('?')[0]);
          const file = path.join(ROOT, rel);
          if (!file.startsWith(ROOT) || !PUBLISH.test(file) || !fs.existsSync(file)) return next();
          const { size } = fs.statSync(file);
          const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
          const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
          if (range) {
            const start = Number(range[1] || 0);
            const end = range[2] ? Number(range[2]) : size - 1;
            res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
            fs.createReadStream(file, { start, end }).pipe(res);
          } else {
            res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
            fs.createReadStream(file).pipe(res);
          }
        });
      },
      'astro:build:done': async ({ dir, logger }) => {
        const out = path.join(fileURLToPath(dir), 'content-assets');
        let n = 0;
        for await (const file of walk(ROOT)) {
          const dest = path.join(out, path.relative(ROOT, file));
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.copyFile(file, dest);
          n++;
        }
        logger.info(`copied ${n} content assets`);

        // Astro emits full-size originals for content images even when only resized copies
        // are used. Drop any image in _astro/ that no page, script or stylesheet mentions.
        const root = fileURLToPath(dir);
        const astroDir = path.join(root, '_astro');
        if (!fs.existsSync(astroDir)) return;
        let text = '';
        const collect = async (d) => {
          for (const e of await fsp.readdir(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) await collect(full);
            else if (/\.(html|js|css|json|xml)$/.test(e.name)) text += await fsp.readFile(full, 'utf8');
          }
        };
        await collect(root);
        let pruned = 0;
        for (const name of await fsp.readdir(astroDir)) {
          if (/\.(png|jpe?g|gif|webp|avif)$/i.test(name) && !text.includes(name)) {
            await fsp.rm(path.join(astroDir, name));
            pruned++;
          }
        }
        logger.info(`pruned ${pruned} unreferenced original images`);
      },
    },
  };
}
