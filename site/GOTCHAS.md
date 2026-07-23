# Site gotchas

Non-obvious pitfalls hit while building this VitePress 1.6.4 site. The fixes are
already in the codebase and cited below.

## 1. Feature-page icons: use the string form, not `{ svg }`

**Symptom:** Home `features[].icon` set to `{ svg: '<svg…>' }` renders *nothing* —
no icon tile at all, no error.

**Cause:** In VitePress 1.6.4, `VPFeature.vue` treats an **object** icon as an
image and routes it to `VPImage` (which needs `src`). Only a **string** icon is
injected via `v-html`. So `{ svg }` silently produces no output.

**Fix:** Pass the raw SVG markup as a plain string:

```yaml
# ✗ renders nothing
- icon: { svg: '<svg …></svg>' }
# ✓ v-html'd into the icon tile
- icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" …></svg>'
```

Use `stroke="currentColor"` so the icon inherits the color set in
`.vitepress/theme/custom.css` (`.VPFeature .icon svg { color: … }`).
See [`index.md`](./index.md) and [`.vitepress/theme/custom.css`](./.vitepress/theme/custom.css).

## 2. Keep Mermaid out of the initial bundle

**Symptom:** Registering Mermaid through `vitepress-plugin-mermaid` statically
imports the whole parser into VitePress's app entry. The landing page then pays
for hundreds of kilobytes of diagram code despite containing no diagram.

**Cause:** The plugin injects a global `Mermaid` component with a static import.
Rollup can split Mermaid's secondary parsers, but the core still belongs to the
initial application graph.

**Fix:** The Markdown fence rule emits the local `LazyMermaid` component.
`LazyMermaid.vue` dynamically imports `mermaid` only after a diagram mounts,
selects an explicit high-contrast dark or light palette itself, and rerenders
when the theme changes. Both flowchart and sequence-diagram colors are set at
render time; the CSS rules are a defensive layer for renderer-specific SVG
shapes, not the primary source of contrast. The global `darkreader-lock` meta
tag prevents color-rewriting extensions from independently changing SVG fills
and labels after Mermaid renders them.
The large Mermaid chunks remain asynchronous:

```ts
const { default: mermaid } = await import("mermaid");
```

See [`.vitepress/config.ts`](./.vitepress/config.ts) and
[`LazyMermaid.vue`](./.vitepress/theme/components/LazyMermaid.vue).

## 3. `vitepress preview` serves stale chunks after a rebuild

**Symptom:** After running `docs:build` while a `vitepress preview` server is
already running, pages load but nothing hydrates — the console shows 404s for
`app.*.js` / `theme.*.js` and `window.mermaid` is `undefined`. Server-rendered
content (feature icons, prose) still shows, which masks the problem; anything
needing JS (Mermaid, search) is silently dead.

**Cause:** A rebuild produces new content-hashed chunk filenames. The
already-running preview server serves an `index.html` referencing the *new*
hashes while still pointing at stale files, so every JS chunk 404s.

**Fix:** Restart `vitepress preview` after every `docs:build`. When verifying
in a browser, kill and relaunch the preview server, then hard-reload.

```bash
pkill -f "vitepress preview"; bun run docs:build && bun run docs:preview
```

---

_These are documented for contributors; the fixes are already applied in `site/`._
