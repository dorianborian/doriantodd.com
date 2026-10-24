import { getCollection, type CollectionEntry } from 'astro:content';

export type Project = CollectionEntry<'projects'>;
export type Page = CollectionEntry<'pages'>;

export const SITE = {
  name: 'Dorian Todd',
  document: 'doriantodd.com',
  tagline: 'Open Source Hardware R&D',
  email: 'contact@doriantodd.com',
  social: [
    { label: 'YouTube', handle: 'Dorian Todd', url: 'https://www.youtube.com/channel/UC72YiYkvqzR1wqClJKtISnQ' },
    { label: 'GitHub', handle: 'dorianborian', url: 'https://github.com/dorianborian' },
    { label: 'LinkedIn', handle: 'doriantodd', url: 'https://www.linkedin.com/in/doriantodd/' },
    { label: 'Instagram', handle: 'dorian.borian', url: 'https://www.instagram.com/dorian.borian/' },
    { label: 'X', handle: 'Dorian_Todd_', url: 'https://twitter.com/Dorian_Todd_' },
  ],
};

export const slugOf = (id: string) => id.replace(/\/index$/, '');

export const projectUrl = (p: Project) => p.data.path ?? `/projects/${slugOf(p.id)}`;

/** URL of a file stored next to a project's index.md (published by content-assets.mjs). */
export const projectAsset = (p: Project, rel: string) => `/content-assets/projects/${slugOf(p.id)}/${rel.replace(/^\.\//, '')}`;

/** Released projects in display order, with a project number and resolved 3D model info.
 *  Projects with `listed: false` (e.g. FCE, reached from the top nav) are left out and not numbered. */
export async function getProjects() {
  return (await resolveProjects()).filter((p) => p.entry.data.listed !== false);
}

/** Projects with `listed: false`: they keep their page but are not in any project list. */
export async function getUnlistedProjects() {
  return (await resolveProjects()).filter((p) => p.entry.data.listed === false);
}

async function resolveProjects() {
  const all = await getCollection('projects', (p) => import.meta.env.DEV || !p.data.draft);
  const bySlug = new Map(all.map((p) => [slugOf(p.id), p]));
  let counter = 0;
  return all
    .sort((a, b) => a.data.order - b.data.order || a.data.title.localeCompare(b.data.title))
    .map((p) => {
      // modelFrom borrows another project's model and, unless overridden, its orientation
      const source = p.data.modelFrom ? bySlug.get(p.data.modelFrom) : p;
      const model = source?.data.model ? { url: projectAsset(source, source.data.model), up: p.data.modelUp ?? source.data.modelUp ?? 'y', rotation: p.data.modelRotation ?? source.data.modelRotation ?? [0, 0, 0] } : null;
      return {
        entry: p,
        slug: slugOf(p.id),
        url: projectUrl(p),
        // numbered in chronological (order) sequence, listed projects only
        no: p.data.listed !== false ? `PRJ-${String(++counter).padStart(2, '0')}` : '',
        year: p.data.year ?? null,
        model,
        modelUrl: model?.url ?? null,
      };
    })
    // numbered oldest first, listed newest first
    .reverse();
}

/** Pages with their own route file, so the Markdown catch-all route skips them. */
export const CUSTOM_ROUTES = new Set(['/', '/about', '/contact']);

export const NAV = [
  { label: 'Home', href: '/' },
  { label: 'Projects', href: '/projects' },
  { label: 'Sesame', href: '/sesame' },
  { label: 'Start here', href: '/start-robotics' },
  { label: 'FCE', href: '/FCE' },
  { label: 'About', href: '/about' },
  { label: 'Work with me', href: '/work-with-me' },
  { label: 'Contact', href: '/contact' },
] as const;
