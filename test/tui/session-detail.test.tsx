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
  startTime: null,
  turns: 2,
  apiCalls: 3,
  toolCalls: 2,
  mtimeMs: 0,
};

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));

describe("SessionDetailScreen (smoke)", () => {
  test("turns tab renders the step timeline with tool operations", async () => {
    const { stdin, lastFrame, unmount } = render(
      <SessionDetailScreen session={session} pricing={pricing} isActive onBack={() => {}} />,
    );
    await wait(); // allow the async parse+analyze to settle
    stdin.write("2"); // switch to the Turns tab
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Write"); // an edit operation step
    expect(frame).toContain("Bash"); // a run operation step
    expect(frame).toContain("Assistant"); // narration step
    unmount();
  });
});
