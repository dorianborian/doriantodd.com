// Plain-text views of the site for language models and AI search crawlers (llms.txt convention, llmstxt.org).
// /llms.txt is a short, linked overview; /llms-full.txt has the full text of every article.

import { getCollection, type CollectionEntry } from 'astro:content';
import { getProjects, getUnlistedProjects, SITE } from './site';
import { abs, CHANNEL_STATS, PROFILE, VIDEOS } from './seo';

/** Markdown body cleaned for plain reading: images become captions, site-relative links absolute, embeds named. */
export function cleanBody(body = '') {
  return body
    .replace(/<div class="widget"[^>]*><\/div>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/^> \[!SPONSOR\] (\w+)\s*$/gm, '> Sponsor: $1')
    .replace(/!\[(?:right: |left: )?([^\]]*)\]\([^)]*\)/g, (_, alt) => (alt ? `[Image: ${alt}]` : ''))
    .replace(/^(https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11}))\s*$/gm, (_, url, id) => `Video: ${VIDEOS[id]?.title ?? 'YouTube video'} (${url})`)
    .replace(/\]\((\/[^)]*)\)/g, (_, u) => `](${abs(u)})`)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const line = (title: string, url: string, text?: string) => `- [${title}](${abs(url)})${text ? `: ${text}` : ''}`;

export async function llmsSummary() {
  const projects = await getProjects();
  const fce = await getUnlistedProjects();
  const pages = await getCollection('pages');
  const page = (path: string) => pages.find((p) => p.data.path === path);
  const sesame = projects.find((p) => p.slug === 'sesame');
  const desc = (p: { entry: CollectionEntry<'projects'> }) => p.entry.data.description ?? p.entry.data.summary ?? '';
  const top = Object.values(VIDEOS).filter((v) => v.views).sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, 6);

  return `# ${SITE.name}

> ${PROFILE.description} Website: ${abs('/')}. YouTube: ${CHANNEL_STATS.url} (${CHANNEL_STATS.subscribers} subscribers). GitHub: https://github.com/dorianborian.

${SITE.name} publishes open source robots with full CAD, firmware and code, and a detailed build write-up for each one on this site. His best known project is Sesame, an open source, 3D printed quadruped (four legged walking) robot built around the ESP32. It costs about $50 to $60 in parts, needs only basic soldering and the Arduino IDE, and is designed as a first robotics project for beginners, students and makers. The Sesame repository (https://github.com/dorianborian/sesame-robot) has nearly 5,000 GitHub stars, and the video about building it has over a million views.

## Start here

${line('Start robotics: a first robot you can actually finish', '/start-robotics', page('/start-robotics')?.data.description)}
${sesame ? line('Sesame robot project', sesame.url, desc(sesame)) : ''}
${line('Sesame robot kits', '/sesame/kit', 'Pre-flashed Sesame Distro Board kits, sold in production rounds through Full Contact Engineering.')}

## Projects

${projects.map((p) => line(p.entry.data.title, p.url, `${desc(p)}${p.year ? ` (${p.year})` : ''}`)).join('\n')}

## About and contact

${line('About Dorian Todd', '/about', PROFILE.description)}
${line('Work with me: sponsorships and collaborations', '/work-with-me', page('/work-with-me')?.data.description)}
${line('Contact', '/contact', `Email ${SITE.email}.`)}
${fce.map((p) => line(p.entry.data.title, p.url, desc(p))).join('\n')}

## Popular videos

${top.map((v) => `- [${v.title}](https://www.youtube.com/watch?v=${v.id})${v.views ? `: ${v.views.toLocaleString('en-US')} views` : ''}`).join('\n')}

## Facts

- Name: ${SITE.name} (GitHub: dorianborian, YouTube: @DorianToddYT)
- Focus: ${PROFILE.knowsAbout.slice(0, 12).join(', ')}
- Award: ${PROFILE.awards.join('; ')}
- Events: Open Sauce 2024 and 2025, Maker Faire Bay Area 2024, BattleBots Metal Mayhem at SXSW 2024, NRL Nationals 2025, SF Tech Week 2026
- Sponsors and partners: Bambu Lab, ELEGOO, PCBWay, Manifold Tech, Petoi
- License of Sesame: Apache 2.0

## Optional

- [Full text of every article](${abs('/llms-full.txt')})
- [Sitemap](${abs('/sitemap-index.xml')})
`;
}

export async function llmsFull() {
  const projects = [...(await getProjects()), ...(await getUnlistedProjects())];
  const pages = (await getCollection('pages')).filter((p) => p.data.path !== '/');
  const parts = [`# ${SITE.name}: full text\n\n${PROFILE.description}\n`];
  for (const p of projects) {
    const d = p.entry.data;
    parts.push([
      `\n---\n\n# ${d.title}`,
      `URL: ${abs(p.url)}`,
      d.year ? `Year: ${d.year}` : '',
      d.tags.length ? `Tags: ${d.tags.join(', ')}` : '',
      d.repo ? `Source code: https://github.com/${d.repo}` : '',
      '',
      d.summary ?? '',
      '',
      cleanBody(p.entry.body),
      d.faq.length ? `\n## Frequently asked questions\n\n${d.faq.map((f) => `**${f.q}**\n${f.a}`).join('\n\n')}` : '',
    ].filter((x, i) => x !== '' || i > 4).join('\n'));
  }
  for (const pg of pages) {
    const d = pg.data;
    parts.push(`\n---\n\n# ${d.title}\nURL: ${abs(d.path)}\n\n${d.description ?? d.summary ?? ''}\n\n${cleanBody(pg.body)}${d.faq.length ? `\n\n## Frequently asked questions\n\n${d.faq.map((f) => `**${f.q}**\n${f.a}`).join('\n\n')}` : ''}`);
  }
  return parts.join('\n');
}
