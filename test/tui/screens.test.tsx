import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { IndexedProject, IndexedSession } from "../../src/core/queries.ts";
import { ProjectsScreen } from "../../src/tui/screens/ProjectsScreen.tsx";
import { SessionsScreen } from "../../src/tui/screens/SessionsScreen.tsx";

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
    lastActivityMs: Date.now(),
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

describe("TUI screens (smoke render)", () => {
  test("ProjectsScreen lists projects with cost and path", () => {
    const { lastFrame, unmount } = render(
      <ProjectsScreen projects={projects} onOpen={() => {}} onBack={() => {}} isActive={false} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Projects (2)");
    expect(frame).toContain("/Users/dev/alpha");
    expect(frame).toContain("$12.50");
    unmount();
  });

  test("SessionsScreen lists sessions with title", () => {
    const { lastFrame, unmount } = render(
      <SessionsScreen
        project={projects[0] as IndexedProject}
        sessions={sessions}
        onOpen={() => {}}
        onBack={() => {}}
        isActive={false}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Fix the parser");
    expect(frame).toContain("$3.20");
    unmount();
  });
});
