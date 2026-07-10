# cc-analyzer — GitHub Pages Site Design

_Date: 2026-07-10 · Status: approved for planning_

## Goal

Build a static website for `cc-analyzer`, hosted on GitHub Pages, combining a
polished marketing **landing page** with the full browsable **wiki** (the 12
DeepWiki-style pages under `/wiki`). The site lives at
`https://yorch.github.io/cc-analyzer/`.

## Decisions (locked)

| Question | Decision |
| --- | --- |
| Scope | Landing page **+** full docs (wiki) in one cohesive site |
| Generator | **VitePress** (Vite-based, matches stack, Markdown + Mermaid, hero home + docs theme) |
| Wiki source of truth | `/wiki/` stays canonical; synced into the site at build time |
| Screenshots | Real UI, captured against **synthetic** data (no private `~/.claude` exposure) |
| Deploy | GitHub Actions → `actions/deploy-pages` on push to `main` |

## Architecture

A new **`site/`** VitePress project at the repo root, kept separate from `src/`
(app), `web/` (the SPA), and `docs/` (design specs).

```
site/
├── package.json            # isolated toolchain: vitepress + mermaid plugin
├── bun.lock                # committed; used by the deploy workflow
├── .vitepress/
│   └── config.ts           # title, base:'/cc-analyzer/', nav, sidebar, Mermaid, local search
├── index.md                # landing page (VitePress "home" layout)
├── docs/                   # GENERATED from /wiki by sync-wiki.ts — not hand-edited
│   ├── index.md            # ← wiki/README.md
│   ├── 1-repository-structure.md
│   ├── 2-core-analysis-engine.md
│   ├── 2-1-session-parsing-and-events.md   # dotted names normalized
│   ├── 2-2-cost-and-pricing.md
│   ├── 2-3-index-and-analytics.md
│   ├── 3-cli.md · 4-tui.md · 5-web-server-and-api.md · 6-web-spa-frontend.md
│   └── glossary.md
├── public/
│   └── screenshots/        # committed images captured from synthetic-data runs
└── scripts/
    ├── sync-wiki.ts        # /wiki/*.md → site/docs/ with transforms
    └── gen-fixtures.ts     # builds a synthetic ~/.claude dataset
```

### Toolchain isolation

VitePress 1.x depends on Vite 5; the SPA (`web/`) uses Vite 8 via the root
`package.json`. To avoid a version conflict, `site/` gets its **own**
`package.json` + `bun.lock`. Root scripts and CI are untouched by the docs build.

`site/package.json` scripts:

- `sync` — run `scripts/sync-wiki.ts`
- `docs:dev` — `sync` then `vitepress dev`
- `docs:build` — `sync` then `vitepress build`
- `docs:preview` — `vitepress preview`

## Component 1 — Wiki sync (`sync-wiki.ts`)

A Bun script, the single bridge between canonical `/wiki` and the site. It is
idempotent: it clears `site/docs/` and regenerates it from `/wiki` each run.

Transforms applied while copying `wiki/*.md` → `site/docs/`:

1. `README.md` → `index.md` (docs home).
2. Dotted filenames (`2.1-…`) → dashed (`2-1-…`). Dotted segments make fragile
   VitePress routes; normalize them.
3. Rewrite intra-wiki links to match (1) and (2): `./2.1-x.md` → `./2-1-x.md`,
   `./README.md` → `./` (or `index`). Only relative `./*.md` links are touched.
4. Leave the DeepWiki page headers, "Relevant source files" blocks, and the
   absolute GitHub citation URLs intact — the citations become live "view
   source" links, which is desirable.

`_meta.json` and `_SIDEBAR.md` are **not** copied (site nav is defined in
`config.ts`).

## Component 2 — VitePress config (`.vitepress/config.ts`)

- `base: '/cc-analyzer/'` (project Pages path).
- `title: 'cc-analyzer'`, description from the README.
- Wrapped with `withMermaid(...)` from `vitepress-plugin-mermaid` so the wiki's
  Mermaid fences render client-side. Deps: `vitepress`, `vitepress-plugin-mermaid`,
  `mermaid`.
- `themeConfig.nav`: Home (`/`), Docs (`/docs/`), external GitHub link.
- `themeConfig.sidebar` for `/docs/`: a hand-defined tree mirroring `_SIDEBAR.md`
  (12 stable pages; hierarchy with 2.x nested under 2). Rationale: the page set
  is stable; a hand-defined sidebar is simpler and more robust than parsing
  Markdown nav. If the wiki is regenerated with a different page set, the sidebar
  is updated by hand (noted in `site/README` note).
- `themeConfig.search: { provider: 'local' }` — VitePress built-in local search.
- `socialLinks` → GitHub.

## Component 3 — Landing page (`index.md`)

VitePress `layout: home` front-matter:

- **Hero**: name, tagline ("Analyze your Claude Code sessions — cost, tokens,
  tools, and per-turn breakdowns"), actions: **Get Started** → `/docs/`,
  **View on GitHub**.
- **Features grid** (6): Interactive TUI · Local web app · Real cost & cache
  accounting · Incremental SQLite index · Single-binary distribution ·
  Read-only & private.
- Below the hero: an install/usage terminal code block (`bun install`,
  `cc-analyzer index`, `cc-analyzer stats`, `cc-analyzer serve`) and a real
  screenshot of the web dashboard.

## Component 4 — Synthetic data & screenshots

`gen-fixtures.ts` builds a throwaway `~/.claude`-shaped dataset under a temp dir
(`site/.tmp/claude/`, git-ignored): 2–3 fake projects, several sessions each,
with realistic JSONL events (user prompts; assistant events carrying `usage`
token counts, `tool_use` blocks for Bash/Edit/Read; `tool_result` carriers) and
plausible models (`claude-opus-4-*`, `claude-sonnet-*`). Enough spread that
`stats` and the dashboard show meaningful numbers.

Capture procedure (manual, one-time; images are committed):

1. `gen-fixtures.ts` writes the synthetic dataset.
2. Run the app with `CC_ANALYZER_CLAUDE_DIR` and `CC_ANALYZER_STATE_DIR` pointed
   at the temp dirs: `index`, then `serve --port=<p>`.
3. Capture the web dashboard (and a session view) via browser automation →
   `site/public/screenshots/`.
4. The TUI is not reliably automatable headlessly; a TUI shot is optional and
   deferred (web dashboard is the hero image).

Screenshots are static assets; the deploy workflow does **not** regenerate them.

## Component 5 — Deploy pipeline (`.github/workflows/deploy-site.yml`)

- Trigger: `push` to `main` on paths `site/**`, `wiki/**`, and the workflow file;
  plus `workflow_dispatch`.
- Permissions: `pages: write`, `id-token: write`, `contents: read`.
- `concurrency: { group: pages, cancel-in-progress: false }`.
- Steps: checkout → `oven-sh/setup-bun` → `bun install --frozen-lockfile`
  (cwd `site/`) → `bun run docs:build` (cwd `site/`) →
  `actions/configure-pages` → `actions/upload-pages-artifact` (path
  `site/.vitepress/dist`) → `actions/deploy-pages`.
- Pages source set to "GitHub Actions" (enabled once via `gh api`).

The existing `ci.yml` and `release.yml` are unchanged.

## Out of scope (YAGNI)

- No custom domain (uses the default `github.io` path).
- No versioned docs / i18n.
- No auto-regenerated screenshots in CI.
- No changes to the app itself (`src/`, `web/`); the site only consumes it.

## Verification / success criteria

1. `bun run docs:build` (in `site/`) completes with no errors.
2. Local `docs:preview` renders: landing hero, feature grid, screenshot, and the
   docs section with working sidebar nav and local search.
3. Every Mermaid diagram from the wiki renders as SVG (not raw code).
4. Internal doc links resolve under the `/cc-analyzer/` base; GitHub citation
   links resolve to source at the pinned SHA.
5. The deploy workflow runs green and the site is reachable at
   `https://yorch.github.io/cc-analyzer/`.

## Risks / notes

- **Dotted routes**: mitigated by filename normalization in `sync-wiki.ts`;
  verify links post-sync.
- **Base path**: a wrong `base` yields broken asset URLs on Pages; covered by the
  local build check and the post-deploy smoke test.
- **Sidebar drift**: hand-defined sidebar must be updated if the wiki page set
  changes (documented in a short `site/README`).
