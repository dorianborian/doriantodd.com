import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import remarkEmbeds from './src/lib/remark-embeds.mjs';
import contentAssets from './src/lib/content-assets.mjs';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://www.doriantodd.com',
  trailingSlash: 'ignore',
  server: { port: Number(process.env.PORT) || 4321 },
  build: { format: 'directory' },
  markdown: {
    processor: unified({ remarkPlugins: [remarkEmbeds] }),
  },
  integrations: [contentAssets(), sitemap({ filter: (page) => !page.endsWith('/home/') })],
  // Old Google Sites URLs that changed. Everything else kept its path.
  // Wrong-case URLs (e.g. /fce) are handled by the 404 page, since /fce and /FCE
  // would be the same folder on Windows and macOS.
  redirects: {
    '/home': '/',
  },
});
