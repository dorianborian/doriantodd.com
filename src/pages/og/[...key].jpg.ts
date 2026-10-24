// Link preview cards (Open Graph / Twitter / Discord / iMessage / LinkedIn / Slack): one 1200x630 JPEG per page,
// drawn at build time in the site's CAD style. Text uses the bundled Inter + JetBrains Mono so the cards look
// identical locally and on the build server. Shell.astro points og:image at /og/<key>.jpg.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRoute, GetStaticPaths } from 'astro';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { getCollection } from 'astro:content';
import { getProjects, getUnlistedProjects, SITE } from '../../lib/site';

const ROOT = process.cwd();
const FONTS = ['Inter-Bold.ttf', 'Inter-SemiBold.ttf', 'Inter-Regular.ttf', 'JetBrainsMono-Medium.ttf'].map((f) => path.join(ROOT, 'src/assets/fonts', f));
const W = 1200, H = 630;

type Card = { key: string; kicker: string; title: string; subtitle: string; chips: string[]; image: string | null };

/** The file a `cover: "./x.png"` front matter line points at. */
async function coverOf(file: string) {
  const src = await fs.readFile(file, 'utf8');
  const m = src.match(/^cover:\s*["']?([^"'\n]+)["']?\s*$/m);
  return m ? path.resolve(path.dirname(file), m[1]) : null;
}

const short = (s = '', n = 150) => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,.;:]$/, '') + '...';
};

export const getStaticPaths = (async () => {
  const projects = [...(await getProjects()), ...(await getUnlistedProjects())];
  const pages = await getCollection('pages');
  const homeCover = path.join(ROOT, 'src/content/pages/home/portrait.png');
  const cards: Card[] = [];
  for (const p of projects) {
    const d = p.entry.data;
    const file = path.join(ROOT, 'src/content/projects', p.entry.id.replace(/\/index$/, ''), 'index.md');
    cards.push({
      key: p.url.replace(/^\//, ''),
      kicker: [p.no, p.year, d.tags[0]].filter(Boolean).join('  /  ').toUpperCase(),
      title: d.title,
      subtitle: short(d.description ?? d.summary, 400),
      chips: d.tags.slice(0, 4),
      image: await coverOf(file),
    });
  }
  for (const pg of pages) {
    const d = pg.data;
    const file = path.join(ROOT, 'src/content/pages', pg.id.replace(/\/index$/, ''), 'index.md');
    const key = d.path === '/' ? 'home' : d.path.replace(/^\//, '');
    cards.push({
      key,
      kicker: key === 'home' ? 'OPEN SOURCE ROBOTS  /  BUILD GUIDES  /  VIDEOS' : (d.keywords[0] ?? '').toUpperCase(),
      title: key === 'home' ? SITE.name : d.title,
      subtitle: short(key === 'home' ? 'Robots, build logs, CAD and code. Open source projects to learn from and build yourself.' : (d.description ?? d.summary ?? ''), 400),
      chips: key === 'home' ? ['Robotics', 'Open source', 'YouTube'] : d.keywords.slice(0, 3),
      image: (await coverOf(file)) ?? homeCover,
    });
  }
  cards.push({
    key: 'projects',
    kicker: 'ALL PROJECTS',
    title: 'Robots and open source hardware',
    subtitle: 'Walking robots, a combat robot, drawing robots, LED art and a fruit fly brain driving a robot. CAD, code and build logs.',
    chips: ['Quadruped', 'ESP32', '3D printing'],
    image: await coverOf(path.join(ROOT, 'src/content/projects/sesame/index.md')),
  });
  return cards.map((c) => ({ params: { key: c.key }, props: c }));
}) satisfies GetStaticPaths;

// ---------------------------------------------------------------- text layout
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const charW = (c: string) => (/[iljI.,:;'!|1tf ]/.test(c) ? 0.3 : /[mwMW]/.test(c) ? 0.86 : /[A-Z0-9]/.test(c) ? 0.66 : 0.55);
const width = (s: string, size: number) => [...s].reduce((w, c) => w + charW(c), 0) * size;
function wrap(text: string, size: number, max: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (width(next, size) > max && line) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

async function render(c: Card) {
  const gear = (await fs.readFile(path.join(ROOT, 'src/assets/gear.png'))).toString('base64');
  const textW = c.image ? 560 : 1060;
  let size = 76, title: string[] = [];
  for (size of [76, 68, 60, 54, 48]) { title = wrap(c.title, size, textW); if (title.length <= 2) break; }
  if (title.length > 3) title = [...title.slice(0, 2), title.slice(2).join(' ')];
  const titleTop = 168 + size * 0.98;
  const subTop = titleTop + (title.length - 1) * size * 1.08 + 58;
  // as many description lines as fit above the tag row, ending on a whole word
  const maxSub = Math.max(1, Math.min(3, Math.floor((488 - subTop) / 34) + 1));
  let sub = wrap(c.subtitle, 25, textW);
  if (sub.length > maxSub) {
    sub = sub.slice(0, maxSub);
    let last = sub[maxSub - 1];
    while (width(`${last}...`, 25) > textW) last = last.slice(0, last.lastIndexOf(' '));
    sub[maxSub - 1] = `${last.replace(/[,.;:]$/, '')}...`;
  }

  let photo = '';
  if (c.image) {
    const img = await sharp(c.image).resize(500, 510, { fit: 'cover', position: 'attention' }).jpeg({ quality: 88 }).toBuffer();
    photo = `
      <clipPath id="clip"><rect x="652" y="60" width="500" height="510" rx="10"/></clipPath>
      <image href="data:image/jpeg;base64,${img.toString('base64')}" x="652" y="60" width="500" height="510" clip-path="url(#clip)" preserveAspectRatio="xMidYMid slice"/>
      <rect x="652.5" y="60.5" width="499" height="509" rx="10" fill="none" stroke="#3b3e45"/>
      <g stroke="#4a9bff" stroke-width="3" fill="none">
        <path d="M640 82 V48 H674"/><path d="M1130 48 H1164 V82"/><path d="M640 548 V582 H674"/><path d="M1130 582 H1164 V548"/>
      </g>
      <g stroke="#6f7580" stroke-width="1.4" fill="none">
        <path d="M652 600 H880"/><path d="M924 600 H1152"/><path d="M652 592 V608"/><path d="M1152 592 V608"/>
        <path d="M652 600 l12 -5 v10 z" fill="#6f7580"/><path d="M1152 600 l-12 -5 v10 z" fill="#6f7580"/>
      </g>
      <text x="902" y="606" font-family="JetBrains Mono" font-size="16" fill="#9aa3b0" text-anchor="middle">500</text>`;
  }
  let chipX = 64;
  const chips = c.chips.map((t) => {
    const w = width(t, 20) + 30;
    const out = `<rect x="${chipX}" y="512" width="${w}" height="38" rx="19" fill="#202125" stroke="#3b3e45"/><text x="${chipX + w / 2}" y="537" font-family="Inter" font-weight="600" font-size="20" fill="#c9d0da" text-anchor="middle">${esc(t)}</text>`;
    chipX += w + 10;
    return chipX > textW + 64 ? '' : out;
  }).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <pattern id="g" width="30" height="30" patternUnits="userSpaceOnUse"><path d="M30 0H0V30" fill="none" stroke="#202226" stroke-width="1"/></pattern>
      <radialGradient id="glow" cx="0.2" cy="0.1" r="0.9"><stop offset="0" stop-color="#1f2a3d"/><stop offset="1" stop-color="#16171a"/></radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#glow)"/>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    <rect width="8" height="${H}" fill="#4a9bff"/>
    <image href="data:image/png;base64,${gear}" x="64" y="62" width="40" height="40"/>
    <text x="118" y="90" font-family="JetBrains Mono" font-size="22" fill="#c9d0da">doriantodd.com</text>
    <text x="64" y="160" font-family="JetBrains Mono" font-size="19" letter-spacing="1.5" fill="#4a9bff">${esc(c.kicker)}</text>
    ${title.map((l, i) => `<text x="64" y="${titleTop + i * size * 1.08}" font-family="Inter" font-weight="700" font-size="${size}" fill="#f2f4f7">${esc(l)}</text>`).join('')}
    ${sub.map((l, i) => `<text x="64" y="${subTop + i * 34}" font-family="Inter" font-size="25" fill="#a4aab3">${esc(l)}</text>`).join('')}
    ${chips}
    ${photo}
  </svg>`;
  const png = new Resvg(svg, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' }, fitTo: { mode: 'width', value: W } }).render().asPng();
  return sharp(png).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
}

export const GET: APIRoute = async ({ props }) => {
  const body = await render(props as Card);
  return new Response(new Uint8Array(body), { headers: { 'Content-Type': 'image/jpeg' } });
};
