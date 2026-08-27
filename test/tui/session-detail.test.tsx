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

  test("o cycles the turn sort key and O flips its direction", async () => {
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
    // The list opens in session order, ascending — a session is a narrative.
    expect(lastFrame() ?? "").toContain("turn \u2191");
    await settleInput();
    stdin.write("o"); // cycle: turn -> cost
    await waitForFrame(lastFrame, "cost \u2191");
    stdin.write("O"); // flip to descending: the costliest turn leads
    await waitForFrame(lastFrame, "cost \u2193");
    expect(lastFrame() ?? "").toContain("cost \u2193");
    unmount();
  });

  test("turns carry their share of the session, and ranking summarises the top", async () => {
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
    // The detail header states the selected turn's share outright.
    expect(lastFrame() ?? "").toMatch(/turn #1 · \d+ calls · \$[\d.]+ · \d+% of session/);
    await settleInput();
    stdin.write("o"); // cycle: turn -> cost
    await waitForFrame(lastFrame, "cost \u2191");
    stdin.write("O"); // descending — now the running share is a Pareto read
    await waitForFrame(lastFrame, (f) => /top \d+ = \d+%/.test(f));
    expect(lastFrame() ?? "").toMatch(/top \d+ = \d+%/);
    unmount();
  });

  test("the turns detail attributes context growth and prints its caveat verbatim", async () => {
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
    await waitForFrame(lastFrame, "turn #1"); // loaded
    const frame = lastFrame() ?? "";
    // Turn 1's second call grew the prompt by ~1k over the first call's
    // prompt + output; the delta is attributed to the call that issued it.
    expect(frame).toMatch(/context: \+[\d.]+k after call 2/);
    // A mandatory caveat renders verbatim and is allowed to wrap — the frame
    // is width-limited, so assert on its opening clause rather than the whole
    // string, and separately that it was not truncate()d with an ellipsis.
    expect(frame).toContain("Context growth attributes each prompt-side increase");
    expect(frame).not.toContain("Context growth attributes each prompt…");
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

  test("t opens the transcript at the selected turn, with priced turn dividers", async () => {
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
    stdin.write("G"); // last turn
    await waitForFrame(lastFrame, "Bash");
    stdin.write("t"); // read THAT turn, not the top of the transcript
    await waitForFrame(lastFrame, "esc turns");
    // Every turn boundary in the words carries that turn's price and share.
    expect(lastFrame() ?? "").toMatch(/── turn #1 · \$[\d.]+ · \d+% of session/);
    expect(lastFrame() ?? "").toMatch(/── turn #2 · \$[\d.]+ · \d+% of session/);
    // The cursor landed on turn 2's prompt, not at the top: expanding the item
    // under it opens *that* prompt while turn 1's stays collapsed. (This
    // fixture's transcript fits one page, so scroll position proves nothing.)
    stdin.write("\r");
    await waitForFrame(lastFrame, "▾ You");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("▾ You");
    expect(frame).toContain("▸ You Add a hello function");
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

  test("charts mode shows the cache hit line for a session with cache reads", async () => {
    // The fixture's calls all read from cache (2000/3000/4000 cache_read_input_tokens),
    // so the cache-efficiency line under the context chart should report a hit rate.
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
    await waitForFrame(lastFrame, "cache hit");
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/cache hit \d+% · \d+ cold calls?/);
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

  test("summary mode shows the cost-per-outcome and what-if lines", async () => {
    // The fixture mixes two models (opus + sonnet), so sessionWhatIf has real
    // rows to compare rather than falling back to the canonical ladder.
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
    await waitForFrame(lastFrame, "Cost per outcome");
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/per turn\s+\$/);
    expect(frame).toContain("Outcome ratios pair spend with observable work products");
    expect(frame).toContain("what-if: cheapest single model");
    expect(frame).toContain("What-if repricing replays the actual token mix");
    unmount();
  });
});
