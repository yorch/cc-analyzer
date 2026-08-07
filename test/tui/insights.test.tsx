import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { openDb } from "../../src/core/db.ts";
import { InsightsView } from "../../src/tui/screens/InsightsView.tsx";
import { cheapPricing, flatPricing, samplePricing } from "../helpers/pricing.ts";
import { insertSession } from "../helpers/sessions.ts";
import { waitForFrame } from "../helpers/tui.ts";

function insert(
  db: Database,
  path: string,
  project: string,
  projectPath: string,
  w: number,
  r: number,
  cw: number,
): void {
  insertSession(db, {
    path,
    project_id: project,
    project_path: projectPath,
    cache_write_5m: w,
    cache_read: r,
    cost_cache_write: cw,
    cost_cache_read: 0.1,
    cost_input: 1,
    cost_output: 1,
    cost_total: cw + 2.1,
  });
}

let db: Database;
beforeAll(() => {
  db = openDb(":memory:");
  insert(db, "leaky-1", "p-leaky", "/p/leaky", 1000, 100, 10); // waste ~$9, ratio 0.1
  insert(db, "eff-1", "p-eff", "/p/eff", 1000, 3000, 10); // waste $0, ratio 3
});

const noop = () => {};

describe("InsightsView", () => {
  test("ranks projects by waste and previews the leader's breakdown", () => {
    const { lastFrame, unmount } = render(
      <InsightsView
        db={db}
        pricing={samplePricing}
        columns={120}
        pageSize={20}
        isActive={false}
        onOpenSession={noop}
        onBack={noop}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("un-amortized"); // header + preview
    expect(frame).toContain("/p/leaky"); // worst offender listed first
    expect(frame).toContain("leaky"); // verdict on the highlighted (leaky) project
    unmount();
  });

  test("enter drills into the project's sessions", async () => {
    const { stdin, lastFrame, unmount } = render(
      <InsightsView
        db={db}
        pricing={samplePricing}
        columns={120}
        pageSize={20}
        isActive
        onOpenSession={noop}
        onBack={noop}
      />,
    );
    await waitForFrame(lastFrame, "/p/leaky"); // ranked list rendered before drilling
    stdin.write("\r"); // drill into the top project (p-leaky)
    await waitForFrame(lastFrame, "leaky-1");
    expect(lastFrame() ?? "").toContain("leaky-1"); // its session now listed
    unmount();
  });

  test("filter reaches projects beyond the rules' top-50 waste slice", async () => {
    const wide = openDb(":memory:");
    // 55 cache-active projects with strictly decreasing waste; "needle" ranks
    // last, past the default 50-row slice the signals assembler uses for the
    // rules — the screen's own full-width query must still surface it.
    for (let i = 0; i < 55; i++) {
      insert(wide, `s-${i}`, `p-${i}`, `/p/many-${i}`, 1000, 100, 55 - i);
    }
    insert(wide, "s-needle", "p-needle", "/p/needle", 1000, 100, 0.05);
    const { stdin, lastFrame, unmount } = render(
      <InsightsView
        db={wide}
        pricing={samplePricing}
        columns={120}
        pageSize={20}
        isActive
        onOpenSession={noop}
        onBack={noop}
      />,
    );
    await waitForFrame(lastFrame, "/p/many-0");
    expect(lastFrame() ?? "").not.toContain("/p/needle"); // off the first page
    stdin.write("needle"); // type-to-filter
    await waitForFrame(lastFrame, "/p/needle");
    expect(lastFrame() ?? "").toContain("/p/needle");
    unmount();
    wide.close();
  });

  test("header lists fired portfolio findings as glyph + title lines", () => {
    const wasteful = openDb(":memory:");
    // One project wasting $18 of $20 cache-write spend — over both the 20%
    // share and the $10 floor of the cache-waste-heavy rule, so a warning
    // finding must appear in the compact header block.
    insert(wasteful, "w-1", "p-waste", "/p/waste", 10_000, 100, 20);
    const { lastFrame, unmount } = render(
      <InsightsView
        db={wasteful}
        pricing={samplePricing}
        columns={140}
        pageSize={20}
        isActive={false}
        onOpenSession={noop}
        onBack={noop}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("! "); // warning glyph
    expect(frame).toContain("never amortized"); // cache-waste-heavy title
    unmount();
    wasteful.close();
  });

  test("summarizes context tax and the cheapest single model", () => {
    const priced = openDb(":memory:");
    // Two sessions, baselines 20k and 40k → median 30k.
    for (const [path, baseline] of [
      ["ctx-1", 20_000],
      ["ctx-2", 40_000],
    ] as const) {
      insertSession(priced, {
        path,
        project_id: "p-heavy",
        project_path: "/p/heavy",
        cost_total: 10,
        first_prompt_tokens: baseline,
        models_json: JSON.stringify({
          "claude-opus-4-7": {
            apiCalls: 5,
            cost: { total: 10 },
            tokens: { inputTokens: 1_000_000, outputTokens: 0 },
          },
        }),
      });
    }
    const { lastFrame, unmount } = render(
      <InsightsView
        db={priced}
        // opus at 10× the cheap model's input rate → repricing must show savings.
        pricing={{ "claude-opus-4-7": flatPricing, "claude-haiku-4-5": cheapPricing }}
        columns={140}
        pageSize={20}
        isActive={false}
        onOpenSession={noop}
        onBack={noop}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("context tax");
    expect(frame).toContain("30.0k"); // median baseline
    expect(frame).toContain("what-if");
    expect(frame).toContain("claude-haiku-4-5"); // cheapest single model
    unmount();
    priced.close();
  });
});
