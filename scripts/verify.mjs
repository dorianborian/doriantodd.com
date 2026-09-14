// Post-build checks. Run after `npm run build` (CI runs it before every deploy).
//
//   npm run check              offline checks on dist/
//   npm run check -- --external  also HEAD-request every external link (slow)
//
// Fails (exit 1) when:
//   - an old Google Sites URL from migration/manifest.json has no page in dist/
//   - an internal link, image, video or script points at a file that doesn't exist
//   - CNAME is missing
// Warns when a migrated page has noticeably less text than the original.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const EXTERNAL = process.argv.includes('--external');

const errors = [];
const warnings = [];

async function exists(p) { return fs.access(p).then(() => true, () => false); }

async function* htmlFiles(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* htmlFiles(full);
    else if (e.name.endsWith('.html')) yield full;
  }
}

/** Does a site-relative URL resolve to a file in dist, the way GitHub Pages would serve it? */
async function resolves(urlPath) {
  const clean = decodeURIComponent(urlPath.split(/[?#]/)[0]);
  const target = path.join(DIST, clean);
  if (clean.endsWith('/')) return exists(path.join(target, 'index.html'));
  return (await exists(target).then(async (ok) => ok && (await fs.stat(target)).isFile())) ||
    exists(path.join(target, 'index.html')) ||
    exists(target + '.html');
}

if (!(await exists(DIST))) {
  console.error('dist/ not found. Run `npm run build` first.');
  process.exit(1);
}

// 1. CNAME
const cname = await fs.readFile(path.join(DIST, 'CNAME'), 'utf8').catch(() => '');
if (!cname.trim()) errors.push('dist/CNAME is missing: GitHub Pages would drop the custom domain.');

// 2. Every legacy URL still works
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'migration', 'manifest.json'), 'utf8').catch(() => 'null'));
const legacy = manifest ? ['/home', '/projects', ...manifest.pages.map((p) => p.path)] : [];
for (const p of legacy) {
  if (!(await resolves(p === '/' ? '/' : p))) errors.push(`legacy URL ${p} has no page`);
}

// 3. Links and assets inside the built HTML
const external = new Set();
let pages = 0;
const textByUrl = new Map();
for await (const file of htmlFiles(DIST)) {
  pages++;
  const html = await fs.readFile(file, 'utf8');
  const $ = cheerio.load(html);
  const rel = '/' + path.relative(DIST, file).replaceAll(path.sep, '/').replace(/index\.html$/, '').replace(/\.html$/, '');
  if ($('.prose').length) textByUrl.set(rel.replace(/\/$/, '') || '/', $('.prose').text());

  const refs = [];
  $('a[href]').each((_, el) => refs.push($(el).attr('href')));
  $('img[src], video[src], video[poster], source[src], script[src], link[href]:not([rel=canonical]), cad-viewer[src]').each((_, el) => {
    for (const attr of ['src', 'poster', 'href']) if ($(el).attr(attr)) refs.push($(el).attr(attr));
  });
  $('img[srcset]').each((_, el) => $(el).attr('srcset').split(',').forEach((s) => refs.push(s.trim().split(/\s+/)[0])));

  for (const ref of refs) {
    if (!ref || ref.startsWith('#') || /^(mailto|tel|javascript|data):/.test(ref)) continue;
    if (/^https?:\/\//.test(ref)) {
      const u = new URL(ref);
      if (u.hostname === 'www.doriantodd.com' || u.hostname === 'doriantodd.com') {
        if (!(await resolves(u.pathname))) errors.push(`${rel}: absolute link to missing page ${u.pathname}`);
      } else external.add(ref);
      continue;
    }
    if (ref.startsWith('//')) { external.add('https:' + ref); continue; }
    const abs = ref.startsWith('/') ? ref : path.posix.join(rel.endsWith('/') ? rel : path.posix.dirname(rel) + '/', ref);
    if (!(await resolves(abs))) errors.push(`${rel}: broken reference ${ref}`);
  }
}

// 4. Content survived the migration
if (manifest) {
  for (const p of manifest.pages) {
    if (!textByUrl.has(p.path)) continue; // custom-built page, not Markdown
    const text = textByUrl.get(p.path);
    const words = text.split(/\s+/).filter(Boolean).length;
    if (p.path !== '/' && words < p.words * 0.7) {
      warnings.push(`${p.path}: ${words} words now vs ${p.words} on Google Sites (edited on purpose?)`);
    }
  }
}

// 5. Optional: external links
if (EXTERNAL) {
  for (const url of external) {
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10000) });
      if (res.status >= 400 && res.status !== 405 && res.status !== 403 && res.status !== 999) warnings.push(`external ${res.status}: ${url}`);
    } catch (e) {
      warnings.push(`external unreachable: ${url}`);
    }
  }
}

// 6. Size report
const sizes = [];
async function walkSizes(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkSizes(full);
    else sizes.push({ file: path.relative(DIST, full), bytes: (await fs.stat(full)).size });
  }
}
await walkSizes(DIST);
const total = sizes.reduce((n, s) => n + s.bytes, 0);
sizes.sort((a, b) => b.bytes - a.bytes);

console.log(`\n${pages} HTML pages, ${legacy.length} legacy URLs checked, ${external.size} external links${EXTERNAL ? ' (checked)' : ''}`);
console.log(`dist is ${(total / 1e6).toFixed(1)} MB (GitHub Pages limit 1 GB). Largest files:`);
for (const s of sizes.slice(0, 5)) console.log(`  ${(s.bytes / 1e6).toFixed(2)} MB  ${s.file}`);
if (warnings.length) console.log(`\nWarnings:\n${[...new Set(warnings)].map((w) => '  - ' + w).join('\n')}`);
if (errors.length) {
  console.error(`\nErrors:\n${[...new Set(errors)].map((e) => '  - ' + e).join('\n')}`);
  process.exit(1);
}
console.log('\nAll checks passed.');
