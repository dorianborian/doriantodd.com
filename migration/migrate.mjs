// Google Sites -> Markdown migration.
//
//   node migration/migrate.mjs           crawl, convert, download images
//   node migration/migrate.mjs --force   also overwrite index.md files that already exist
//
// Output
//   migration/archive/*.html          raw HTML snapshot of every page (reference only)
//   migration/manifest.json           every URL, image and embed found
//   migration/REPORT.md               things a human needs to look at
//   migration/embeds/*.html           custom HTML embeds pulled out of pages
//   src/content/pages/<slug>/index.md      top-level pages (keep their old URL via `path`)
//   src/content/projects/<slug>/index.md   project articles, images saved next to them
//
// Google Sites image URLs are signed and expire within minutes, so every page is converted
// and its images downloaded immediately after it's fetched. Don't split that into two passes.

import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://www.doriantodd.com';
const HOST = new URL(ORIGIN).host;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = path.join(ROOT, 'migration', 'archive');
const CONTENT = path.join(ROOT, 'src', 'content');
const FORCE = process.argv.includes('--force');

// Pages nothing links to can't be discovered by crawling. List them here if you have any.
const SEEDS = ['/', '/projects'];

const report = { warnings: [], embeds: [], customEmbeds: [], externalLinks: new Set() };
const warn = (page, msg) => { report.warnings.push(`- \`${page}\`: ${msg}`); console.warn('  !', msg); };

// ---------------------------------------------------------------- helpers

const normalizePath = (p) => {
  const clean = p.replace(/\/+$/, '') || '/';
  return clean === '/home' ? '/' : clean;
};

const archiveFile = (p) => path.join(ARCHIVE, (p === '/' ? 'index' : p.slice(1).replaceAll('/', '__')) + '.html');

function unwrapGoogleRedirect(href) {
  try {
    const u = new URL(href, ORIGIN);
    if (u.host === 'www.google.com' && u.pathname === '/url' && u.searchParams.get('q')) return u.searchParams.get('q');
    if (u.host === HOST || u.host === 'sites.google.com') return normalizePath(u.pathname) + u.hash;
    return u.href;
  } catch { return href; }
}

function internalPaths($) {
  const out = new Set();
  $('a[href], [data-url]').each((_, el) => {
    const raw = $(el).attr('href') ?? $(el).attr('data-url');
    try {
      const u = new URL(raw, ORIGIN);
      if (u.host === HOST) out.add(normalizePath(u.pathname));
    } catch {}
  });
  return out;
}

const youtubeId = (src) => (src.match(/youtube(?:-nocookie)?\.com\/embed\/([\w-]{11})/) || src.match(/youtu\.be\/([\w-]{11})/))?.[1];

/** Where a legacy path lands. Anything with a card on /projects is a project, wherever it lived. */
function target(p, cards) {
  if (p.startsWith('/projects/')) return { collection: 'projects', slug: p.split('/')[2] };
  const slug = p === '/' ? 'home' : p.slice(1).replaceAll('/', '-').toLowerCase();
  return { collection: cards.has(p) ? 'projects' : 'pages', slug };
}

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

/** Fetch an image into memory. Tries the original-resolution variant first. */
async function fetchImage(src) {
  const base = src.replace(/=[swh]\d+[^/=]*$/, '');
  for (const candidate of [...new Set([base + '=s0', src])]) {
    try {
      const res = await fetch(candidate);
      const type = (res.headers.get('content-type') || '').split(';')[0];
      if (res.ok && EXT[type]) {
        const buf = Buffer.from(await res.arrayBuffer());
        return { buf, ext: EXT[type], name: `img-${createHash('sha1').update(buf).digest('hex').slice(0, 8)}.${EXT[type]}` };
      }
    } catch {}
  }
  return null;
}

async function saveImage(img, dir) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, img.name), img.buf);
  return img.name;
}

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
td.use(gfm);
// Headings are already bold; Google Sites wraps them in bold spans anyway.
td.addRule('plainHeadings', {
  filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  replacement: (content, node) => `\n\n${'#'.repeat(Number(node.nodeName[1]))} ${content.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()}\n\n`,
});

// ---------------------------------------------------------------- project cards on /projects

/** Cards: image, h1 title, paragraph, "Learn More" button. Images are fetched now, before they expire. */
async function projectCards($) {
  const cards = new Map();
  let order = 0;
  for (const sec of $('section').toArray()) {
    const s = $(sec);
    const href = s.find('a.FKF6mc').attr('href');
    if (!href) continue;
    const p = normalizePath(unwrapGoogleRedirect(href));
    const src = s.find('img').attr('src');
    cards.set(p, {
      order: order++,
      title: s.find('h1, h2').first().text().trim() || undefined,
      summary: s.find('p.zfr3Q').map((_, el) => $(el).text().trim()).get().join(' ').trim() || undefined,
      image: src ? await fetchImage(src) : null,
    });
  }
  return cards;
}

// ---------------------------------------------------------------- page -> markdown

async function convert(p, $, cards) {
  const { collection, slug } = target(p, cards);
  const pageTitle = $('title').text().replace(/^Dorian Todd\s*(-\s*)?/, '').trim();
  const dir = path.join(CONTENT, collection, slug);
  const images = [];

  // Page content = every <section> outside the footer. section.LB7kq is the title banner.
  const banner = $('section.LB7kq').first();
  const bannerTitle = banner.find('.zfr3Q').first().text().trim();
  const bannerBg = (banner.find('[style*="background-image"]').attr('style') || '').match(/url\(["']?(https:\/\/lh\d[^"')]+)/)?.[1];
  const main = $('<div></div>');
  $('section').each((_, s) => {
    if (!$(s).is('.LB7kq') && !$(s).parents('footer').length) main.append($(s));
  });

  main.find('.CobnVe, .Ap4VC, .yMxPgf').remove(); // anchor spacers

  // Inline styles -> semantic tags
  main.find('span[style]').each((_, el) => {
    const s = $(el).attr('style') || '';
    let inner = $(el).html();
    if (/font-weight:\s*(700|bold)/.test(s)) inner = `<strong>${inner}</strong>`;
    if (/font-style:\s*italic/.test(s)) inner = `<em>${inner}</em>`;
    if (/text-decoration:\s*line-through/.test(s)) inner = `<del>${inner}</del>`;
    $(el).replaceWith(inner);
  });

  main.find('a[href]').each((_, el) => {
    const href = unwrapGoogleRedirect($(el).attr('href'));
    $(el).attr('href', href);
    if (/^https?:/.test(href)) report.externalLinks.add(href);
  });

  // Buttons -> plain links
  main.find('a.FKF6mc').each((_, el) => {
    const label = $(el).attr('aria-label') || $(el).text().trim();
    $(el).closest('.U26fgb').replaceWith(`<p><a href="${$(el).attr('href')}">${label}</a></p>`);
  });

  // Embeds. A bare YouTube URL on its own line becomes a player on the new site.
  main.find('iframe').each((_, el) => {
    const src = $(el).attr('src') || '';
    const id = youtubeId(src);
    const holder = $(el).closest('[data-code]');
    if (id) {
      report.embeds.push({ page: p, type: 'youtube', id, label: ($(el).attr('aria-label') || '').replace(/^YouTube Video,\s*/, '') });
      $(el).replaceWith(`<p>https://www.youtube.com/watch?v=${id}</p>`);
    } else if (!holder.length && /^https?:/.test($(el).parent().attr('data-url') || '')) {
      // "Embed a URL" block, e.g. a Desmos calculator
      const url = $(el).parent().attr('data-url');
      report.embeds.push({ page: p, type: 'url', src: url });
      $(el).replaceWith(`<p>${url}</p>`);
    } else if (holder.length) {
      const file = `embed-${report.customEmbeds.length + 1}.html`;
      report.customEmbeds.push({ page: p, file, code: holder.attr('data-code') });
      $(el).replaceWith(`<p>[[custom embed: migration/embeds/${file}]]</p>`);
    } else {
      warn(p, `unhandled iframe: ${src.slice(0, 100)}`);
      report.embeds.push({ page: p, type: 'other', src });
      $(el).replaceWith(`<p>${src}</p>`);
    }
  });

  // Images: download all of this page's images in parallel, right now.
  const imgEls = main.find('img').toArray().filter((el) => /googleusercontent\.com/.test($(el).attr('src') || ''));
  const fetched = await Promise.all(imgEls.map((el) => fetchImage($(el).attr('src'))));
  for (const [i, el] of imgEls.entries()) {
    const img = fetched[i];
    if (!img) { warn(p, `image download failed (${$(el).attr('src').slice(0, 70)}...)`); $(el).remove(); continue; }
    await saveImage(img, dir);
    images.push({ file: `src/content/${collection}/${slug}/${img.name}`, bytes: img.buf.length });
    const alt = ($(el).attr('alt') || '').replace(/"/g, '');
    const block = $(el).closest('.t3iYD').length ? $(el).closest('.t3iYD') : $(el);
    block.replaceWith(`<p><img src="./${img.name}" alt="${alt}"></p>`);
  }
  main.find('img').filter((_, el) => !($(el).attr('src') || '').startsWith('./')).remove(); // failed/foreign images
  main.find('a').filter((_, a) => !$(a).text().trim() && !$(a).find('img').length).remove(); // icon-only social links

  const md = td.turndown(main.html() || '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(EMOJI, '')
    .replace(/^https?:\/\/\S+$/gm, (line) => line.replace(/\\([_*~])/g, '$1')) // bare URL lines stay unescaped
    .replace(/^\\\[\\\[(.*)\\\]\\\]$/gm, '<!-- $1 -->')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Front matter
  const card = cards.get(p);
  const firstHeading = md.match(/^#{1,3} (.+)$/m)?.[1];
  const fm = { title: card?.title || bannerTitle || pageTitle || firstHeading || slug };
  if (!p.startsWith('/projects/')) fm.path = p; // keep the legacy URL
  if (card?.summary) fm.summary = card.summary;
  if (card?.order != null) fm.order = card.order;
  let cover = card?.image ? await saveImage(card.image, dir) : null;
  if (!cover && bannerBg) { const b = await fetchImage(bannerBg); if (b) cover = await saveImage(b, dir); }
  if (!cover && images[0]) cover = path.basename(images[0].file);
  if (cover) fm.cover = `./${cover}`;
  if (collection === 'projects') fm.tags = [];
  fm.migratedFrom = ORIGIN + p;

  const file = path.join(dir, 'index.md');
  const exists = await fs.access(file).then(() => true, () => false);
  if (exists && !FORCE) console.log('  kept existing', path.relative(ROOT, file));
  else {
    await fs.mkdir(dir, { recursive: true });
    const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
    await fs.writeFile(file, `---\n${yaml}\n---\n\n${md}\n`);
  }

  if (md.replace(/!\[.*?\]\(.*?\)/g, '').trim().length < 40) warn(p, 'converted to almost no text - compare with the archive');
  return { path: p, file: `src/content/${collection}/${slug}/index.md`, title: fm.title, images, words: md.split(/\s+/).length };
}

// ---------------------------------------------------------------- main

await fs.mkdir(ARCHIVE, { recursive: true });
const results = [];
const seen = new Set();
const queue = [...SEEDS];
let cards = new Map();

while (queue.length) {
  const p = queue.shift();
  if (seen.has(p)) continue;
  seen.add(p);
  console.log('page', p);
  let html;
  try {
    const res = await fetch(ORIGIN + (p === '/' ? '/home' : p));
    if (!res.ok) throw new Error(String(res.status));
    html = await res.text();
  } catch (e) { warn(p, `fetch failed: ${e.message}`); continue; }
  await fs.writeFile(archiveFile(p), html);

  const $ = cheerio.load(html);
  for (const next of internalPaths($)) if (!seen.has(next)) queue.push(next);
  if (p === '/projects') {
    // The listing is generated by the new site from project front matter, so no page file for it.
    cards = await projectCards(cheerio.load(html));
    continue;
  }
  results.push(await convert(p, $, cards));
}

await fs.mkdir(path.join(ROOT, 'migration', 'embeds'), { recursive: true });
for (const e of report.customEmbeds) await fs.writeFile(path.join(ROOT, 'migration', 'embeds', e.file), e.code);

const manifest = {
  origin: ORIGIN,
  crawledAt: new Date().toISOString(),
  pages: results,
  embeds: report.embeds,
  customEmbeds: report.customEmbeds.map(({ page, file }) => ({ page, file })),
  externalLinks: [...report.externalLinks].sort(),
};
await fs.writeFile(path.join(ROOT, 'migration', 'manifest.json'), JSON.stringify(manifest, null, 2));

// Large GIFs -> looping MP4 (the same script runs on new content via `npm run media`)
const { optimizeMedia } = await import('../scripts/optimize-media.mjs');
await optimizeMedia(CONTENT);

const totalImgs = results.reduce((n, r) => n + r.images.length, 0);
const mb = (results.reduce((n, r) => n + r.images.reduce((a, i) => a + i.bytes, 0), 0) / 1e6).toFixed(1);
await fs.writeFile(path.join(ROOT, 'migration', 'REPORT.md'), `# Migration report

Crawled ${ORIGIN} on ${manifest.crawledAt.slice(0, 10)}.

| Legacy URL | New file | Images | Words |
|---|---|---|---|
${results.map((r) => `| ${r.path} | ${r.file} | ${r.images.length} | ${r.words} |`).join('\n')}

**${results.length} pages, ${totalImgs} images (${mb} MB before GIF conversion), ${report.embeds.length} embeds.**

The \`/projects\` listing page isn't migrated as a file: the new site builds it from each project's
front matter (title, summary, cover, order), which the crawler took from the old listing cards.

## Needs a human

${[...report.warnings, ...report.customEmbeds.map((e) => `- \`${e.page}\`: custom HTML embed saved to \`migration/embeds/${e.file}\``)].join('\n') || '- Nothing flagged.'}

## Embeds

${report.embeds.map((e) => `- \`${e.page}\` ${e.type}: ${e.id ? `https://youtu.be/${e.id} (${e.label})` : e.src}`).join('\n')}

## External links

${manifest.externalLinks.map((l) => `- ${l}`).join('\n')}
`);

console.log(`\nDone: ${results.length} pages, ${totalImgs} images (${mb} MB), ${report.warnings.length} warnings. See migration/REPORT.md`);
