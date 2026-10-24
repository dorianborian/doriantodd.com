// Search engine, link preview and AI-crawler metadata: JSON-LD graphs (schema.org) for every page type.
// Facts about the person and the channel live here once and are reused everywhere, so search engines and
// language models see one consistent entity ("Dorian Todd") tied to the site, the YouTube channel and GitHub.

import { execFileSync } from 'node:child_process';
import youtube from '../data/youtube.json';
import { SITE } from './site';

export const ORIGIN = 'https://www.doriantodd.com';
export const abs = (u: string) => new URL(u, ORIGIN).href;

const PERSON_ID = `${ORIGIN}/#person`;
const SITE_ID = `${ORIGIN}/#website`;
const CHANNEL = 'https://www.youtube.com/@DorianToddYT';

export const PROFILE = {
  name: SITE.name,
  alternateName: ['dorianborian', 'DorianToddYT'],
  jobTitle: 'Open source robotics developer and YouTuber',
  description:
    'Dorian Todd is an open source robotics developer and YouTuber who designs and builds robots, including Sesame, ' +
    'an open source 3D printed ESP32 quadruped robot, and documents the builds for his YouTube channel.',
  knowsAbout: [
    'Robotics', 'Quadruped robots', 'Walking robots', 'Hexapod robots', 'Open source hardware', 'ESP32', 'Arduino',
    'Servo motors', '3D printing', 'Fusion 360', 'PCB design', 'Embedded systems', 'Computer vision', 'ROS 2',
    'Combat robotics', 'Linkage mechanisms', 'Pen plotters', 'Connectomics', 'Maker education',
  ],
  sameAs: [CHANNEL, ...SITE.social.map((s) => s.url), 'https://github.com/dorianborian/sesame-robot'],
  awards: ['Audience Award, SF Tech Week Robot Contest by DaiDai Labs (2026), for the Autonomous Fridge Tank'],
};

export const CHANNEL_STATS = youtube.channel as { url: string; subscribers: string; videos: string; checked: string };
export const VIDEOS = youtube.videos as Record<string, { id: string; title: string; description?: string; uploadDate?: string; seconds?: number | null; views?: number | null }>;

const isoDuration = (s: number) => `PT${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}H` : ''}${Math.floor((s % 3600) / 60)}M${s % 60}S`;

export function videoNode(id: string) {
  const v = VIDEOS[id];
  if (!v) return null;
  return {
    '@type': 'VideoObject',
    '@id': `https://www.youtube.com/watch?v=${id}#video`,
    name: v.title,
    description: (v.description || v.title).split('\n').filter(Boolean).slice(0, 4).join(' ').slice(0, 300),
    thumbnailUrl: [`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`],
    uploadDate: v.uploadDate,
    ...(v.seconds ? { duration: isoDuration(v.seconds) } : {}),
    embedUrl: `https://www.youtube.com/embed/${id}`,
    url: `https://www.youtube.com/watch?v=${id}`,
    ...(v.views ? { interactionStatistic: { '@type': 'InteractionCounter', interactionType: { '@type': 'WatchAction' }, userInteractionCount: v.views } } : {}),
    author: { '@id': PERSON_ID },
  };
}

/** YouTube ids in a Markdown body, in order of appearance. */
export function videoIds(body = '') {
  const ids: string[] = [];
  for (const m of body.matchAll(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/g)) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

export function personNode(image: string) {
  return {
    '@type': 'Person',
    '@id': PERSON_ID,
    name: PROFILE.name,
    alternateName: PROFILE.alternateName,
    url: `${ORIGIN}/`,
    image: { '@type': 'ImageObject', url: abs(image), caption: PROFILE.name },
    jobTitle: PROFILE.jobTitle,
    description: PROFILE.description,
    email: `mailto:${SITE.email}`,
    knowsAbout: PROFILE.knowsAbout,
    award: PROFILE.awards,
    sameAs: PROFILE.sameAs,
    mainEntityOfPage: `${ORIGIN}/about/`,
  };
}

export function websiteNode() {
  return {
    '@type': 'WebSite',
    '@id': SITE_ID,
    url: `${ORIGIN}/`,
    name: SITE.name,
    alternateName: 'doriantodd.com',
    description: `${SITE.name}: open source robots, build guides and videos.`,
    inLanguage: 'en',
    publisher: { '@id': PERSON_ID },
    author: { '@id': PERSON_ID },
  };
}

export function breadcrumbs(items: { name: string; url: string }[]) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: abs(it.url) })),
  };
}

export function faqNode(faq: { q: string; a: string }[], url: string) {
  return {
    '@type': 'FAQPage',
    '@id': `${abs(url)}#faq`,
    mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  };
}

/** Last commit touching a file, for dateModified and the sitemap. Falls back to now. */
export function lastModified(file: string | undefined) {
  if (!file) return new Date().toISOString();
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], { encoding: 'utf8' }).trim();
    return out || new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

export const LICENSES: Record<string, string> = {
  'dorianborian/sesame-robot': 'https://www.apache.org/licenses/LICENSE-2.0',
};

type ProjectInfo = {
  url: string; title: string; headline: string; description: string; image: string; images: string[]; tags: string[];
  keywords: string[]; year: number | null; modified: string; repo?: string; body?: string; faq: { q: string; a: string }[];
  parent?: { name: string; url: string } | null; links: { label: string; url: string }[]; portrait: string;
};

/** Article + project + videos + FAQ + breadcrumbs for a project page. */
export function projectGraph(p: ProjectInfo) {
  const url = abs(p.url);
  const videos = videoIds(p.body).map(videoNode).filter(Boolean) as ReturnType<typeof videoNode>[];
  const projectId = `${url}#project`;
  const graph: Record<string, unknown>[] = [
    personNode(p.portrait),
    websiteNode(),
    {
      '@type': 'WebPage',
      '@id': `${url}#webpage`,
      url,
      name: p.headline,
      description: p.description,
      isPartOf: { '@id': SITE_ID },
      primaryImageOfPage: { '@type': 'ImageObject', url: abs(p.image) },
      breadcrumb: { '@id': `${url}#breadcrumb` },
      about: { '@id': projectId },
      inLanguage: 'en',
      dateModified: p.modified,
    },
    {
      '@type': 'TechArticle',
      '@id': `${url}#article`,
      headline: p.headline.slice(0, 110),
      description: p.description,
      image: p.images.map(abs),
      author: { '@id': PERSON_ID },
      publisher: { '@id': PERSON_ID },
      mainEntityOfPage: { '@id': `${url}#webpage` },
      about: { '@id': projectId },
      keywords: [...new Set([...p.tags, ...p.keywords])].join(', '),
      ...(p.year ? { dateCreated: String(p.year) } : {}),
      dateModified: p.modified,
      ...(videos.length ? { video: videos.map((v) => ({ '@id': v!['@id'] })) } : {}),
      inLanguage: 'en',
    },
    {
      '@type': 'CreativeWork',
      '@id': projectId,
      name: p.title,
      description: p.description,
      url,
      image: p.images.map(abs),
      creator: { '@id': PERSON_ID },
      keywords: [...new Set([...p.tags, ...p.keywords])].join(', '),
      ...(p.year ? { dateCreated: String(p.year) } : {}),
      ...(p.repo ? { sameAs: [`https://github.com/${p.repo}`, ...p.links.filter((l) => /^https?:/.test(l.url)).map((l) => l.url)] } : {}),
      ...(p.repo && LICENSES[p.repo] ? { license: LICENSES[p.repo], isAccessibleForFree: true } : {}),
      ...(p.parent ? { isPartOf: { '@type': 'CreativeWork', name: p.parent.name, url: abs(p.parent.url) } } : {}),
    },
    {
      '@id': `${url}#breadcrumb`,
      ...breadcrumbs([{ name: 'Home', url: '/' }, { name: 'Projects', url: '/projects/' }, ...(p.parent ? [p.parent] : []), { name: p.title, url: p.url }]),
    },
    ...videos as Record<string, unknown>[],
  ];
  if (p.repo) {
    graph.push({
      '@type': 'SoftwareSourceCode',
      '@id': `https://github.com/${p.repo}#code`,
      name: p.repo.split('/')[1],
      codeRepository: `https://github.com/${p.repo}`,
      author: { '@id': PERSON_ID },
      about: { '@id': projectId },
      ...(LICENSES[p.repo] ? { license: LICENSES[p.repo] } : {}),
    });
  }
  if (p.faq.length) graph.push(faqNode(p.faq, p.url));
  return { '@context': 'https://schema.org', '@graph': graph };
}

/** A plain page (about, guides, media kit). `profile` marks the about page as the person's profile page. */
export function pageGraph(o: { url: string; title: string; description: string; image: string; portrait: string; modified: string; profile?: boolean; faq?: { q: string; a: string }[]; body?: string; itemList?: { name: string; url: string }[] }) {
  const url = abs(o.url);
  const videos = videoIds(o.body).map(videoNode).filter(Boolean) as Record<string, unknown>[];
  const graph: Record<string, unknown>[] = [
    personNode(o.portrait),
    websiteNode(),
    {
      '@type': o.profile ? 'ProfilePage' : o.itemList ? 'CollectionPage' : 'WebPage',
      '@id': `${url}#webpage`,
      url,
      name: o.title,
      description: o.description,
      isPartOf: { '@id': SITE_ID },
      primaryImageOfPage: { '@type': 'ImageObject', url: abs(o.image) },
      inLanguage: 'en',
      dateModified: o.modified,
      ...(o.profile ? { mainEntity: { '@id': PERSON_ID } } : { author: { '@id': PERSON_ID } }),
      ...(o.itemList ? {
        mainEntity: {
          '@type': 'ItemList',
          itemListElement: o.itemList.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, url: abs(it.url) })),
        },
      } : {}),
      ...(videos.length ? { video: videos.map((v) => ({ '@id': v['@id'] })) } : {}),
    },
    ...videos,
  ];
  if (o.url !== '/') graph.push({ '@id': `${url}#breadcrumb`, ...breadcrumbs([{ name: 'Home', url: '/' }, { name: o.title, url: o.url }]) });
  if (o.faq?.length) graph.push(faqNode(o.faq, o.url));
  return { '@context': 'https://schema.org', '@graph': graph };
}
