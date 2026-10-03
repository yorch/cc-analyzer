#!/usr/bin/env bun
/**
 * Inline the landing page's critical CSS and load the rest without blocking.
 *
 * VitePress emits one render-blocking stylesheet (the default theme plus the
 * site's own, ~138 KB raw) that delays first paint on slow links. Beasties
 * inlines only the rules the landing page's first paint needs and defers the
 * remaining stylesheet (`media="print"` swap, with a <noscript> fallback).
 *
 * Only index.html is rewritten: the docs pages render very different markup
 * and keep VitePress's own loading, so a mistake here cannot blank them.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Beasties from "beasties";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", ".vitepress", "dist");
const page = join(distDir, "index.html");

const beasties = new Beasties({
  path: distDir,
  publicPath: "/",
  preload: "media",
  noscriptFallback: true,
  pruneSource: false,
  inlineFonts: false,
  logLevel: "warn",
});

const html = await Bun.file(page).text();
// VitePress writes `rel="preload stylesheet" as="style"`, which Beasties does not
// treat as a stylesheet; normalize to a plain one so it can be inlined/deferred.
const normalized = html.replace(
  /<link rel="preload stylesheet" href="([^"]+\.css)" as="style">/g,
  '<link rel="stylesheet" href="$1">',
);
if (normalized === html) throw new Error("inline-critical-css: no stylesheet links found");
const out = await beasties.process(normalized);
if (out === html) throw new Error("inline-critical-css: index.html was not changed");
await Bun.write(page, out);
console.log(`Inlined critical CSS into index.html (${html.length} -> ${out.length} bytes)`);
