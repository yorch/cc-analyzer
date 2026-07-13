import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "ink-testing-library";
import { openDb } from "../../src/core/db.ts";
import { reindex } from "../../src/core/indexer.ts";
import type { ModelPricing, PricingTable } from "../../src/core/pricing.ts";
import { App } from "../../src/tui/App.tsx";

const flat: ModelPricing = {
  inputCostPerToken: 0.00001,
  outputCostPerToken: 0.00002,
  cacheWrite5mCostPerToken: 0.0000125,
  cacheWrite1hCostPerToken: 0.00002,
  cacheReadCostPerToken: 0.000001,
};
const pricing: PricingTable = { "claude-opus-4-7": flat, "claude-sonnet-4-5": flat };

const tmpDir = join("/tmp", `cc-analyzer-app-${process.pid}-${Date.now()}`);
const fixture = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));
let prevClaudeDir: string | undefined;
let db: Database;

beforeAll(async () => {
  const content = await Bun.file(fixture).text();
  mkdirSync(join(tmpDir, "projects", "proj-a"), { recursive: true });
  writeFileSync(join(tmpDir, "projects", "proj-a", "s1.jsonl"), content);
  prevClaudeDir = process.env.CC_ANALYZER_CLAUDE_DIR;
  process.env.CC_ANALYZER_CLAUDE_DIR = tmpDir;
  db = openDb(":memory:");
  await reindex(db, { pricing });
});

afterAll(() => {
  db.close();
  if (prevClaudeDir === undefined) delete process.env.CC_ANALYZER_CLAUDE_DIR;
  else process.env.CC_ANALYZER_CLAUDE_DIR = prevClaudeDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("App (smoke render)", () => {
  test("opens on the portfolio home in the amber shell", () => {
    const { lastFrame, unmount } = render(<App db={db} pricing={pricing} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("cc-analyzer"); // title bar
    expect(frame).toContain("total"); // portfolio lede
    expect(frame).toContain("portfolio"); // nav rail (breadcrumb + rail entry)
    expect(frame).toContain("sessions"); // nav rail entry
    unmount();
  });

  test("enter on a project drills into its sessions (breadcrumb updates)", async () => {
    const { stdin, lastFrame, unmount } = render(<App db={db} pricing={pricing} />);
    stdin.write("\r"); // enter on the highlighted project row
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("projects ▸"); // drilled breadcrumb
    expect(frame).toContain("/Users/dev/proj");
    unmount();
  });

  test("esc focuses the rail, then a number key jumps to the sessions view", async () => {
    const { stdin, lastFrame, unmount } = render(<App db={db} pricing={pricing} />);
    stdin.write(""); // esc on an empty filter → focus the nav rail
    await wait();
    stdin.write("3"); // jump to the 3rd view (sessions)
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("sessions"); // breadcrumb now reads "sessions"
    unmount();
  });

  test("insights is a live view showing the cache hit-list", async () => {
    const { stdin, lastFrame, unmount } = render(<App db={db} pricing={pricing} />);
    stdin.write(""); // esc → focus the nav rail
    await wait();
    stdin.write("4"); // jump to the 4th view (insights)
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("insights"); // breadcrumb
    expect(frame).toContain("un-amortized"); // the cache summary header
    unmount();
  });

  test("trends is a live view with the burn/heatmap panels", async () => {
    const { stdin, lastFrame, unmount } = render(<App db={db} pricing={pricing} />);
    stdin.write(""); // esc → focus the nav rail
    await wait();
    stdin.write("5"); // jump to the 5th view (trends)
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("trends"); // breadcrumb
    expect(frame).toContain("heatmap"); // panel switcher (no longer a placeholder)
    unmount();
  });

  test("tools is a live view with the usage panels", async () => {
    const { stdin, lastFrame, unmount } = render(<App db={db} pricing={pricing} />);
    stdin.write(""); // esc → focus the nav rail
    await wait();
    stdin.write("6"); // jump to the 6th view (tools)
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("tools"); // breadcrumb + rail
    expect(frame).toContain("subagents"); // panel switcher
    unmount();
  });

  test("pressing ? toggles the help overlay", async () => {
    const { stdin, lastFrame, unmount } = render(<App db={db} pricing={pricing} />);
    stdin.write("?");
    await wait();
    expect(lastFrame() ?? "").toContain("Keybindings");
    stdin.write(" "); // any key closes
    await wait();
    expect(lastFrame() ?? "").not.toContain("Keybindings");
    unmount();
  });

  test("shows an empty-index message when nothing is indexed", () => {
    const emptyDb = openDb(":memory:");
    const { lastFrame, unmount } = render(<App db={emptyDb} pricing={pricing} />);
    expect(lastFrame() ?? "").toContain("index is empty");
    unmount();
    emptyDb.close();
  });
});
