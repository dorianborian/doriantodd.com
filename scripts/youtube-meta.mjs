// Caches metadata for every YouTube video embedded in the content (and the home page videos) into
// src/data/youtube.json, for VideoObject structured data and the media kit page.
//
//   node scripts/youtube-meta.mjs          only fetches videos that are not cached yet
//   node scripts/youtube-meta.mjs --all    refreshes everything (view counts, titles)
//
// Reads the public watch page; no API key needed. Also records the channel's subscriber and video counts.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/data/youtube.json');
const CHANNEL = 'https://www.youtube.com/@DorianToddYT';
const all = process.argv.includes('--all');

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const ID = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/g;
const ids = new Set();
for (const f of await walk(path.join(ROOT, 'src/content'))) for (const m of (await fs.readFile(f, 'utf8')).matchAll(ID)) ids.add(m[1]);

let cache = { channel: null, videos: {} };
try { cache = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch {}

const get = (url) => fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en-US,en' } }).then((r) => r.text());
const pick = (html, re) => html.match(re)?.[1];
const unescape = (s) => (s ? JSON.parse(`"${s}"`) : s);

for (const id of ids) {
  if (!all && cache.videos[id]) continue;
  const html = await get(`https://www.youtube.com/watch?v=${id}`);
  const v = {
    id,
    title: unescape(pick(html, /"videoDetails":\{[^]*?"title":"((?:[^"\\]|\\.)*)"/)),
    description: unescape(pick(html, /"shortDescription":"((?:[^"\\]|\\.)*)"/))?.slice(0, 600),
    uploadDate: pick(html, /<meta itemprop="uploadDate" content="([^"]+)"/) ?? pick(html, /"uploadDate":"([^"]+)"/) ?? pick(html, /"publishDate":"([^"]+)"/),
    seconds: Number(pick(html, /"lengthSeconds":"(\d+)"/)) || null,
    views: Number(pick(html, /"viewCount":"(\d+)"/)) || null,
    channel: unescape(pick(html, /"ownerChannelName":"((?:[^"\\]|\\.)*)"/)),
  };
  if (!v.title) { console.warn('no data for', id); continue; }
  cache.videos[id] = v;
  console.log(id, v.uploadDate, v.views, v.title);
}

const ch = await get(CHANNEL);
cache.channel = {
  url: CHANNEL,
  subscribers: pick(ch, /"content":"([\d.,]+[KM]?) subscribers"/) ?? cache.channel?.subscribers,
  videos: pick(ch, /"content":"([\d,]+) videos"/) ?? cache.channel?.videos,
  checked: new Date().toISOString().slice(0, 10),
};
await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, JSON.stringify(cache, null, 1));
console.log('channel', cache.channel);
