import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { openDb } from "../../src/core/db.ts";
import { INDEXED_COST_CAVEAT } from "../../src/core/stats-types.ts";
import { TrendsView } from "../../src/tui/screens/TrendsView.tsx";
import { insertSession } from "../helpers/sessions.ts";
import { waitForFrame } from "../helpers/tui.ts";

function insert(db: Database, path: string, day: string, startTime: string, cost: number): void {
  insertSession(db, {
    path,
    day,
    start_time: startTime,
    cost_total: cost,
    input_tokens: 100,
    cache_read: 1000,
  });
}

let db: Database;
beforeAll(() => {
  db = openDb(":memory:");
  insert(db, "s1", "2026-07-01", "2026-07-01T14:00:00.000Z", 5);
  insert(db, "s2", "2026-07-02", "2026-07-02T15:00:00.000Z", 8);
  insert(db, "s3", "2026-07-09", "2026-07-09T09:00:00.000Z", 3);
});

const noop = () => {};

describe("TrendsView", () => {
  test("burn panel shows the summary, chart, and date axis", () => {
    const { lastFrame, unmount } = render(
      <TrendsView db={db} columns={120} rows={30} isActive={false} onBack={noop} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("burn");
    expect(frame).toContain("total"); // summary line
    expect(frame).toContain("2026-07-01"); // axis start
    unmount();
  });

  test("g cycles granularity; 2 switches to the heatmap; m toggles its metric", async () => {
    const { stdin, lastFrame, unmount } = render(
      <TrendsView db={db} columns={120} rows={30} isActive onBack={noop} />,
    );
    stdin.write("g"); // day → week
    await waitForFrame(lastFrame, "week");
    expect(lastFrame() ?? "").toContain("week");

    stdin.write("2"); // heatmap panel
    await waitForFrame(lastFrame, "Mon");
    let frame = lastFrame() ?? "";
    expect(frame).toContain("heatmap");
    expect(frame).toContain("Mon"); // weekday row label
    expect(frame).toContain("sessions"); // default heat metric

    stdin.write("m"); // toggle heat metric → cost
    await waitForFrame(lastFrame, "cost");
    frame = lastFrame() ?? "";
    expect(frame).toContain("cost");
    unmount();
  });

  test("4 opens the models panel: per-model weekly sparkline, total, and share", async () => {
    const mixed = openDb(":memory:");
    insertSession(mixed, {
      path: "m1",
      day: "2026-07-01",
      cost_total: 12,
      models_json: JSON.stringify({ "claude-opus-4-7": { cost: { total: 12 } } }),
    });
    insertSession(mixed, {
      path: "m2",
      day: "2026-07-09",
      cost_total: 4,
      models_json: JSON.stringify({ "claude-haiku-4-5": { cost: { total: 4 } } }),
    });
    const { stdin, lastFrame, unmount } = render(
      <TrendsView db={mixed} columns={120} rows={30} isActive onBack={noop} />,
    );
    stdin.write("4");
    await waitForFrame(lastFrame, "models");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("claude-opus-4-7"); // ranked first (higher total)
    expect(frame).toContain("claude-haiku-4-5");
    expect(frame).toContain("$12.00");
    expect(frame).toContain("75%"); // 12 of 16
    // Indexed-cost cross-file de-dup caveat prints as the panel's footer note.
    expect(frame).toContain(INDEXED_COST_CAVEAT.slice(0, 50));
    unmount();
    mixed.close();
  });
});
