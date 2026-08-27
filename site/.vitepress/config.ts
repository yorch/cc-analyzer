// @ts-nocheck — site has its own VitePress toolchain (site/package.json), not the root tsconfig
import { defineConfig } from "vitepress";
import { fileURLToPath } from "node:url";

const siteUrl = "https://cc-analyzer.brnby.com";
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const pageDescriptions: Record<string, string> = {
  "docs/index.md": "Implementation reference for cc-analyzer architecture, commands, analytics, and integrations.",
  "docs/1-repository-structure.md": "Repository layout, build pipeline, and release workflows for cc-analyzer.",
  "docs/2-core-analysis-engine.md": "How cc-analyzer parses, analyzes, prices, and indexes Claude Code sessions.",
  "docs/3-cli.md": "Command and flag reference for the cc-analyzer CLI.",
  "docs/4-tui.md": "Interactive terminal UI architecture and keybindings reference for cc-analyzer.",
  "docs/5-web-server-and-api.md": "Local web server, API routes, payloads, and trust boundaries for cc-analyzer.",
  "docs/6-web-spa-frontend.md": "React web dashboard views, routing, charts, and export behavior.",
  "docs/7-analytics-and-insights.md": "Portfolio analytics, diagnostics, cost attribution, and chart-series reference.",
  "docs/8-updates-and-distribution.md": "Installers, releases, checksums, self-update, and distribution details.",
  "docs/9-docs-site.md": "VitePress site structure, wiki synchronization, and deployment workflow.",
  "docs/10-recipes.md": "Practical cc-analyzer recipes for sharing, triage, health checks, and weekly reports.",
  "docs/glossary.md": "Definitions for cc-analyzer metrics, costs, events, and implementation terms.",
};

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
  sitemap: { hostname: siteUrl },
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
    ["meta", { property: "og:image", content: `${siteUrl}/screenshots/dashboard.webp` }],
    ["meta", { property: "og:image:width", content: "1600" }],
    ["meta", { property: "og:image:height", content: "2327" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
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

  transformHead({ pageData, title, description }) {
    const route =
      pageData.relativePath === "index.md"
        ? "/"
        : `/${pageData.relativePath.replace(/(?:index)?\.md$/, "")}`;
    const canonical = new URL(route, siteUrl).toString();
    const pageDescription = pageDescriptions[pageData.relativePath] ?? description;
    return [
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
