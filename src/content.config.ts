import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// A project is either `src/content/projects/<slug>/index.md` (with images next to it)
// or a single `src/content/projects/<slug>.md`.
const projects = defineCollection({
  loader: glob({ base: './src/content/projects', pattern: '**/*.md' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      summary: z.string().optional(),
      cover: image().optional(),
      /** Sort position on the home page and projects list. Lower comes first. */
      order: z.number().default(100),
      date: z.coerce.date().optional(),
      tags: z.array(z.string()).default([]),
      /** Override the URL. Defaults to /projects/<slug>. */
      path: z.string().optional(),
      /** model.glb next to index.md (made by `npm run models`). Shown on the home page and in the header. */
      model: z.string().optional(),
      /** Use another project's model.glb (by folder name), e.g. "redhex". */
      modelFrom: z.string().optional(),
      /** Which axis is up in the model file. Fusion 360 exports are usually Z-up. Default y. */
      modelUp: z.enum(['y', 'z']).optional(),
      /** Extra rotation in degrees [x, y, z], applied after modelUp. Turn it so the front faces the label. */
      modelRotation: z.tuple([z.number(), z.number(), z.number()]).optional(),
      /** Also export model-rig.glb with separate parts, for scenes that animate joints. */
      rig: z.boolean().default(false),
      /** Release year, shown next to the project number. */
      year: z.number().optional(),
      /** Extra scale for the model on the home page (1 = fills the cell). */
      modelScale: z.number().default(1),
      /** Home page scene (see src/scripts/effects/). */
      effect: z.enum(['led-mosaic', 'scanner', 'soccer', 'chase', 'playpen', 'arena', 'photos']).optional(),
      /** GitHub repository as owner/name. Shown as a card at the top of the article and in the sidebar. */
      repo: z.string().optional(),
      /** One line under the repository name, e.g. what's in it. */
      repoNote: z.string().optional(),
      links: z.array(z.object({ label: z.string(), url: z.string() })).default([]),
      status: z.enum(['released', 'in-progress', 'archived']).default('released'),
      draft: z.boolean().default(false),
      migratedFrom: z.string().optional(),
    }),
});

const pages = defineCollection({
  loader: glob({ base: './src/content/pages', pattern: '**/*.md' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      path: z.string(),
      summary: z.string().optional(),
      tagline: z.string().optional(),
      cover: image().optional(),
      links: z.array(z.object({ label: z.string(), url: z.string() })).default([]),
      migratedFrom: z.string().optional(),
    }),
});

export const collections = { projects, pages };
