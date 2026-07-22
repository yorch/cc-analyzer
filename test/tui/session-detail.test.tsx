import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { render } from "ink-testing-library";
import type { IndexedSession } from "../../src/core/queries.ts";
import { SessionDetailScreen } from "../../src/tui/screens/SessionDetailScreen.tsx";
import { samplePricing as pricing } from "../helpers/pricing.ts";

const fixture = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));

const session: IndexedSession = {
  sessionId: "sess-1",
  path: fixture,
  title: "Fixture session",
  cost: 1,
  costEstimated: false,
  ioTokens: 1000,
  cacheTokens: 5000,
  startTime: null,
  turns: 2,
  apiCalls: 3,
  toolCalls: 2,
  mtimeMs: 0,
};

const wait = (ms = 100) => new Promise((r) => setTimeout(r, ms));

describe("SessionDetailScreen (smoke)", () => {
  test("turns mode previews the selected turn's steps in the detail pane", async () => {
    const { lastFrame, unmount } = render(
      <SessionDetailScreen
        session={session}
        pricing={pricing}
        isActive
        columns={120}
        rows={40}
        onBack={() => {}}
      />,
    );
    await wait(); // allow the async parse+analyze to settle
    const frame = lastFrame() ?? "";
    expect(frame).toContain("#1"); // a turn row in the master pane
    expect(frame).toContain("cache"); // vitals band
    expect(frame).toContain("turn #1"); // detail-pane header for the selected turn
    expect(frame).toContain("Write"); // turn 1's steps shown live (edit op)
    expect(frame).not.toContain("Bash"); // Bash lives in the next turn, not shown yet
    unmount();
  });

  test("moving to the next turn previews its steps", async () => {
    const { stdin, lastFrame, unmount } = render(
      <SessionDetailScreen
        session={session}
        pricing={pricing}
        isActive
        columns={120}
        rows={40}
        onBack={() => {}}
      />,
    );
    await wait();
    stdin.write("j"); // next turn (has the Bash step)
    await wait();
    expect(lastFrame() ?? "").toContain("Bash");
    unmount();
  });

  test("G jumps to the last turn, g back to the first", async () => {
    const { stdin, lastFrame, unmount } = render(
      <SessionDetailScreen
        session={session}
        pricing={pricing}
        isActive
        columns={120}
        rows={40}
        onBack={() => {}}
      />,
    );
    await wait();
    stdin.write("G"); // jump to the last turn (Bash)
    await wait();
    expect(lastFrame() ?? "").toContain("Bash");
    stdin.write("g"); // jump back to the first turn (Write)
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Write");
    expect(frame).not.toContain("Bash");
    unmount();
  });

  test("descending into steps and expanding one reveals its detail", async () => {
    const { stdin, lastFrame, unmount } = render(
      <SessionDetailScreen
        session={session}
        pricing={pricing}
        isActive
        columns={120}
        rows={40}
        onBack={() => {}}
      />,
    );
    await wait();
    stdin.write("\t"); // focus the steps pane
    await wait();
    stdin.write("\r"); // expand the first step's detail card
    await wait();
    expect(lastFrame() ?? "").toMatch(/input:|result:|full text:/);
    unmount();
  });

  test("transcript mode: items collapse and expand", async () => {
    const { stdin, lastFrame, unmount } = render(
      <SessionDetailScreen
        session={session}
        pricing={pricing}
        isActive
        columns={120}
        rows={40}
        onBack={() => {}}
      />,
    );
    await wait();
    stdin.write("t"); // transcript mode
    await wait();
    expect(lastFrame() ?? "").toContain("▸"); // collapsed chevron on an item with a body
    stdin.write("\r"); // expand the item under the cursor
    await wait();
    expect(lastFrame() ?? "").toContain("▾"); // now expanded
    unmount();
  });
});
