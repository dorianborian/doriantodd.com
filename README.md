# doriantodd.com

Portfolio site for Dorian Todd, styled like a dark-mode CAD workspace. Built with [Astro](https://astro.build),
three.js for the 3D bits, and hosted on GitHub Pages. Content is plain Markdown.

- **Home (`/`)** is a 3D view where every project sits on the top plane as its model, with a sketch-style label.
  Hover to highlight, click to see details, double-click to open.
- **Projects (`/projects`)** is a table of every project, built from front matter.
- **Project pages** use the article's headings as the left-hand outline and a drawing title block as the header.
- **Contact (`/contact`)** is an interactive sketch of the ways to reach you, plus a message dialog that opens the visitor's email app.

## Everyday use

```bash
npm install          # once
npm run dev          # http://localhost:4321, live reload
```

### Write a new project

```bash
npm run new "Robot Arm"
```

That creates `src/content/projects/robot-arm/index.md`. Put images in the same folder and reference them
relatively. Commit and push to `main`; GitHub Actions builds, checks and deploys in about two minutes.

```markdown
---
title: "Robot Arm"
summary: "Shown in the projects list and when the project is selected on the home page."
cover: "./cover.jpg"
tags: ["ESP32", "3D printing"]
links: [{ label: "Source code", url: "https://github.com/dorianborian/robot-arm" }]
status: in-progress
order: 0
---

Intro paragraph.

## Build log

![The first prototype](./prototype.jpg)

https://www.youtube.com/watch?v=VIDEO_ID

![Gripper test](./gripper.mp4)

![Gripper assembly](./gripper.stl)
```

| You write (on its own line) | You get |
|---|---|
| `![caption](./photo.jpg)` | Responsive WebP images, resized at build time |
| `https://www.youtube.com/watch?v=...` | Click-to-play player (no YouTube scripts until clicked) |
| `![caption](./clip.mp4)` | Muted looping video, paused when off screen |
| `![caption](./part.stl)` (also `.glb`, `.gltf`, `.obj`, `.3mf`) | Orbitable 3D viewer, loaded lazily |
| `https://www.desmos.com/calculator/...` | Embedded calculator |
| `[STEP file](./part.step)` | Download link for any file in the folder |
| Two to four images/clips in a row | A grid |
| Five or more images/clips in a row | A swipeable carousel |
| `![Caption text](./photo.jpg)` | The alt text also shows as a caption |

Every article image opens full size when clicked. Put inline code in backticks and longer logs in fenced code blocks.

Front matter `repo: "owner/name"` (plus an optional `repoNote`) adds the standard repository card at the top of the article, a toolbar button and a sidebar link. Diagrams are plain SVG files next to the article, referenced like images.

### 3D models on the home page

Drop a textured model into the project's folder: `name.obj` + `name.mtl` + its texture images (or a
`.glb`/`.gltf`). Then run:

```bash
npm run models
```

It writes two files: `model.glb` (up to 120k triangles, for the project page viewer) and `model-lite.glb`
(about 30 to 120k triangles with tiny parts like screws removed, for the home page). Colours from Fusion 360
exports are converted from sRGB, and named appearances like wood, fabric and clear acrylic get sensible
materials. It sets `model: "./model.glb"` in the front matter and moves the originals to `models-src/`
(not committed). Run `npm run models -- --rebuild` to reconvert everything from `models-src/`.

Orientation, in front matter:

- `modelUp: z` for Z-up files (most Fusion 360 exports).
- `modelRotation: [x, y, z]` in degrees, so the front of the model faces the label (+z).
- `modelFrom: redhex` reuses another project's model (HEX-VISION does this).

### Home page scenes

`effect:` in front matter adds an animated scene to a project's cell. Each lives in `src/scripts/effects/`
and only loads when used:

| Effect | Project | What it does |
|---|---|---|
| `soccer` | Live Robot Soccer | Recoloured mini Sesames play on the field; a crowd cheers goals |
| `chase` | Fridge Tank | Little people chase the fridge, which drives away on its treads |
| `scanner` | HEX-VISION | The hexapod waddles around scanning; detected people panic and fade out |
| `playpen` | Sesame | Sesame inside digital walls, pushing toys, with its real firmware faces |
| `arena` | Combat Robotics | Executioner in a small arena, launching a washing machine |
| `photos` | Full Contact Engineering | Photos from the FCE page burst out and drift |
| `led-mosaic` | LED Digital Mosaic | A glowing 15x15 LED gradient fitted to the tilted panel |

The Sesame faces come from `face-bitmaps.h` in the Sesame firmware, extracted into `public/sesame/faces.png`.
`draft: true` hides a project from the live site but keeps it visible in `npm run dev`.

Big GIFs: drop them in, then run `npm run media`. It converts GIFs over 300 KB to MP4 (typically 10-20x
smaller), rewrites the Markdown, and shrinks PNG/JPEG files over 1.5 MB. Originals go to
`migration/originals/`, which is not committed.

### Other pages

`src/content/pages/*/index.md` holds About, Contact, the Sesame kit page, and the text in the home page's
properties panel. `path:` in front matter is the URL.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server |
| `npm run build` | Build to `dist/` |
| `npm run check` | Verify `dist/`: every old Google Sites URL exists, no broken links or assets, CNAME present. Add `-- --external` to also test outside links |
| `npm run new "Title"` | Scaffold a project |
| `npm run models` | Convert OBJ/glTF files in project folders to web-ready `model.glb` |
| `npm run media` | Convert heavy GIFs/images in `src/content` |
| `node scripts/shot.mjs "?view=sesame&debug&simulate=8" out.png` | Headless screenshot for checking 3D scenes. `view` focuses a project, `simulate` fast-forwards effects, `debug` prints script errors on the page |
| `npm run migrate` | Re-crawl the old Google Site (kept for reference; won't overwrite edited files without `--force`) |

## Layout

```
src/content/projects/<slug>/   project articles + their images, videos, models
src/content/pages/<slug>/      about, contact, home panel text, sesame kit
src/pages/                     routes: index (3D home), projects, contact, [...path] (articles), 404
src/scripts/assembly.ts        home page 3D scene
src/scripts/effects/           per-project home scenes, pictogram crowd, tiny physics
src/scripts/contact-sketch.ts  contact page sketch tools
src/scripts/cad-viewer.ts      <cad-viewer> element for models in articles
src/lib/remark-embeds.mjs      the Markdown conventions above
src/lib/content-assets.mjs     publishes videos/models/files at /content-assets/
src/styles/global.css          all styling; colour tokens at the top
migration/                     Google Sites crawler, raw HTML archive, REPORT.md
docs/CUTOVER.md                moving the domain from Google Sites to GitHub Pages
```
