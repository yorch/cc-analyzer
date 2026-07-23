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
): void {
  insertSession(db, {
    path,
    tools_json: JSON.stringify(tools),
    tool_errors_json: JSON.stringify(errs),
    skills_json: JSON.stringify(skills),
    skill_errors_json: JSON.stringify({}),
    subagents_json: JSON.stringify(subagents),
  });
}

let db: Database;
beforeAll(() => {
  db = openDb(":memory:");
  insert(db, "s1", { Bash: 30, Edit: 3 }, { Edit: 1 }, { brainstorming: 2 }, ["general-purpose"]);
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

    stdin.write("3"); // subagents panel
    await waitForFrame(lastFrame, "SUBAGENT");
    frame = lastFrame() ?? "";
    expect(frame).toContain("SUBAGENT");
    expect(frame).toContain("general-purpose");
    unmount();
  });
});
