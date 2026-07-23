#!/usr/bin/env bun
/**
 * Verify internal fragment links against the IDs emitted by VitePress.
 *
 * Running this after `vitepress build` catches both same-page links and links
 * from one rendered page to an anchor on another page.
 */
import { readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", ".vitepress", "dist");
const origin = "https://cc-analyzer.invalid";

async function htmlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory()
        ? htmlFiles(path)
        : Promise.resolve(entry.name.endsWith(".html") ? [path] : []);
    }),
  );
  return nested.flat();
}

function routeForFile(path: string): string {
  const name = relative(distDir, path).split(sep).join("/");
  if (name === "index.html") return "/";
  if (name.endsWith("/index.html")) return `/${name.slice(0, -"index.html".length)}`;
  return `/${name.slice(0, -".html".length)}`;
}

function fileForRoute(pathname: string): string {
  if (pathname === "/") return join(distDir, "index.html");
  if (pathname.endsWith("/")) return join(distDir, pathname, "index.html");
  return join(distDir, `${pathname}.html`);
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    );
}

const files = await htmlFiles(distDir);
const pages = new Map<string, { ids: Set<string>; html: string; route: string }>();

for (const file of files) {
  const html = await Bun.file(file).text();
  const ids = new Set<string>();
  for (const match of html.matchAll(/\s(?:id|name)="([^"]+)"/g)) {
    ids.add(decodeHtml(match[1]));
  }
  pages.set(file, { ids, html, route: routeForFile(file) });
}

const failures: string[] = [];
let checked = 0;

for (const page of pages.values()) {
  for (const match of page.html.matchAll(/\shref="([^"]*#[^"]*)"/g)) {
    const href = decodeHtml(match[1]);
    const url = new URL(href, `${origin}${page.route}`);
    if (url.origin !== origin || !url.hash) continue;

    checked++;
    const targetFile = fileForRoute(url.pathname);
    const target = pages.get(targetFile);
    const anchor = decodeURIComponent(url.hash.slice(1));

    if (!target) {
      failures.push(`${page.route}: ${href} points to a missing page`);
    } else if (!target.ids.has(anchor)) {
      failures.push(`${page.route}: ${href} has no matching id="${anchor}"`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Found ${failures.length} broken internal anchor(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Checked ${checked} internal anchors across ${files.length} rendered pages.`);
