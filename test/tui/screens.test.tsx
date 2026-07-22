import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { openDb } from "../../src/core/db.ts";
import type { IndexedProject, IndexedSession } from "../../src/core/queries.ts";
import { ProjectsView } from "../../src/tui/screens/ProjectsView.tsx";
import { SessionListView } from "../../src/tui/screens/SessionListView.tsx";
import { insertSession } from "../helpers/sessions.ts";
import { waitForFrame } from "../helpers/tui.ts";

const projects: IndexedProject[] = [
  {
    projectId: "proj-a",
    projectPath: "/Users/dev/alpha",
    sessions: 3,
    cost: 12.5,
    ioTokens: 1000,
    cacheTokens: 5000,
    lastActivityMs: Date.now(),
    compactions: 0,
  },
  {
    projectId: "proj-b",
    projectPath: "/Users/dev/beta",
    sessions: 1,
    cost: 0.4,
    ioTokens: 1000,
    cacheTokens: 5000,
    lastActivityMs: Date.now() - 1000,
    compactions: 0,
  },
];

const sessions: IndexedSession[] = [
  {
    sessionId: "s1",
    path: "/x/s1.jsonl",
    title: "Fix the parser",
    cost: 3.2,
    costEstimated: false,
    ioTokens: 1000,
    cacheTokens: 5000,
    startTime: "2026-07-01T00:00:00Z",
    turns: 4,
    apiCalls: 20,
    toolCalls: 9,
    mtimeMs: Date.now(),
  },
];

const noop = () => {};

// The project preview queries per-project chart series live; an empty
// in-memory index keeps the smoke render hermetic.
const db = openDb(":memory:");

describe("TUI list views (smoke render)", () => {
  test("ProjectsView lists projects and previews the selection", () => {
    const { lastFrame, unmount } = render(
      <ProjectsView
        projects={projects}
        db={db}
        columns={120}
        isActive={false}
        onOpen={noop}
        onBack={noop}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/Users/dev/alpha"); // master row
    expect(frame).toContain("$12.50");
    expect(frame).toContain("last active"); // preview pane field
    unmount();
  });

  test("ProjectsView sort: Tab cycles field, shift-Tab flips direction", async () => {
    const { stdin, lastFrame, unmount } = render(
      <ProjectsView
        projects={projects}
        db={db}
        columns={120}
        isActive
        onOpen={noop}
        onBack={noop}
      />,
    );
    expect(lastFrame() ?? "").toContain("· recent ↓"); // default sort indicator
    stdin.write("\t"); // Tab → next field
    await waitForFrame(lastFrame, "· cost ↓");
    expect(lastFrame() ?? "").toContain("· cost ↓");
    stdin.write("[Z"); // shift-Tab → flip direction
    await waitForFrame(lastFrame, "· cost ↑");
    expect(lastFrame() ?? "").toContain("· cost ↑");
    unmount();
  });

  test("ProjectsView preview charts appear when the index has dated rows", async () => {
    const charted = openDb(":memory:");
    insertSession(charted, {
      path: "/a/1.jsonl",
      project_id: "proj-a",
      day: "2026-07-01",
      cost_total: 5,
      turn_depths_json: JSON.stringify([1, 4]),
      compactions: 2,
    });
    insertSession(charted, {
      path: "/a/2.jsonl",
      project_id: "proj-a",
      day: "2026-07-09",
      cost_total: 1,
    });
    // The compaction count rides on the project row itself (schema v7 sum).
    const withCompactions = projects.map((p) =>
      p.projectId === "proj-a" ? { ...p, compactions: 2 } : p,
    );
    const { lastFrame, unmount } = render(
      <ProjectsView
        projects={withCompactions}
        db={charted}
        columns={120}
        isActive={false}
        onOpen={noop}
        onBack={noop}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("burn / week"); // weekly sparkline row
    expect(frame).toContain("sess cost"); // cost-distribution ramp
    expect(frame).toContain("turn depth"); // depth ramp
    expect(frame).toContain("compactions"); // v7 count line
    unmount();
    charted.close();
  });

  test("SessionListView lists sessions and previews the selection", () => {
    const { lastFrame, unmount } = render(
      <SessionListView
        sessions={sessions}
        columns={120}
        isActive={false}
        onOpen={noop}
        onBack={noop}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Fix the parser");
    expect(frame).toContain("$3.20");
    expect(frame).toContain("turns"); // preview pane field
    unmount();
  });
});
