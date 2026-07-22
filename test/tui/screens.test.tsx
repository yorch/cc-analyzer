import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { IndexedProject, IndexedSession } from "../../src/core/queries.ts";
import { ProjectsView } from "../../src/tui/screens/ProjectsView.tsx";
import { SessionListView } from "../../src/tui/screens/SessionListView.tsx";
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
  },
  {
    projectId: "proj-b",
    projectPath: "/Users/dev/beta",
    sessions: 1,
    cost: 0.4,
    ioTokens: 1000,
    cacheTokens: 5000,
    lastActivityMs: Date.now() - 1000,
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

describe("TUI list views (smoke render)", () => {
  test("ProjectsView lists projects and previews the selection", () => {
    const { lastFrame, unmount } = render(
      <ProjectsView
        projects={projects}
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
      <ProjectsView projects={projects} columns={120} isActive onOpen={noop} onBack={noop} />,
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
