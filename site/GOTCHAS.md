# Site gotchas

Non-obvious pitfalls hit while building this VitePress site (VitePress 1.6.4,
`vitepress-plugin-mermaid` 2.0.17). Each cost real debugging time; the fixes are
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

## 2. Mermaid dark mode leaks light `themeVariables`

**Symptom:** In dark mode, diagram edge labels render inside little **white
boxes** even though the rest of the diagram is dark.

**Cause:** `vitepress-plugin-mermaid` forces mermaid's built-in `theme: "dark"`
when the `.dark` class is present (`Mermaid.vue`), but it still applies the
`themeVariables` you configured for light mode. A light `edgeLabelBackground`
(and other light fills) therefore bleed into the dark render.

**Fix:** Keep the light `themeVariables` in `.vitepress/config.ts`, but repaint
the affected pieces for dark mode with CSS scoped under `.dark`:

```css
.dark .vp-doc .mermaid .edgeLabel .labelBkg { background: var(--vp-c-bg-alt) !important; }
.dark .vp-doc .mermaid .edgeLabel,
.dark .vp-doc .mermaid .edgeLabel span,
.dark .vp-doc .mermaid .edgeLabel p { background-color: transparent !important; color: var(--vp-c-text-2) !important; }
.dark .vp-doc .mermaid .node rect { stroke: var(--cc-accent) !important; }
```

CSS is the reliable lever in dark mode because the plugin owns the mermaid
`theme`. See [`.vitepress/theme/custom.css`](./.vitepress/theme/custom.css).

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
