import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { openDb } from "../../src/core/db.ts";
import type { IndexedProject, IndexedSession } from "../../src/core/queries.ts";
import { ProjectsView } from "../../src/tui/screens/ProjectsView.tsx";
import { SessionListView } from "../../src/tui/screens/SessionListView.tsx";
import { TrendsView } from "../../src/tui/screens/TrendsView.tsx";
import { insertSession } from "../helpers/sessions.ts";
import { waitForFrame } from "../helpers/tui.ts";

const projects: IndexedProject[] = [
  {
    projectId: "proj-a",
    projectPath: "/Users/dev/alpha",
    claudeDir: "/tmp/claude",
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
    claudeDir: "/tmp/claude",
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

describe("TrendsView heatmap axis alignment", () => {
  test("hour ticks land on their grid column, and 23h right-aligns instead of overhanging", async () => {
    const heatDb = openDb(":memory:");
    insertSession(heatDb, {
      path: "/h/1.jsonl",
      day: "2026-07-01",
      start_time: "2026-07-01T14:00:00.000Z",
      cost_total: 5,
    });
    const { stdin, lastFrame, unmount } = render(
      <TrendsView db={heatDb} columns={120} rows={30} isActive onBack={noop} />,
    );
    stdin.write("2"); // heatmap panel
    await waitForFrame(lastFrame, "Mon");
    const frame = lastFrame() ?? "";
    // The grid row is 4 weekday-label chars ("Mon ") + 24 one-char hour cells
    // = 28 columns; each tick sits at column `4 + hour`, and "23h" — which
    // would run past column 28 there — right-aligns to end at the last
    // column instead. This is a pinning test on the exact 28-char axis.
    const axisLine = "    0h    6h    12h   18h23h";
    expect(axisLine).toHaveLength(28);
    expect(frame).toContain(axisLine);
    unmount();
    heatDb.close();
  });
});
