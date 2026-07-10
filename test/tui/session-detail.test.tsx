import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { render } from "ink-testing-library";
import type { ModelPricing, PricingTable } from "../../src/core/pricing.ts";
import type { IndexedSession } from "../../src/core/queries.ts";
import { SessionDetailScreen } from "../../src/tui/screens/SessionDetailScreen.tsx";

const fixture = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));
const flat: ModelPricing = {
  inputCostPerToken: 0.00001,
  outputCostPerToken: 0.00002,
  cacheWrite5mCostPerToken: 0.0000125,
  cacheWrite1hCostPerToken: 0.00002,
  cacheReadCostPerToken: 0.000001,
};
const pricing: PricingTable = { "claude-opus-4-7": flat, "claude-sonnet-4-5": flat };

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

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));

describe("SessionDetailScreen (smoke)", () => {
  test("turns tab collapses turns by default and shows token annotations", async () => {
    const { stdin, lastFrame, unmount } = render(
      <SessionDetailScreen session={session} pricing={pricing} isActive onBack={() => {}} />,
    );
    await wait(); // allow the async parse+analyze to settle
    stdin.write("2"); // switch to the Turns tab
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("#1"); // a turn headline row
    expect(frame).toContain("cache"); // token annotation on collapsed turn rows
    expect(frame).not.toContain("Bash"); // steps hidden while turns are collapsed
    unmount();
  });

  test("expanding turns reveals their step operations", async () => {
    const { stdin, lastFrame, unmount } = render(
      <SessionDetailScreen session={session} pricing={pricing} isActive onBack={() => {}} />,
    );
    await wait();
    stdin.write("2"); // Turns tab
    await wait();
    stdin.write("G"); // jump cursor to the last turn (has the Bash step)
    await wait();
    stdin.write("\r"); // expand it
    await wait();
    stdin.write("g"); // back to the first turn (has Assistant narration + Write)
    await wait();
    stdin.write("\r"); // expand it
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Write"); // an edit operation step
    expect(frame).toContain("Bash"); // a run operation step
    expect(frame).toContain("Assistant"); // narration step
    unmount();
  });

  test("expanding a step reveals its detail", async () => {
    const { stdin, lastFrame, unmount } = render(
      <SessionDetailScreen session={session} pricing={pricing} isActive onBack={() => {}} />,
    );
    await wait();
    stdin.write("2"); // Turns tab
    await wait();
    stdin.write("\r"); // expand the first turn
    await wait();
    stdin.write("j"); // move cursor down onto a step row
    await wait();
    stdin.write("\r"); // expand that step's detail
    await wait();
    const frame = lastFrame() ?? "";
    // The detail block renders an "input:" or "full text:"/"result:" label.
    expect(frame).toMatch(/input:|result:|full text:/);
    unmount();
  });

  test("transcript items collapse and expand", async () => {
    const { stdin, lastFrame, unmount } = render(
      <SessionDetailScreen session={session} pricing={pricing} isActive onBack={() => {}} />,
    );
    await wait();
    stdin.write("3"); // Transcript tab
    await wait();
    const collapsed = lastFrame() ?? "";
    expect(collapsed).toContain("▸"); // collapsed chevron on an item with a body
    stdin.write("\r"); // expand the item under the cursor
    await wait();
    expect(lastFrame() ?? "").toContain("▾"); // now expanded
    unmount();
  });
});
