import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { openDb } from "../../src/core/db.ts";
import type { PortfolioDiagnostic } from "../../src/core/portfolio-diagnostics.ts";
import type { IndexedProject, IndexedSession } from "../../src/core/queries.ts";
import type { ProjectCacheRow } from "../../src/core/stats.ts";
import { ProjectsView } from "../../src/tui/screens/ProjectsView.tsx";
import { SessionListView } from "../../src/tui/screens/SessionListView.tsx";
import { TrendsView } from "../../src/tui/screens/TrendsView.tsx";
import { insertSession } from "../helpers/sessions.ts";
import { waitForFrame } from "../helpers/tui.ts";

const noWaste = new Map<string, ProjectCacheRow>();
const noFindings = new Map<string, PortfolioDiagnostic[]>();

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
        wasteByProject={noWaste}
        findingsByProject={noFindings}
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
        wasteByProject={noWaste}
        findingsByProject={noFindings}
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
      files_json: JSON.stringify(["/Users/dev/alpha/src/main.ts"]),
    });
    insertSession(charted, {
      path: "/a/2.jsonl",
      project_id: "proj-a",
      day: "2026-07-09",
      cost_total: 1,
      files_json: JSON.stringify(["/Users/dev/alpha/src/main.ts"]),
    });
    // The compaction count rides on the project row itself (schema v7 sum).
    const withCompactions = projects.map((p) =>
      p.projectId === "proj-a" ? { ...p, compactions: 2 } : p,
    );
    const { lastFrame, unmount } = render(
      <ProjectsView
        projects={withCompactions}
        db={charted}
        wasteByProject={noWaste}
        findingsByProject={noFindings}
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
    expect(frame).toContain("hot files"); // top-3 teaser header
    expect(frame).toContain("2× src/main.ts"); // sessions × project-relative path
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

describe("ProjectsView multi-root labels and enriched preview", () => {
  test("two roots holding the same path get [root] suffixes", () => {
    const collide: IndexedProject[] = [
      { ...(projects[0] as IndexedProject), projectId: "aaaa1111~x", claudeDir: "/roots/home" },
      {
        ...(projects[0] as IndexedProject),
        projectId: "bbbb2222~x",
        claudeDir: "/roots/work",
      },
    ];
    const { lastFrame, unmount } = render(
      <ProjectsView
        projects={collide}
        db={db}
        wasteByProject={noWaste}
        findingsByProject={noFindings}
        columns={120}
        isActive={false}
        onOpen={noop}
        onBack={noop}
      />,
    );
    const frame = lastFrame() ?? "";
    // Identical paths from two roots must stay distinguishable in the list.
    expect(frame).toContain("[home]");
    expect(frame).toContain("[work]");
    unmount();
  });

  test("a short pane drops the hot-files block instead of overflowing the shell", () => {
    const short = openDb(":memory:");
    insertSession(short, {
      path: "/a/1.jsonl",
      project_id: "proj-a",
      day: "2026-07-01",
      cost_total: 5,
      files_json: JSON.stringify(["/Users/dev/alpha/src/main.ts"]),
    });
    const { lastFrame, unmount } = render(
      <ProjectsView
        projects={projects}
        db={short}
        wasteByProject={noWaste}
        findingsByProject={noFindings}
        columns={120}
        pageSize={6} // a ~24-row terminal's list budget
        isActive={false}
        onOpen={noop}
        onBack={noop}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("last active"); // vitals always render
    expect(frame).not.toContain("hot files"); // lowest-priority block dropped
    unmount();
    short.close();
  });

  test("preview shows cache efficiency and project-scoped findings when present", () => {
    const cacheRow: ProjectCacheRow = {
      projectId: "proj-a",
      projectPath: "/Users/dev/alpha",
      claudeDir: "/tmp/claude",
      sessions: 3,
      writeTokens: 1000,
      readTokens: 100,
      writeCost: 20,
      readCost: 0.1,
      inputCost: 1,
      outputCost: 1,
      totalCost: 22.1,
      ratio: 0.1,
      waste: 18,
    };
    const finding: PortfolioDiagnostic = {
      code: "compaction-pressure",
      severity: "warning",
      title: "One project compacts in most of its sessions",
      evidence: "…",
      action: "…",
      projectId: "proj-a",
    };
    const { lastFrame, unmount } = render(
      <ProjectsView
        projects={projects}
        db={db}
        wasteByProject={new Map([["proj-a", cacheRow]])}
        findingsByProject={new Map([["proj-a", [finding]]])}
        columns={120}
        isActive={false}
        onOpen={noop}
        onBack={noop}
      />,
    );
    // proj-a is the most recent, so it is highlighted and previewed by default.
    const frame = lastFrame() ?? "";
    expect(frame).toContain("cache eff.");
    expect(frame).toContain("leaky"); // verdict word, not just the color dot
    expect(frame).toContain("$18.00"); // un-amortized waste
    expect(frame).toContain("findings");
    expect(frame).toContain("compacts in most"); // top finding's title
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
