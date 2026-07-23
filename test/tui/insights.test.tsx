import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { openDb } from "../../src/core/db.ts";
import { InsightsView } from "../../src/tui/screens/InsightsView.tsx";
import { insertSession } from "../helpers/sessions.ts";
import { waitForFrame } from "../helpers/tui.ts";

function insert(
  db: Database,
  path: string,
  project: string,
  projectPath: string,
  w: number,
  r: number,
  cw: number,
): void {
  insertSession(db, {
    path,
    project_id: project,
    project_path: projectPath,
    cache_write_5m: w,
    cache_read: r,
    cost_cache_write: cw,
    cost_cache_read: 0.1,
    cost_input: 1,
    cost_output: 1,
    cost_total: cw + 2.1,
  });
}

let db: Database;
beforeAll(() => {
  db = openDb(":memory:");
  insert(db, "leaky-1", "p-leaky", "/p/leaky", 1000, 100, 10); // waste ~$9, ratio 0.1
  insert(db, "eff-1", "p-eff", "/p/eff", 1000, 3000, 10); // waste $0, ratio 3
});

const noop = () => {};

describe("InsightsView", () => {
  test("ranks projects by waste and previews the leader's breakdown", () => {
    const { lastFrame, unmount } = render(
      <InsightsView
        db={db}
        columns={120}
        pageSize={20}
        isActive={false}
        onOpenSession={noop}
        onBack={noop}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("un-amortized"); // header + preview
    expect(frame).toContain("/p/leaky"); // worst offender listed first
    expect(frame).toContain("leaky"); // verdict on the highlighted (leaky) project
    unmount();
  });

  test("enter drills into the project's sessions", async () => {
    const { stdin, lastFrame, unmount } = render(
      <InsightsView
        db={db}
        columns={120}
        pageSize={20}
        isActive
        onOpenSession={noop}
        onBack={noop}
      />,
    );
    await waitForFrame(lastFrame, "/p/leaky"); // ranked list rendered before drilling
    stdin.write("\r"); // drill into the top project (p-leaky)
    await waitForFrame(lastFrame, "leaky-1");
    expect(lastFrame() ?? "").toContain("leaky-1"); // its session now listed
    unmount();
  });
});
