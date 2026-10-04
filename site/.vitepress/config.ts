// @ts-nocheck — site has its own VitePress toolchain (site/package.json), not the root tsconfig
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

const siteUrl = "https://cc-analyzer.brnby.com";
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const pageDescriptions: Record<string, string> = {
  "docs/index.md":
    "Implementation reference for cc-analyzer: architecture, core analysis engine, CLI, terminal UI, web app, analytics, and distribution internals.",
  "docs/1-repository-structure.md":
    "Repository layout of cc-analyzer: source tree, build pipeline, the compiled single binary, tests, and the Changeset-driven release workflows.",
  "docs/2-core-analysis-engine.md":
    "How cc-analyzer parses, analyzes, prices, and indexes Claude Code sessions: the shared core behind the CLI, terminal UI, and web dashboard.",
  "docs/2-1-session-parsing-and-events.md":
    "How cc-analyzer parses Claude Code session JSONL: the event model, tolerant schemas, parse coverage, streaming, and subagent session trees.",
  "docs/2-2-cost-and-pricing.md":
    "How cc-analyzer prices Claude Code sessions from tokens: per-model rates, cache write and read costs, long-context tiers, and why cost is a floor.",
  "docs/2-3-index-and-analytics.md":
    "How cc-analyzer indexes sessions into SQLite and rolls them up: incremental scans, schema versions, cross-file de-duplication, and portfolio analytics.",
  "docs/2-4-per-turn-steps.md":
    "How cc-analyzer builds the per-turn step timeline for a Claude Code session: turn segmentation, tool calls, retries, and step attribution.",
  "docs/3-cli.md":
    "Command and flag reference for the cc-analyzer CLI: index, stats, analyze, doctor, report, insights, export, serve, and archive commands.",
  "docs/4-tui.md":
    "Architecture and keybindings of the cc-analyzer interactive terminal UI: portfolio, projects, sessions, charts, trends, and insights screens.",
  "docs/5-web-server-and-api.md":
    "cc-analyzer's local web server and API: Hono routes, payload shapes, the loopback Host guard, write routes, and trust boundaries.",
  "docs/6-web-spa-frontend.md":
    "The cc-analyzer React web dashboard: views, routing, shared chart components, themes, exports, and how the SPA is embedded in the binary.",
  "docs/7-analytics-and-insights.md":
    "Portfolio analytics and insights in cc-analyzer: cost attribution, cache efficiency, diagnostic rules, what-if repricing, and chart series.",
  "docs/8-updates-and-distribution.md":
    "How cc-analyzer is installed and updated: installers, release binaries, SHA256 checksums, build provenance, self-update, and version checks.",
  "docs/9-docs-site.md":
    "How the cc-analyzer docs site is built: VitePress structure, wiki synchronization, synthetic screenshot fixtures, and GitHub Pages deployment.",
  "docs/10-recipes.md":
    "Practical cc-analyzer recipes: share a session safely, triage an expensive one, run health checks, and build a weekly Claude Code spend report.",
  "docs/glossary.md":
    "Glossary of cc-analyzer and Claude Code terms: turns, sidechains, compactions, cache tiers, context tax, and the cost and metric definitions.",
};

// Keyword-bearing <title>s for the wiki-generated docs pages, whose own H1s are
// terse section names. VitePress appends " | cc-analyzer", so keep each ≤ 46
// characters. Guide/install titles live in their own frontmatter.
const pageTitles: Record<string, string> = {
  "docs/index.md": "Implementation reference",
  "docs/1-repository-structure.md": "Repository structure & build pipeline",
  "docs/2-core-analysis-engine.md": "Core analysis engine",
  "docs/2-1-session-parsing-and-events.md": "Claude Code session parsing & event model",
  "docs/2-2-cost-and-pricing.md": "Claude Code cost & pricing model",
  "docs/2-3-index-and-analytics.md": "SQLite index & portfolio aggregation",
  "docs/2-4-per-turn-steps.md": "Per-turn tool & step timeline",
  "docs/3-cli.md": "CLI command reference",
  "docs/4-tui.md": "Interactive terminal UI reference",
  "docs/5-web-server-and-api.md": "Local web server & API reference",
  "docs/6-web-spa-frontend.md": "Web dashboard (React SPA) frontend",
  "docs/7-analytics-and-insights.md": "Analytics, insights & diagnostics",
  "docs/8-updates-and-distribution.md": "Installers, updates & distribution",
  "docs/9-docs-site.md": "Docs site architecture",
  "docs/10-recipes.md": "Recipes: share, triage & weekly reports",
  "docs/glossary.md": "Glossary of metrics & terms",
};

/** The wiki source behind a generated docs page (mirrors sync-wiki.ts renaming). */
function wikiSource(relativePath: string): string | undefined {
  if (!relativePath.startsWith("docs/")) return undefined;
  const name = relativePath.slice("docs/".length);
  return `wiki/${name === "index.md" ? "README.md" : name.replace(/^(\d+)-(\d+)-/, "$1.$2-")}`;
}

/**
 * ISO date of the last commit touching a repo file, for generated pages that
 * have no git history of their own under site/docs/. Needs full history in CI
 * (deploy-site.yml checks out with fetch-depth: 0).
 */
function lastCommitDate(repoPath: string): string | undefined {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", repoPath], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Breadcrumb trail (name, path) for a page, or undefined for the landing page. */
function breadcrumbs(relativePath: string, title: string): [string, string][] | undefined {
  if (relativePath === "index.md") return undefined;
  const route = `/${relativePath.replace(/(?:index)?\.md$/, "")}`;
  const trail: [string, string][] = [["Home", "/"]];
  if (relativePath.startsWith("docs/")) {
    trail.push(["Reference", "/docs/"]);
  } else if (relativePath.startsWith("guide/")) {
    trail.push(["Get started", "/guide/"]);
  }
  if (trail[trail.length - 1][1] !== route) trail.push([title, route]);
  return trail;
}

// Landing-page structured data (SoftwareApplication). Emitted only on "/".
const softwareApplicationSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "cc-analyzer",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Linux, Windows",
  description:
    "Read-only CLI to browse and analyze Claude Code sessions: cost, tokens, tools, skills, models, and per-turn breakdowns.",
  url: siteUrl,
  downloadUrl: "https://github.com/yorch/cc-analyzer/releases/latest",
  sameAs: ["https://github.com/yorch/cc-analyzer"],
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

/** TechArticle + BreadcrumbList JSON-LD for every non-landing page. */
function articleSchemas(pageData, title: string, description: string, canonical: string) {
  const trail = breadcrumbs(pageData.relativePath, title);
  if (!trail) return [];
  const source = wikiSource(pageData.relativePath);
  const modified =
    (source && lastCommitDate(source)) ||
    (pageData.lastUpdated ? new Date(pageData.lastUpdated).toISOString() : undefined);
  return [
    {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: title,
      description,
      url: canonical,
      inLanguage: "en-US",
      isPartOf: { "@type": "WebSite", name: "cc-analyzer", url: siteUrl },
      ...(modified ? { dateModified: modified } : {}),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: trail.map(([name, path], index) => ({
        "@type": "ListItem",
        position: index + 1,
        name,
        item: new URL(path, siteUrl).toString(),
      })),
    },
  ];
}

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "cc-analyzer",
  description:
    "Read-only CLI to browse and analyze Claude Code sessions in ~/.claude — cost, tokens, tools, skills, models, and per-turn breakdowns.",
  base: "/",
  lang: "en-US",
  lastUpdated: true,
  cleanUrls: true,
  srcExclude: ["README.md", "GOTCHAS.md"],
  sitemap: {
    hostname: siteUrl,
    // Generated docs pages have no git history under site/docs/, so VitePress
    // emits no <lastmod> for them. Take it from the wiki source instead.
    transformItems(items) {
      return items.map((item) => {
        if (item.lastmod) return item;
        const page = item.url.endsWith("/") ? `${item.url}index.md` : `${item.url}.md`;
        const source = wikiSource(page);
        const date = source && lastCommitDate(source);
        return date ? { ...item, lastmod: Date.parse(date) } : item;
      });
    },
  },
  // The whole aesthetic is an amber-phosphor CRT; dark is the intended default,
  // with the light "print-out" theme still one toggle away.
  appearance: "dark",

  head: [
    ["link", { rel: "icon", href: "/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#0b0c0a" }],
    ["meta", { name: "robots", content: "index, follow" }],
    // The site owns complete light/dark palettes. Prevent color-rewriting
    // extensions from turning Mermaid node fills light while labels stay light.
    ["meta", { name: "darkreader-lock" }],
    ["meta", { property: "og:site_name", content: "cc-analyzer" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:image", content: `${siteUrl}/screenshots/og-dashboard.jpg` }],
    ["meta", { property: "og:image:alt", content: "cc-analyzer web dashboard with portfolio totals and project activity" }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image:alt", content: "cc-analyzer web dashboard with portfolio totals and project activity" }],
    // Local loader checks browser DNT and Plausible's localStorage opt-out before
    // requesting the self-hosted, cookieless analytics script.
    ["script", { defer: "", src: "/analytics.js" }],
  ],

  markdown: {
    theme: {
      light: "github-light-high-contrast",
      dark: "github-dark",
    },
    config(md) {
      const fallback = md.renderer.rules.fence?.bind(md.renderer.rules);
      md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const token = tokens[index];
        if (token.info.trim() === "mermaid") {
          return `<LazyMermaid id="mermaid-${index}" graph="${encodeURIComponent(token.content)}" />`;
        }
        return fallback?.(tokens, index, options, env, self) ?? "";
      };
    },
  },

  // VitePress preloads Inter's latin roman face for every page, but the theme
  // overrides both font-family tokens with IBM Plex Mono, so that 67 KB file is
  // never used and only competes with the render-blocking CSS on slow links.
  transformHtml(code) {
    return code.replace(/<link rel="preload" href="[^"]*inter-roman-latin[^"]*" as="font"[^>]*>\s*/, "");
  },

  transformPageData(pageData) {
    const title = pageTitles[pageData.relativePath];
    if (title) pageData.title = title;
  },

  transformHead({ pageData, title, description }) {
    const isHome = pageData.relativePath === "index.md";
    const route =
      pageData.relativePath === "index.md"
        ? "/"
        : `/${pageData.relativePath.replace(/(?:index)?\.md$/, "")}`;
    const canonical = new URL(route, siteUrl).toString();
    const pageDescription = pageDescriptions[pageData.relativePath] ?? description;
    return [
      ...(isHome
        ? [["script", { type: "application/ld+json" }, JSON.stringify(softwareApplicationSchema)]]
        : articleSchemas(pageData, pageData.title || title, pageDescription, canonical).map((schema) => [
            "script",
            { type: "application/ld+json" },
            JSON.stringify(schema),
          ])),
      ["link", { rel: "canonical", href: canonical }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { name: "description", content: pageDescription }],
      ["meta", { property: "og:description", content: pageDescription }],
      ["meta", { property: "og:url", content: canonical }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: pageDescription }],
    ];
  },

  vite: {
    server: {
      // Bun may hoist the site's font package to the repository root. Vite's
      // dev allow-list otherwise rejects those files even though builds work.
      fs: { allow: [repositoryRoot] },
    },
    build: {
      // Mermaid is loaded only when a diagram mounts. Its parser remains a
      // large isolated async chunk, not part of the initial page payload.
      chunkSizeWarningLimit: 700,
    },
  },

  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Install", link: "/install" },
      { text: "Get started", link: "/guide/" },
      { text: "How-to guides", link: "/guide/workflows" },
      { text: "Reference", link: "/docs/" },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Get started",
          items: [
            { text: "Overview", link: "/guide/" },
            { text: "Workflows", link: "/guide/workflows" },
            { text: "Archive across computers", link: "/guide/archive" },
            { text: "Export & share", link: "/guide/export-share" },
            { text: "Troubleshooting", link: "/guide/troubleshooting" },
            { text: "Privacy & security", link: "/guide/privacy" },
            { text: "Recipes & use cases", link: "/docs/10-recipes" },
          ],
        },
      ],
      "/docs/": [
        {
          text: "Implementation reference",
          items: [{ text: "Home", link: "/docs/" }],
        },
        {
          text: "Architecture & internals",
          items: [
            { text: "1. Repository Structure", link: "/docs/1-repository-structure" },
            {
              text: "2. Core Analysis Engine",
              link: "/docs/2-core-analysis-engine",
              collapsed: false,
              items: [
                {
                  text: "2.1 Parsing & Events",
                  link: "/docs/2-1-session-parsing-and-events",
                },
                { text: "2.2 Cost & Pricing", link: "/docs/2-2-cost-and-pricing" },
                { text: "2.3 Index & Aggregation", link: "/docs/2-3-index-and-analytics" },
                { text: "2.4 Per-Turn Steps", link: "/docs/2-4-per-turn-steps" },
              ],
            },
            { text: "3. Command-Line Interface", link: "/docs/3-cli" },
            { text: "4. Interactive Terminal UI", link: "/docs/4-tui" },
            { text: "5. Web Server & API", link: "/docs/5-web-server-and-api" },
            { text: "6. Web SPA Frontend", link: "/docs/6-web-spa-frontend" },
            { text: "7. Analytics & Insights", link: "/docs/7-analytics-and-insights" },
            { text: "8. Updates & Distribution", link: "/docs/8-updates-and-distribution" },
            { text: "9. Docs Site", link: "/docs/9-docs-site" },
            { text: "10. Recipes & Use Cases", link: "/docs/10-recipes" },
            { text: "Glossary", link: "/docs/glossary" },
          ],
        },
      ],
    },

    search: { provider: "local" },

    socialLinks: [{ icon: "github", link: "https://github.com/yorch/cc-analyzer" }],

    editLink: {
      pattern: ({ filePath }) => {
        let sourcePath = filePath;
        if (filePath === "install.md") {
          sourcePath = "site/install.md";
        } else if (filePath.startsWith("docs/")) {
          const name = filePath.slice("docs/".length);
          sourcePath =
            name === "index.md"
              ? "wiki/README.md"
              : `wiki/${name.replace(/^(\d+)-(\d+)-/, "$1.$2-")}`;
        }
        return `https://github.com/yorch/cc-analyzer/edit/main/${sourcePath}`;
      },
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "◍ read-only over Claude transcripts · local by default",
      copyright:
        'Docs generated by <a href="https://github.com/yorch/claude-skills/tree/main/skills/repo-wiki-generator">repo-wiki-generator</a>',
    },
  },
});
