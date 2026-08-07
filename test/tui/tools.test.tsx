import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { openDb } from "../../src/core/db.ts";
import { ToolsView } from "../../src/tui/screens/ToolsView.tsx";
import { insertSession } from "../helpers/sessions.ts";
import { waitForFrame } from "../helpers/tui.ts";

function insert(
  db: Database,
  path: string,
  tools: Record<string, number>,
  errs: Record<string, number>,
  skills: Record<string, number>,
  subagents: string[],
  turnCosts: Record<string, { turns: number; cost: number }> = {},
  cost = 0,
): void {
  insertSession(db, {
    path,
    cost_total: cost,
    tools_json: JSON.stringify(tools),
    tool_errors_json: JSON.stringify(errs),
    skills_json: JSON.stringify(skills),
    skill_errors_json: JSON.stringify({}),
    skill_turn_costs_json: JSON.stringify(turnCosts),
    subagents_json: JSON.stringify(subagents),
  });
}

let db: Database;
beforeAll(() => {
  db = openDb(":memory:");
  insert(
    db,
    "s1",
    { Bash: 30, Edit: 3 },
    { Edit: 1 },
    { brainstorming: 2 },
    ["general-purpose"],
    { brainstorming: { turns: 1, cost: 0.25 } },
    9,
  );
  insert(db, "s2", { Bash: 20, Read: 9 }, { Bash: 6 }, { brainstorming: 1 }, []);
});

const noop = () => {};

describe("ToolsView", () => {
  test("tools panel lists tools with uses/error columns", () => {
    const { lastFrame, unmount } = render(
      <ToolsView db={db} columns={120} rows={30} isActive={false} onBack={noop} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("TOOL");
    expect(frame).toContain("ERR%");
    expect(frame).toContain("Bash"); // most-used tool
    unmount();
  });

  test("s cycles the sort; 2/3 switch to skills/subagents", async () => {
    const { stdin, lastFrame, unmount } = render(
      <ToolsView db={db} columns={120} rows={30} isActive onBack={noop} />,
    );
    expect(lastFrame() ?? "").toContain("sort: uses");
    stdin.write("s"); // uses → errors
    await waitForFrame(lastFrame, "sort: errors");
    expect(lastFrame() ?? "").toContain("sort: errors");

    stdin.write("2"); // skills panel
    await waitForFrame(lastFrame, "SKILL");
    let frame = lastFrame() ?? "";
    expect(frame).toContain("SKILL");
    expect(frame).toContain("brainstorming");
    // Turn-scoped cost leads, session-scoped follows as the upper bound.
    expect(frame).toContain("TURN $");
    expect(frame).toContain("SESS $");
    expect(frame).toContain("$0.25");
    expect(frame).toContain("$9.00");
    expect(frame).toContain("session-scoped");
    expect(frame).toContain("Turn-scoped cost");

    stdin.write("3"); // subagents panel
    await waitForFrame(lastFrame, "SUBAGENT");
    frame = lastFrame() ?? "";
    expect(frame).toContain("SUBAGENT");
    expect(frame).toContain("general-purpose");
    unmount();
  });

  test("4 opens the reliability panel: churn, thrash, corrections, parse coverage", async () => {
    const rel = openDb(":memory:");
    insertSession(rel, {
      path: "r1",
      turns: 100,
      retries: 6,
      retries_json: JSON.stringify({ Bash: 6 }),
      correction_turns: 8,
      interruption_turns: 3,
      test_fail_streak: 4, // ≥ THRASH_STREAK_MIN → an edit-test-thrash session
      redundant_reads: 7, // ≥ THRASH_REREAD_MIN → a reread-heavy session
      reread_files_json: JSON.stringify(["/p/one/src/hot.ts"]),
      parse_lines: 1000,
      parse_errors: 2,
      unknown_events: 5,
      versions_json: JSON.stringify(["2.0.1"]),
    });
    const { stdin, lastFrame, unmount } = render(
      <ToolsView db={rel} columns={140} rows={40} isActive onBack={noop} />,
    );
    stdin.write("4");
    await waitForFrame(lastFrame, "corrections");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("6 repeated identical calls");
    expect(frame).toContain("worst Bash (6)");
    expect(frame).toContain("edit→test→fail loops");
    expect(frame).toContain("worst streak 4");
    expect(frame).toContain("7 redundant reads");
    expect(frame).toContain("src/hot.ts");
    expect(frame).toContain("8.0%"); // correction share of 100 turns
    expect(frame).toContain("interrupted mid-flight");
    // Mandatory caveat, verbatim (assert a fragment that fits one wrapped line).
    expect(frame).toContain("English-only keyword heuristic");
    expect(frame).toContain("99.3% parsed"); // 1 − (2+5)/1000
    expect(frame).toContain("newest 2.0.1");
    unmount();
    rel.close();
  });
});
