// Shrinks heavy media inside src/content before it gets committed.
//
//   npm run media
//
// - GIFs over 300 KB become looping, muted MP4s (usually 10-20x smaller). A poster frame
//   `<name>.poster.jpg` is written next to it. Markdown references `./name.gif` are rewritten
//   to `./name.mp4`, and a `cover:` that pointed at the GIF points at the poster instead.
// - PNG/JPEG files over 1.5 MB are resized to at most 2400px wide.
// Originals are moved to migration/originals/ (git-ignored) so nothing is ever lost.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGINALS = path.join(ROOT, 'migration', 'originals');
const GIF_LIMIT = 300_000;
const IMAGE_LIMIT = 1_500_000;

async function ffmpegPath() {
  try { return (await import('ffmpeg-static')).default; } catch { return 'ffmpeg'; }
}

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

async function stash(file) {
  const dest = path.join(ORIGINALS, path.relative(ROOT, file));
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(file, dest);
}

async function rewriteMarkdown(dir, from, to, poster) {
  for (const name of await fs.readdir(dir)) {
    if (!/\.mdx?$/.test(name)) continue;
    const file = path.join(dir, name);
    const src = await fs.readFile(file, 'utf8');
    const out = src
      .replace(new RegExp(`^cover:\\s*["']?\\./${from}["']?\\s*$`, 'm'), `cover: "./${poster}"`)
      .replaceAll(`./${from}`, `./${to}`);
    if (out !== src) await fs.writeFile(file, out);
  }
}

export async function optimizeMedia(root = path.join(ROOT, 'src', 'content')) {
  const ffmpeg = await ffmpegPath();
  let saved = 0;
  for await (const file of walk(root)) {
    const ext = path.extname(file).toLowerCase();
    const { size } = await fs.stat(file);
    const dir = path.dirname(file);
    const base = path.basename(file, ext);

    if (ext === '.gif' && size > GIF_LIMIT) {
      const mp4 = path.join(dir, `${base}.mp4`);
      const poster = path.join(dir, `${base}.poster.jpg`);
      const scale = "scale='trunc(min(1280,iw)/2)*2':-2:flags=lanczos"; // H.264 needs even dimensions
      try {
        await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', file, '-vf', `${scale},format=yuv420p`,
          '-c:v', 'libx264', '-crf', '26', '-preset', 'slow', '-movflags', '+faststart', '-an', mp4]);
        await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', file, '-vf', scale, '-frames:v', '1', '-q:v', '3', poster]);
      } catch (e) {
        console.warn(`skipped ${path.relative(ROOT, file)}: ${(e.stderr || e.message).split('\n')[0]}`);
        continue;
      }
      await stash(file);
      await fs.rm(file);
      await rewriteMarkdown(dir, `${base}.gif`, `${base}.mp4`, `${base}.poster.jpg`);
      const after = (await fs.stat(mp4)).size;
      saved += size - after;
      console.log(`gif -> mp4  ${path.relative(ROOT, file)}  ${(size / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB`);
    } else if ((ext === '.png' || ext === '.jpg' || ext === '.jpeg') && size > IMAGE_LIMIT) {
      const img = sharp(file);
      const { width } = await img.metadata();
      const pipeline = width > 2400 ? img.resize({ width: 2400 }) : img;
      const buf = ext === '.png' ? await pipeline.png({ compressionLevel: 9, effort: 10 }).toBuffer() : await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
      if (buf.length < size * 0.9) {
        await stash(file);
        await fs.writeFile(file, buf);
        saved += size - buf.length;
        console.log(`resize     ${path.relative(ROOT, file)}  ${(size / 1e6).toFixed(1)}MB -> ${(buf.length / 1e6).toFixed(1)}MB`);
      }
    }
  }
  console.log(`media: saved ${(saved / 1e6).toFixed(1)} MB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await optimizeMedia(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
}
