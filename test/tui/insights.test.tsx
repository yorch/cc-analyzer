import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { openDb } from "../../src/core/db.ts";
import { InsightsView } from "../../src/tui/screens/InsightsView.tsx";

function insert(
  db: Database,
  path: string,
  project: string,
  projectPath: string,
  w: number,
  r: number,
  cw: number,
): void {
  db.query(
    `INSERT INTO sessions
      (path, project_id, project_path, session_id, title,
       cache_write_5m, cache_write_1h, cache_read,
       cost_cache_write, cost_cache_read, cost_input, cost_output, cost_total)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(path, project, projectPath, path, path, w, 0, r, cw, 0.1, 1, 1, cw + 2.1);
}

let db: Database;
beforeAll(() => {
  db = openDb(":memory:");
  insert(db, "leaky-1", "p-leaky", "/p/leaky", 1000, 100, 10); // waste ~$9, ratio 0.1
  insert(db, "eff-1", "p-eff", "/p/eff", 1000, 3000, 10); // waste $0, ratio 3
});

const noop = () => {};
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

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
    await wait();
    stdin.write("\r"); // drill into the top project (p-leaky)
    await wait();
    expect(lastFrame() ?? "").toContain("leaky-1"); // its session now listed
    unmount();
  });
});
