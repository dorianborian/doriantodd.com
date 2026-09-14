// Headless screenshots for checking 3D scenes without a visible browser window.
//
//   node scripts/shot.mjs "?view=redhex" redhex.png            one shot (path may omit the leading /)
//   node scripts/shot.mjs --batch "?view=a=a.png" "contact=c.png"  several in parallel (path=file)
//
// Uses the local Microsoft Edge (or Chrome) with software WebGL against the dev server
// (PORT env or 4321). Files go to ./shots/. Set SHOT_SIZE=1500x950 to change the window size.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.PORT || 4321;
const [w, h] = (process.env.SHOT_SIZE || '1500x950').split('x');
const exe = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((b) => fs.existsSync(b));
if (!exe) throw new Error('No Edge or Chrome found');

function shot(urlPath, file) {
  const url = /^https?:/.test(urlPath) ? urlPath : `http://localhost:${port}/${urlPath.replace(/^\//, '')}`;
  const out = path.isAbsolute(file) ? file : path.join(ROOT, 'shots', file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
  return new Promise((resolve) => {
    execFile(exe, [
      '--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars',
      `--window-size=${w},${h}`, '--virtual-time-budget=30000', `--user-data-dir=${profile}`, `--screenshot=${out}`, url,
    ], { timeout: 180000 }, (err) => {
      fs.rmSync(profile, { recursive: true, force: true });
      console.log(err ? `FAILED ${file}: ${err.message.split('\n')[0]}` : out);
      resolve();
    });
  });
}

const args = process.argv.slice(2);
if (args[0] === '--batch') {
  await Promise.all(args.slice(1).map((pair) => {
    const i = pair.lastIndexOf('=');
    return shot(pair.slice(0, i), pair.slice(i + 1));
  }));
} else {
  await shot(args[0] ?? '', args[1] ?? 'shot.png');
}
