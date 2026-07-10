import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "ink-testing-library";
import { openDb } from "../../src/core/db.ts";
import { reindex } from "../../src/core/indexer.ts";
import type { ModelPricing, PricingTable } from "../../src/core/pricing.ts";
import { DashboardScreen } from "../../src/tui/screens/DashboardScreen.tsx";

const flat: ModelPricing = {
  inputCostPerToken: 0.00001,
  outputCostPerToken: 0.00002,
  cacheWrite5mCostPerToken: 0.0000125,
  cacheWrite1hCostPerToken: 0.00002,
  cacheReadCostPerToken: 0.000001,
};
const pricing: PricingTable = { "claude-opus-4-7": flat, "claude-sonnet-4-5": flat };

const tmpDir = join("/tmp", `cc-analyzer-dash-${process.pid}-${Date.now()}`);
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

const noop = () => {};
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("DashboardScreen", () => {
  test("renders the portfolio hero and panel switcher", () => {
    const { lastFrame, unmount } = render(
      <DashboardScreen
        db={db}
        isActive
        onOpenProject={noop}
        onOpenSession={noop}
        onOpenProjects={noop}
        onOpenSearch={noop}
        onBack={noop}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("total"); // hero
    expect(frame).toContain("months");
    expect(frame).toContain("projects");
    expect(frame).toContain("sessions");
    unmount();
  });

  test("p invokes onOpenProjects", async () => {
    let opened = false;
    const { stdin, unmount } = render(
      <DashboardScreen
        db={db}
        isActive
        onOpenProject={noop}
        onOpenSession={noop}
        onOpenProjects={() => {
          opened = true;
        }}
        onOpenSearch={noop}
        onBack={noop}
      />,
    );
    stdin.write("p");
    await wait();
    expect(opened).toBe(true);
    unmount();
  });

  test("selecting a project row drills in via onOpenProject", async () => {
    const opened: string[] = [];
    const { stdin, unmount } = render(
      <DashboardScreen
        db={db}
        isActive
        onOpenProject={(id) => opened.push(id)}
        onOpenSession={noop}
        onOpenProjects={noop}
        onOpenSearch={noop}
        onBack={noop}
      />,
    );
    stdin.write("2"); // switch to the (selectable) projects panel
    await wait();
    stdin.write("\r"); // enter on the first project row
    await wait();
    expect(opened).toEqual(["proj-a"]);
    unmount();
  });
});
