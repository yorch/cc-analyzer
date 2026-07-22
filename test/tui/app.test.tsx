import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "ink-testing-library";
import { openDb } from "../../src/core/db.ts";
import { reindex } from "../../src/core/indexer.ts";
import { App } from "../../src/tui/App.tsx";
import { samplePricing as pricing } from "../helpers/pricing.ts";
import { waitForFrame, waitForFrameGone } from "../helpers/tui.ts";

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
    await waitForFrame(lastFrame, "projects ▸");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("projects ▸"); // drilled breadcrumb
    expect(frame).toContain("/Users/dev/proj");
    unmount();
  });

  test("esc focuses the rail, then a number key jumps to the sessions view", async () => {
    const { stdin, lastFrame, unmount } = render(<App db={db} pricing={pricing} />);
    stdin.write(""); // esc on an empty filter → focus the nav rail
    await waitForFrame(lastFrame, "switch view"); // rail-focused key hints
    stdin.write("3"); // jump to the 3rd view (sessions)
    // Assert on a session row (the fixture's title), which appears only on the
    // sessions view — not "sessions", which is always visible in the nav rail.
    await waitForFrame(lastFrame, "Add hello function");
    expect(lastFrame() ?? "").toContain("Add hello function");
    unmount();
  });

  test("insights is a live view showing the cache hit-list", async () => {
    const { stdin, lastFrame, unmount } = render(<App db={db} pricing={pricing} />);
    stdin.write(""); // esc → focus the nav rail
    await waitForFrame(lastFrame, "switch view"); // rail-focused key hints
    stdin.write("4"); // jump to the 4th view (insights)
    await waitForFrame(lastFrame, "un-amortized");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("insights"); // breadcrumb
    expect(frame).toContain("un-amortized"); // the cache summary header
    unmount();
  });

  test("trends is a live view with the burn/heatmap panels", async () => {
    const { stdin, lastFrame, unmount } = render(<App db={db} pricing={pricing} />);
    stdin.write(""); // esc → focus the nav rail
    await waitForFrame(lastFrame, "switch view"); // rail-focused key hints
    stdin.write("5"); // jump to the 5th view (trends)
    await waitForFrame(lastFrame, "heatmap");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("trends"); // breadcrumb
    expect(frame).toContain("heatmap"); // panel switcher (no longer a placeholder)
    unmount();
  });

  test("tools is a live view with the usage panels", async () => {
    const { stdin, lastFrame, unmount } = render(<App db={db} pricing={pricing} />);
    stdin.write(""); // esc → focus the nav rail
    await waitForFrame(lastFrame, "switch view"); // rail-focused key hints
    stdin.write("6"); // jump to the 6th view (tools)
    await waitForFrame(lastFrame, "subagents");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("tools"); // breadcrumb + rail
    expect(frame).toContain("subagents"); // panel switcher
    unmount();
  });

  test("pressing ? toggles the help overlay", async () => {
    const { stdin, lastFrame, unmount } = render(<App db={db} pricing={pricing} />);
    stdin.write("?");
    await waitForFrame(lastFrame, "Keybindings");
    expect(lastFrame() ?? "").toContain("Keybindings");
    stdin.write(" "); // any key closes
    await waitForFrameGone(lastFrame, "Keybindings");
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
