import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import remarkEmbeds from './src/lib/remark-embeds.mjs';
import contentAssets from './src/lib/content-assets.mjs';
import sitemap from '@astrojs/sitemap';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Work from the project folder even when started with --root from elsewhere (content scans, git dates,
// and the preview card generator all use paths relative to it).
process.chdir(fileURLToPath(new URL('.', import.meta.url)));

// url path -> source file, for sitemap lastmod (last git commit touching the page)
const SITE_URL = 'https://www.doriantodd.com';
const sources = new Map();
for (const kind of ['projects', 'pages']) {
  const dir = `src/content/${kind}`;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, 'index.md');
    if (!fs.existsSync(file)) continue;
    const m = fs.readFileSync(file, 'utf8').match(/^path:\s*"?([^"\n]+)"?/m);
    const url = m ? m[1] : kind === 'projects' ? `/projects/${name}` : null;
    if (url) sources.set(url === '/' ? '/' : `${url.replace(/\/$/, '')}/`, file);
  }
}
const lastmod = (file) => {
  try { return new Date(execFileSync('git', ['log', '-1', '--format=%cI', '--', file], { encoding: 'utf8' }).trim() || Date.now()); } catch { return new Date(); }
};


export default defineConfig({
  site: 'https://www.doriantodd.com',
  trailingSlash: 'ignore',
  server: { port: Number(process.env.PORT) || 4321 },
  build: { format: 'directory' },
  markdown: {
    processor: unified({ remarkPlugins: [remarkEmbeds] }),
  },
  integrations: [
    contentAssets(),
    sitemap({
      filter: (page) => !page.endsWith('/home/') && !page.includes('/og/'),
      serialize(item) {
        const p = new URL(item.url).pathname;
        const file = sources.get(p);
        const key = p === '/' ? 'home' : p.replace(/^\/|\/$/g, '');
        // every page has a generated preview card; listing it helps image search find the page
        return { ...item, lastmod: file ? lastmod(file) : undefined, img: [{ url: `${SITE_URL}/og/${key}.jpg` }] };
      },
    }),
  ],
  // Old Google Sites URLs that changed. Everything else kept its path.
  // Wrong-case URLs (e.g. /fce) are handled by the 404 page, since /fce and /FCE
  // would be the same folder on Windows and macOS.
  redirects: {
    '/home': '/',
  },
});
