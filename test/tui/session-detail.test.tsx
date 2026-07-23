import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { render } from "ink-testing-library";
import type { IndexedSession } from "../../src/core/queries.ts";
import { SessionDetailScreen } from "../../src/tui/screens/SessionDetailScreen.tsx";
import { samplePricing as pricing } from "../helpers/pricing.ts";
import { waitForFrame, waitForFrameGone } from "../helpers/tui.ts";

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

/**
 * Yield one macrotask so the freshly-mounted TurnsPane `useInput` subscription
 * has attached before we send keys. Ink registers input on the post-commit
 * effect — one tick after the frame first paints the loaded turn — and it does
 * not buffer input that arrives before a handler is subscribed. This is a
 * deterministic single-tick yield, not a load-dependent sleep.
 */
const settleInput = () => new Promise((r) => setTimeout(r, 0));

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
    // poll for post-load content: the detail-pane header appears only once the
    // async parse+analyze has settled and the screen has rendered the turn.
    await waitForFrame(lastFrame, "turn #1");
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
    await waitForFrame(lastFrame, "turn #1"); // loaded
    await settleInput();
    stdin.write("j"); // next turn (has the Bash step)
    await waitForFrame(lastFrame, "Bash");
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
    await waitForFrame(lastFrame, "turn #1"); // loaded
    await settleInput();
    stdin.write("G"); // jump to the last turn (Bash)
    await waitForFrame(lastFrame, "Bash");
    expect(lastFrame() ?? "").toContain("Bash");
    stdin.write("g"); // jump back to the first turn (Write)
    await waitForFrame(lastFrame, "Write");
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
    await waitForFrame(lastFrame, "turn #1"); // loaded
    await settleInput();
    stdin.write("\t"); // focus the steps pane
    // the "❯" turn-selection marker only shows while the turns pane is focused,
    // so its disappearance confirms focus moved to the steps pane before we expand.
    await waitForFrameGone(lastFrame, "❯");
    stdin.write("\r"); // expand the first step's detail card
    await waitForFrame(lastFrame, (f) => /input:|result:|full text:/.test(f));
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
    await waitForFrame(lastFrame, "turn #1"); // loaded
    await settleInput();
    stdin.write("t"); // transcript mode
    // "esc turns" is the transcript/summary-mode key hint (turns mode reads
    // "esc back"), so it confirms the mode switched before we assert.
    await waitForFrame(lastFrame, "esc turns");
    expect(lastFrame() ?? "").toContain("▸"); // collapsed chevron on an item with a body
    stdin.write("\r"); // expand the item under the cursor
    await waitForFrame(lastFrame, "▾");
    expect(lastFrame() ?? "").toContain("▾"); // now expanded
    unmount();
  });
});

describe("SessionDetailScreen charts mode", () => {
  test("c switches to the charts view with context + cost panels", async () => {
    // ink-testing-library renders 100 columns wide regardless of props, so
    // pass a matching width — a wider chart row would wrap and shred the frame.
    const { stdin, lastFrame, unmount } = render(
      <SessionDetailScreen
        session={session}
        pricing={pricing}
        isActive
        columns={100}
        rows={40}
        onBack={() => {}}
      />,
    );
    await waitForFrame(lastFrame, "turn #1"); // loaded
    await settleInput();
    stdin.write("c"); // charts mode
    await waitForFrame(lastFrame, "context window");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("no compactions"); // fixture has none
    expect(frame).toContain("cost per call");
    expect(frame).toContain("cost per turn");
    unmount();
  });

  test("s switches to the summary with actionable diagnostics", async () => {
    const { stdin, lastFrame, unmount } = render(
      <SessionDetailScreen
        session={session}
        pricing={pricing}
        isActive
        columns={100}
        rows={40}
        onBack={() => {}}
      />,
    );
    await waitForFrame(lastFrame, "turn #1");
    await settleInput();
    stdin.write("s");
    await waitForFrame(lastFrame, "Actionable diagnostics");
    expect(lastFrame() ?? "").toContain("No notable context or cost patterns");
    unmount();
  });
});
