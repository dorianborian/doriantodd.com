// Markdown conventions for this site. Everything here is plain Markdown, no components needed.
//
//   https://www.youtube.com/watch?v=ID     on its own line  -> click-to-load YouTube player
//   https://www.desmos.com/calculator/ID   on its own line  -> embedded calculator
//   ![right: caption](./photo.jpg)  or left:                -> figure the text wraps around on desktop
//   <div class="widget" data-widget="name"></div>          -> interactive widget (src/scripts/widgets)
//   ![caption](./clip.mp4)                                  -> looping muted video
//   ![caption](./part.stl)  or .glb / .gltf / .obj          -> interactive 3D viewer
//   [datasheet](./file.pdf)                                  -> link to a file stored next to the post
//   a bullet list where every item is a YouTube link          -> playlist widget (link text = video title)
//   > [!SPONSOR] elegoo                                      -> sponsor section with the partner's link
//   > Text about what they provided. ![Logo](./logo.png)
//
// Non-image files next to a post are published under /content-assets/ by content-assets.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENT_ROOT = fileURLToPath(new URL('../content', import.meta.url));
const VIDEO = /\.(mp4|webm|mov)$/i;
const MODEL = /\.(stl|glb|gltf|obj|3mf)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

/** Partners that can appear in sponsor sections. Affiliate links carry a disclosure. */
const SPONSORS = {
  bambu: { name: 'Bambu Lab', url: 'https://tidd.ly/4xSSB8V', cta: 'Shop Bambu Lab', color: '#00ae42', affiliate: true },
  elegoo: { name: 'ELEGOO', url: 'https://tidd.ly/3RG2OG0', cta: 'Shop ELEGOO', color: '#3b82f6', affiliate: true },
  manifold: { name: 'Manifold Tech', url: 'https://store.3dmanifold.com/products/odin1-spatial-memory-module-for-robotics', cta: 'See the ODIN 1', color: '#22d3ee', affiliate: true },
  pcbway: { name: 'PCBWay', url: 'https://www.pcbway.com/', cta: 'Visit PCBWay', color: '#16a34a', affiliate: false },
};

const esc = (s = '') => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function assetUrl(file, rel) {
  const abs = path.resolve(path.dirname(file), decodeURI(rel));
  const inContent = path.relative(CONTENT_ROOT, abs);
  if (inContent.startsWith('..')) return rel;
  return '/content-assets/' + inContent.split(path.sep).map(encodeURIComponent).join('/');
}

const isRelative = (url) => !/^([a-z]+:|\/|#)/i.test(url);

function youtubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1);
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(u.hostname)) {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(embed|shorts|live)\/([\w-]{11})/);
      return m?.[2];
    }
  } catch {}
  return null;
}

function blockFor(url) {
  const yt = youtubeId(url);
  if (yt) {
    return `<div class="embed yt" data-yt="${esc(yt)}"><button type="button" aria-label="Play video"><img src="https://i.ytimg.com/vi/${esc(yt)}/hqdefault.jpg" alt="" loading="lazy" decoding="async"><span class="play"></span></button><a class="embed-caption" href="https://www.youtube.com/watch?v=${esc(yt)}" target="_blank" rel="noopener">youtube.com/watch?v=${esc(yt)}</a></div>`;
  }
  if (/^https:\/\/www\.desmos\.com\/calculator\//.test(url)) {
    return `<div class="embed frame"><iframe src="${esc(url)}?embed" loading="lazy" title="Desmos calculator"></iframe></div>`;
  }
  return null;
}

/** Text of a paragraph that is nothing but one URL (autolinked or not). */
function loneUrl(node) {
  if (node.type !== 'paragraph' || node.children.length !== 1) return null;
  const [child] = node.children;
  if (child.type === 'link' && child.children.length === 1 && child.children[0].type === 'text' && child.children[0].value === child.url) return child.url;
  if (child.type === 'text' && /^https?:\/\/\S+$/.test(child.value.trim())) return child.value.trim();
  return null;
}

export default function remarkEmbeds() {
  return (tree, vfile) => {
    const file = vfile.path;
    const walk = (node) => {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        const url = loneUrl(child);
        const html = url && blockFor(url);
        if (html) return { type: 'html', value: html };

        if (child.type === 'paragraph' && child.children.length === 1 && child.children[0].type === 'image') {
          const img = child.children[0];
          if (file && isRelative(img.url) && VIDEO.test(img.url)) {
            const src = assetUrl(file, img.url);
            const posterRel = img.url.replace(VIDEO, '.poster.jpg');
            const poster = fs.existsSync(path.resolve(path.dirname(file), posterRel)) ? ` poster="${esc(assetUrl(file, posterRel))}"` : '';
            const side = /^(left|right)\s*:\s*/i.exec(img.alt ?? '');
            const alt = side ? img.alt.slice(side[0].length) : img.alt;
            const cls = side ? ` float-${side[1].toLowerCase()}` : '';
            return { type: 'html', value: `<figure class="media${cls}"><video src="${esc(src)}" ${poster} autoplay muted loop playsinline preload="metadata"></video>${alt ? `<figcaption>${esc(alt)}</figcaption>` : ''}</figure>` };
          }
          if (file && isRelative(img.url) && MODEL.test(img.url)) {
            return { type: 'html', value: `<figure class="media"><cad-viewer src="${esc(assetUrl(file, img.url))}" name="${esc(img.alt || path.basename(img.url))}"></cad-viewer>${img.alt ? `<figcaption>${esc(img.alt)}</figcaption>` : ''}</figure>` };
          }
        }

        walk(child);
        if (child.type === 'link' && file && isRelative(child.url) && !IMAGE.test(child.url) && !/\.mdx?$/.test(child.url)) {
          child.url = assetUrl(file, child.url);
        }
        return child;
      });
    };
    walk(tree);
    galleries(tree);
  };
}

const text = (node) => (node.value ?? '') + (node.children ?? []).map(text).join('');
const isImagePara = (n) => n.type === 'paragraph' && n.children.length === 1 && n.children[0].type === 'image';
const isFloat = (n) => isImagePara(n) && /^(left|right)\s*:/i.test(n.children[0].alt ?? '');
const isClip = (n) => n.type === 'html' && n.value.startsWith('<figure class="media"><video');

/**
 * Top-level layout pass:
 * - two or more images/clips in a row become a grid; five or more become a carousel
 * - an image with alt text gets that text as a visible caption
 * - images without alt text get the surrounding section heading as alt text
 */
function sponsorBlock(n) {
  if (n.type !== 'blockquote') return null;
  const first = n.children[0];
  const lead = first?.type === 'paragraph' ? first.children[0] : null;
  const m = lead?.type === 'text' && lead.value.match(/^\s*\[!SPONSOR\]\s*([a-z]+)\s*/i);
  if (!m) return null;
  const sp = SPONSORS[m[1].toLowerCase()];
  if (!sp) return null;
  lead.value = lead.value.slice(m[0].length);
  if (!lead.value.trim() && first.children.length === 1) n.children.shift();
  // a logo image anywhere in the block goes to the header
  let logo = null;
  n.children = n.children.filter((c) => {
    if (!logo && isImagePara(c)) { logo = c; return false; }
    return true;
  });
  const link = `<a class="sponsor-cta" href="${esc(sp.url)}" target="_blank" rel="sponsored noopener">${esc(sp.cta)}<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3.5h-9v-9H6"/></svg></a>`;
  const note = sp.affiliate ? '<small class="sponsor-note">Affiliate link: I may earn a commission, at no cost to you.</small>' : '<small class="sponsor-note">Sponsor link.</small>';
  return [
    { type: 'html', value: `<aside class="sponsor" style="--brand:${sp.color}" aria-label="Sponsored by ${esc(sp.name)}"><div class="sponsor-mark">` },
    ...(logo ? [logo] : [{ type: 'html', value: `<span class="sponsor-word">${esc(sp.name)}</span>` }]),
    { type: 'html', value: `</div><div class="sponsor-body"><span class="sponsor-tag">Sponsored by ${esc(sp.name)}</span>` },
    ...n.children,
    { type: 'html', value: `<div class="sponsor-foot">${link}${note}</div></div></aside>` },
  ];
}

function playlistBlock(n) {
  if (n.type !== 'list' || n.children.length < 2) return null;
  const vids = [];
  for (const item of n.children) {
    const p = item.children?.[0];
    const a = p?.type === 'paragraph' && p.children.length === 1 ? p.children[0] : null;
    const id = a?.type === 'link' ? youtubeId(a.url) : null;
    if (!id || item.children.length !== 1) return null;
    vids.push({ id, title: text(a) });
  }
  const thumb = (id) => `https://i.ytimg.com/vi/${esc(id)}/mqdefault.jpg`;
  const items = vids.map((v, i) => `<li><button type="button" data-play="${esc(v.id)}"${i ? '' : ' aria-current="true"'}><img src="${thumb(v.id)}" alt="" loading="lazy" decoding="async"><span>${esc(v.title)}</span></button></li>`).join('');
  return [{ type: 'html', value: `<div class="playlist"><div class="playlist-head"><span>Videos</span><small>${vids.length}</small></div><div class="playlist-stage">${blockFor('https://www.youtube.com/watch?v=' + vids[0].id)}</div><ol class="playlist-list">${items}</ol></div>` }];
}

function galleries(tree) {
  const out = [];
  let heading = '';
  const kids = tree.children;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n.type === 'heading') heading = text(n);
    const special = sponsorBlock(n) ?? playlistBlock(n);
    if (special) { out.push(...special); continue; }
    if (!isImagePara(n) && !isClip(n)) { out.push(n); continue; }

    // a floated figure always stands alone and ends a gallery run
    const run = [];
    if (isFloat(n)) run.push(n);
    else {
      while (i < kids.length && !isFloat(kids[i]) && (isImagePara(kids[i]) || isClip(kids[i]))) run.push(kids[i++]);
      i--;
    }
    const item = (m) => {
      if (!isImagePara(m)) return [m];
      const img = m.children[0];
      const side = /^(left|right)\s*:\s*/i.exec(img.alt ?? '');
      if (side) img.alt = img.alt.slice(side[0].length);
      const caption = img.alt?.trim();
      if (!caption) img.alt = heading ? `${heading}` : '';
      const cls = side && run.length === 1 ? ` float-${side[1].toLowerCase()}` : '';
      return caption || cls
        ? [{ type: 'html', value: `<figure class="media${cls}">` }, m, { type: 'html', value: `${caption ? `<figcaption>${esc(caption)}</figcaption>` : ''}</figure>` }]
        : [m];
    };
    if (run.length === 1) { out.push(...item(run[0])); continue; }
    const kind = run.length >= 5 ? 'gallery carousel' : 'gallery';
    out.push({ type: 'html', value: `<div class="${kind}" data-count="${run.length}"><div class="gallery-track">` });
    for (const m of run) {
      out.push({ type: 'html', value: '<div class="gallery-item">' }, ...item(m), { type: 'html', value: '</div>' });
    }
    out.push({ type: 'html', value: '</div></div>' });
  }
  tree.children = out;
}
