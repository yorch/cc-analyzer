#!/usr/bin/env bun
/**
 * Render deterministic landing-page TUI snapshots from the real Ink app.
 *
 * Run after generating/indexing the synthetic site fixture:
 *   CC_ANALYZER_CLAUDE_DIR=site/.tmp/claude \
 *   CC_ANALYZER_STATE_DIR=site/.tmp/state \
 *   bun run scripts/gen-site-tui-snapshots.tsx
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { openDb } from "../src/core/db.ts";
import { loadPricing } from "../src/core/pricing-source.ts";
import { App } from "../src/tui/App.tsx";

const outputDir = join(import.meta.dir, "..", "site", "public", "screenshots");

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function frameToSvg(frame: string, label: string): string {
  const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const lines = frame.replaceAll(ansiColor, "").split("\n");
  const charWidth = 8.4;
  const lineHeight = 17;
  const paddingX = 22;
  const barHeight = 38;
  const width = 100 * charWidth + paddingX * 2;
  const height = barHeight + 20 + lines.length * lineHeight + 18;
  const rows = lines
    .map(
      (line, index) =>
        `<text x="${paddingX}" y="${barHeight + 28 + index * lineHeight}">${escapeXml(line)}</text>`,
    )
    .join("\n    ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(label)}</title>
  <desc id="desc">A snapshot generated from the real cc-analyzer Ink terminal interface.</desc>
  <rect width="100%" height="100%" rx="12" fill="#0b0c0a"/>
  <rect width="100%" height="${barHeight}" rx="12" fill="#15170f"/>
  <rect y="${barHeight - 12}" width="100%" height="12" fill="#15170f"/>
  <line y1="${barHeight}" x2="100%" y2="${barHeight}" stroke="#5f4c2e"/>
  <circle cx="18" cy="19" r="4" fill="#ffb454"/>
  <circle cx="32" cy="19" r="4" fill="#6c5b3c"/>
  <circle cx="46" cy="19" r="4" fill="#403823"/>
  <text x="62" y="24" fill="#7c6f4f" font-family="'IBM Plex Mono', monospace" font-size="11">${escapeXml(label)} — 100×24</text>
  <g fill="#e7d6ad" font-family="'IBM Plex Mono', 'SFMono-Regular', Consolas, monospace" font-size="13" xml:space="preserve">
    ${rows}
  </g>
</svg>
`;
}

async function waitForFrame(lastFrame: () => string | undefined, text: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const frame = lastFrame() ?? "";
    if (frame.includes(text)) return frame;
    await Bun.sleep(10);
  }
  throw new Error(`TUI frame never contained ${JSON.stringify(text)}`);
}

async function main() {
  const db = openDb();
  const { table: pricing } = await loadPricing();
  const app = render(<App db={db} pricing={pricing} />);

  const portfolio = await waitForFrame(app.lastFrame, "cc-analyzer");
  app.stdin.write("\u001B");
  await waitForFrame(app.lastFrame, "switch view");
  app.stdin.write("5");
  const trends = await waitForFrame(app.lastFrame, "heatmap");

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(join(outputDir, "tui-portfolio.svg"), frameToSvg(portfolio, "portfolio")),
    writeFile(join(outputDir, "tui-trends.svg"), frameToSvg(trends, "trends")),
  ]);

  app.unmount();
  db.close();
  console.log(`Generated TUI snapshots in ${outputDir}`);
}

await main();
