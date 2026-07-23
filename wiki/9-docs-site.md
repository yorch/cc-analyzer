# Docs Site

> Indexed at commit `51ccd4e` on 2026-07-23 · [view on GitHub](https://github.com/yorch/cc-analyzer/tree/51ccd4e)

## Relevant source files

- [site/.vitepress/config.ts](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/config.ts)
- [site/index.md](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/index.md)
- [site/.vitepress/theme/index.ts](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/theme/index.ts)
- [site/.vitepress/theme/Layout.vue](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/theme/Layout.vue)
- [site/.vitepress/theme/custom.css](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/theme/custom.css)
- [site/.vitepress/theme/components/TerminalHero.vue](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/theme/components/TerminalHero.vue)
- [site/.vitepress/theme/components/TerminalModules.vue](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/theme/components/TerminalModules.vue)
- [site/.vitepress/theme/components/CommandDeck.vue](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/theme/components/CommandDeck.vue)
- `site/.vitepress/theme/components/ProductPreview.vue`
- `site/.vitepress/theme/components/LazyMermaid.vue`
- [site/scripts/sync-wiki.ts](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/scripts/sync-wiki.ts)
- [site/scripts/gen-fixtures.ts](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/scripts/gen-fixtures.ts)
- [site/README.md](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/README.md)
- [site/GOTCHAS.md](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/GOTCHAS.md)
- [site/package.json](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/package.json)
- [.github/workflows/deploy-site.yml](https://github.com/yorch/cc-analyzer/blob/51ccd4e/.github/workflows/deploy-site.yml)

## Overview

The Docs Site is the project's public GitHub Pages presence at `https://cc-analyzer.brnby.com/` (a custom domain): a custom landing page plus the full wiki rendered as browsable documentation. It is built with VitePress and lives entirely under `site/`, which is a **self-contained toolchain** with its own `package.json` and `bun.lock` so that VitePress's Vite does not collide with the web SPA's Vite in the repository root ([site/README.md:L5-L7](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/README.md#L5-L7)).

The site has two content sources. The landing page (`site/index.md`) is hand-authored and rendered by custom Vue components in an amber-phosphor retro-terminal theme, including a privacy-safe dashboard preview. The `/docs/` section is **generated** — a build-time script copies the canonical wiki from the repository's `/wiki` directory into `site/docs/`, applying filename and link transforms so the pages route cleanly in VitePress ([site/scripts/sync-wiki.ts:L2-L12](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/scripts/sync-wiki.ts#L2-L12)). The whole site deploys to GitHub Pages via a dedicated workflow that fires on pushes touching `site/**` or `wiki/**` ([.github/workflows/deploy-site.yml:L3-L10](https://github.com/yorch/cc-analyzer/blob/51ccd4e/.github/workflows/deploy-site.yml#L3-L10)).

Sources: [site/README.md:L1-L51](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/README.md#L1-L51) [site/package.json:L1-L18](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/package.json#L1-L18)

## Architecture

```mermaid
flowchart LR
    Wiki[(wiki/ canonical)] --> Sync[sync-wiki.ts]
    Sync --> Docs[site/docs/]
    Landing[site/index.md] --> Build
    Docs --> Build[vitepress build]
    Build --> Dist[site/.vitepress/dist]
    Dist --> Pages[GitHub Pages]

    Theme[.vitepress/theme] -.enhanceApp.-> Landing
    Config[.vitepress/config.ts] -.sidebar+nav.-> Build
    Fixtures[gen-fixtures.ts] -.synthetic ~/.claude.-> Shots[public/screenshots]
```

Content flows in one direction. `sync-wiki.ts` reads the wiki, transforms it into `site/docs/`, and VitePress bundles that alongside the hand-authored landing page into a static `dist/` that `deploy-site.yml` uploads to Pages ([site/package.json:L7-L11](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/package.json#L7-L11), [.github/workflows/deploy-site.yml:L38-L45](https://github.com/yorch/cc-analyzer/blob/51ccd4e/.github/workflows/deploy-site.yml#L38-L45)). The theme layer and the hand-defined sidebar in `config.ts` shape presentation; `gen-fixtures.ts` is an offline aid that produces a synthetic dataset for privacy-safe screenshots and never participates in the build.

Sources: [site/scripts/sync-wiki.ts:L13-L54](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/scripts/sync-wiki.ts#L13-L54) [site/package.json:L6-L11](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/package.json#L6-L11) [.github/workflows/deploy-site.yml:L22-L46](https://github.com/yorch/cc-analyzer/blob/51ccd4e/.github/workflows/deploy-site.yml#L22-L46)

## Module Layout

| Module | Path | Responsibility |
| ------ | ---- | -------------- |
| VitePress config | [site/.vitepress/config.ts](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/config.ts) | Metadata, sitemap, lazy Mermaid fence transform, nav/sidebar, and source edit-link mapping |
| Landing page | [site/index.md](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/index.md) | Composes the terminal components, product preview, and closing calls-to-action |
| Theme entry | [site/.vitepress/theme/index.ts](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/theme/index.ts) | Extends the default theme, registers components, imports fonts and CSS |
| Layout override | [site/.vitepress/theme/Layout.vue](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/theme/Layout.vue) | Injects the decorative CRT scanline overlay above the default layout |
| Theme CSS | [site/.vitepress/theme/custom.css](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/theme/custom.css) | Amber-phosphor design tokens and dark/light palettes |
| Landing components | [site/.vitepress/theme/components/](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/theme/components/CommandDeck.vue) | `TerminalHero`, `TerminalModules`, `ProductPreview`, `CommandDeck` |
| Diagram renderer | `site/.vitepress/theme/components/LazyMermaid.vue` | Dynamically imports Mermaid only on pages containing diagrams |
| Analytics loader | `site/public/analytics.js` | Honors DNT and the Plausible localStorage opt-out before initializing the site-specific `pa-*` tracker |
| Wiki sync | [site/scripts/sync-wiki.ts](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/scripts/sync-wiki.ts) | Copies `/wiki` → `site/docs/` with filename and link rewrites |
| Fixture generator | [site/scripts/gen-fixtures.ts](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/scripts/gen-fixtures.ts) | Builds a deterministic synthetic `~/.claude` dataset for screenshots |
| Deploy workflow | [.github/workflows/deploy-site.yml](https://github.com/yorch/cc-analyzer/blob/51ccd4e/.github/workflows/deploy-site.yml) | Builds and publishes to GitHub Pages on relevant pushes |

Sources: [site/.vitepress/config.ts:L1-L98](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/config.ts#L1-L98) [site/.vitepress/theme/index.ts:L1-L23](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/theme/index.ts#L1-L23)

## Key Components

### Wiki sync bridge

`sync-wiki.ts` enforces the single-source-of-truth rule: the wiki under `/wiki` is canonical, and `site/docs/` is a generated, git-ignored copy that must never be edited directly ([site/README.md:L24-L31](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/README.md#L24-L31)). The script clears `site/docs/`, then copies every `.md` file except `_meta.json` and `_SIDEBAR.md`, applying two transforms via `targetName()`: `README.md` becomes `index.md` (the docs-section home), and dotted prefixes like `2.1-` become `2-1-` because dots make fragile VitePress routes ([site/scripts/sync-wiki.ts:L21-L29](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/scripts/sync-wiki.ts#L21-L29)). `rewriteLinks()` correspondingly rewrites intra-wiki relative links — `./README.md` → `./index.md` and `./2.1-` → `./2-1-` — while leaving the DeepWiki page headers and absolute GitHub citation URLs intact ([site/scripts/sync-wiki.ts:L31-L49](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/scripts/sync-wiki.ts#L31-L49)). It throws if the wiki directory contains no pages, failing the build loudly rather than deploying an empty docs section ([site/scripts/sync-wiki.ts:L40-L41](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/scripts/sync-wiki.ts#L40-L41)).

Sources: [site/scripts/sync-wiki.ts:L1-L54](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/scripts/sync-wiki.ts#L1-L54) [site/README.md:L22-L31](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/README.md#L22-L31)

### VitePress configuration and hand-defined sidebar

`config.ts` uses the root custom-domain base path and forces `appearance: "dark"` since the amber CRT is the intended default with the light "print-out" theme one toggle away. Its Markdown fence rule emits `LazyMermaid`, whose dynamic import keeps Mermaid out of pages without diagrams. The config also emits canonical and social metadata plus a sitemap, excludes contributor-only Markdown from the public build, and maps generated docs paths back to canonical wiki files for working edit links. The docs sidebar remains **defined by hand** under the `/docs/` key, so regenerating the wiki with a different set of pages still requires updating that array to match.

Sources: [site/.vitepress/config.ts:L1-L98](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/config.ts#L1-L98) [site/README.md:L30-L31](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/README.md#L30-L31)

### Landing page and terminal theme

`site/index.md` uses the `page` layout with a `cc-landing` class and composes the hero, capability modules, generated TUI previews, real dashboard preview, quick-start deck, and closing calls-to-action. Those components are registered globally in the theme entry, which extends `DefaultTheme`, supplies the custom `Layout`, imports only the required Latin IBM Plex Mono font subsets, and loads `custom.css`. `Layout.vue` wraps the default layout and injects a purely decorative full-viewport CRT overlay — scanlines, vignette, and flicker — through the `#layout-top` slot with pointer events disabled ([site/.vitepress/theme/Layout.vue:L7-L15](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/theme/Layout.vue#L7-L15)).

The visual identity is an "amber phosphor" CRT: amber monochrome on near-black in dark mode and a warm amber-ink-on-cream "print-out" in light mode, defined as CSS custom properties in `custom.css` ([site/.vitepress/theme/custom.css:L1-L67](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/theme/custom.css#L1-L67)). Because the site owns both palettes, `config.ts` emits `darkreader-lock` to prevent color-rewriting extensions from independently changing Mermaid fills and labels. `TerminalHero.vue` renders a wordmark, tagline, and animated terminal whose `cc-analyzer stats` excerpt mirrors the current CLI report hierarchy. `TerminalModules.vue` presents the six product capabilities as loadable "modules" with inline line-SVG icons so no external asset requests are made. `TuiPreview.vue` displays the Portfolio and Trends SVG frames generated from the real Ink application, and `CommandDeck.vue` scripts a three-step quick-start session whose summary line matches the fixture-backed stats output.

Sources: [site/index.md:L1-L22](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/index.md#L1-L22) [site/.vitepress/theme/components/TerminalHero.vue:L1-L67](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/theme/components/TerminalHero.vue#L1-L67) [site/.vitepress/theme/components/TerminalModules.vue:L1-L65](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/theme/components/TerminalModules.vue#L1-L65) [site/.vitepress/theme/components/CommandDeck.vue:L1-L52](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/theme/components/CommandDeck.vue#L1-L52) [site/.vitepress/theme/custom.css:L1-L67](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/theme/custom.css#L1-L67)

### Fixture generator for screenshots

`gen-fixtures.ts` builds a synthetic `~/.claude`-shaped dataset so every product preview uses fabricated sessions rather than real user data ([site/scripts/gen-fixtures.ts:L2-L10](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/scripts/gen-fixtures.ts#L2-L10)). It uses a seeded `mulberry32` pseudo-random number generator (PRNG) so regeneration produces identical numbers and stable screenshots ([site/scripts/gen-fixtures.ts:L19-L29](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/scripts/gen-fixtures.ts#L19-L29)). The dashboard's lossless PNG is converted to an approximately 80 KB WebP for the lazy-loaded preview. `scripts/gen-site-tui-snapshots.tsx` renders the same indexed fixture through the real Ink `App`, navigates to Portfolio and Trends, and serializes those frames as committed SVG assets. All screenshot-generation commands explicitly disable telemetry.

Sources: [site/scripts/gen-fixtures.ts:L1-L190](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/scripts/gen-fixtures.ts#L1-L190) [site/README.md:L34-L45](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/README.md#L34-L45)

## Build & Deploy

The build is orchestrated by npm scripts in `site/package.json`: `sync` runs `sync-wiki.ts`, and both `docs:dev` and `docs:build` run `sync` first so the docs section is always freshly regenerated before VitePress starts ([site/package.json:L6-L11](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/package.json#L6-L11)). `deploy-site.yml` runs on pushes to `main` that touch `site/**`, `wiki/**`, or the workflow file, plus manual `workflow_dispatch` ([.github/workflows/deploy-site.yml:L3-L10](https://github.com/yorch/cc-analyzer/blob/51ccd4e/.github/workflows/deploy-site.yml#L3-L10)). The `build` job runs from the `site` working directory, sets up Bun 1.3.14, installs with a frozen lockfile, runs `docs:build`, and uploads `site/.vitepress/dist` as the Pages artifact ([.github/workflows/deploy-site.yml:L23-L45](https://github.com/yorch/cc-analyzer/blob/51ccd4e/.github/workflows/deploy-site.yml#L23-L45)). A separate `deploy` job then publishes via `actions/deploy-pages`, gated behind a `pages` concurrency group that never cancels an in-progress run ([.github/workflows/deploy-site.yml:L17-L55](https://github.com/yorch/cc-analyzer/blob/51ccd4e/.github/workflows/deploy-site.yml#L17-L55)). The site nav also exposes an Install page describing the one-line installer and prebuilt binaries; the installer scripts themselves live in `site/public/` and are covered by the Updates & Distribution page ([site/.vitepress/config.ts:L41-L45](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/config.ts#L41-L45)).

Sources: [.github/workflows/deploy-site.yml:L1-L55](https://github.com/yorch/cc-analyzer/blob/51ccd4e/.github/workflows/deploy-site.yml#L1-L55) [site/package.json:L1-L18](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/package.json#L1-L18)

## Configuration & Extension Points

| Setting | Location | Purpose |
| ------- | -------- | ------- |
| `base` | `site/.vitepress/config.ts` | Root path `/` for the custom domain |
| `appearance` | [config.ts:L13](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/config.ts#L13) | Forces dark (amber CRT) as the default theme |
| Mermaid palette | `LazyMermaid.vue` | Explicit high-contrast light/dark flowchart and sequence palettes selected at render time |
| `sitemap.hostname` | `site/.vitepress/config.ts` | Generates absolute custom-domain sitemap URLs |
| `srcExclude` | `site/.vitepress/config.ts` | Keeps contributor README/GOTCHAS pages out of the public site |
| `sidebar["/docs/"]` | [config.ts:L47-L81](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/config.ts#L47-L81) | Hand-maintained docs page list — update on wiki changes |
| `SKIP` set | [sync-wiki.ts:L22](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/scripts/sync-wiki.ts#L22) | Wiki meta files excluded from the docs copy |
| `CC_ANALYZER_CLAUDE_DIR` | [README.md:L40-L43](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/README.md#L40-L43) | Points the app at the synthetic fixture dataset for screenshots |

`GOTCHAS.md` records three non-obvious VitePress concerns with fixes already applied: icon markup behavior, the need to lazy-load Mermaid to protect the initial bundle, and restarting `vitepress preview` after a build changes content-hashed chunks.

Sources: [site/.vitepress/config.ts:L1-L98](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/.vitepress/config.ts#L1-L98) [site/GOTCHAS.md:L1-L74](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/GOTCHAS.md#L1-L74) [site/scripts/sync-wiki.ts:L22-L22](https://github.com/yorch/cc-analyzer/blob/51ccd4e/site/scripts/sync-wiki.ts#L22)

## Related Pages

- Repository layout: [Repository Structure](./1-repository-structure.md)
- Installer scripts and self-update: [Updates & Distribution](./8-updates-and-distribution.md)
