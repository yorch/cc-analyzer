import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  CORRECTION_PATTERN_SOURCE,
  isCorrectionPrompt,
  isInterruptionEvent,
  isInterruptionMarker,
} from "../../src/core/events.ts";

describe("isInterruptionMarker", () => {
  test("matches both observed marker strings, tolerating leading whitespace", () => {
    expect(isInterruptionMarker("[Request interrupted by user]")).toBe(true);
    expect(isInterruptionMarker("[Request interrupted by user for tool use]")).toBe(true);
    expect(isInterruptionMarker("  [Request interrupted by user]")).toBe(true);
  });

  test("does not match ordinary prompts or mentions of the marker", () => {
    expect(isInterruptionMarker("please continue")).toBe(false);
    expect(isInterruptionMarker('the log says "[Request interrupted by user]"')).toBe(false);
    expect(isInterruptionMarker("[request interrupted by user]")).toBe(false); // markers are verbatim
  });
});

describe("isInterruptionEvent", () => {
  test("matches string, text-block, and nested tool-result markers", () => {
    const event = (content: unknown) =>
      ({
        type: "user",
        message: { role: "user", content },
      }) as Parameters<typeof isInterruptionEvent>[0];
    expect(isInterruptionEvent(event("[Request interrupted by user]"))).toBe(true);
    expect(
      isInterruptionEvent(
        event([{ type: "text", text: "[Request interrupted by user for tool use]" }]),
      ),
    ).toBe(true);
    expect(
      isInterruptionEvent(
        event([
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "text", text: "[Request interrupted by user]" }],
          },
        ]),
      ),
    ).toBe(true);
  });

  test("does not match ordinary prompts or tool results", () => {
    const event = (content: unknown) =>
      ({
        type: "user",
        message: { role: "user", content },
      }) as Parameters<typeof isInterruptionEvent>[0];
    expect(isInterruptionEvent(event("continue"))).toBe(false);
    expect(
      isInterruptionEvent(
        event([{ type: "tool_result", tool_use_id: "t1", content: "completed" }]),
      ),
    ).toBe(false);
  });
});

describe("isCorrectionPrompt", () => {
  test("outcome markers fire anywhere in the opening window", () => {
    const positives = [
      "that's not what I meant at all",
      "hold on — that's not what I asked for",
      "sorry, that is not what I wanted",
      "I didn't mean delete it",
      "I think you misunderstood the requirement",
      "still broken after that change",
      "the test is still failing",
      "it's still not working on CI",
      "that didn't work",
      "it doesn't work on Windows",
      "same error as before",
    ];
    for (const p of positives) expect(isCorrectionPrompt(p)).toBe(true);
  });

  test("imperative markers fire only when the prompt opens with them", () => {
    const positives = [
      // Leading rejection (needs the punctuation after no/nope).
      "no, use the other file",
      "Nope. that broke the build",
      "not that one, the second table",
      "wrong — I wanted the async version",
      // Undo/redo.
      "undo that last edit",
      "please revert that change",
      "roll that back and try the flag instead",
      "go back to the previous approach",
      "I meant the staging config",
      // Non-working outcome, bare form.
      "not working — the button does nothing",
      "it's not working after the rebase",
      // Re-ask.
      "try again with the real path",
      "do it again but keep the comments",
      "as I said, only the CLI needs it",
      "like I asked, use tabs",
    ];
    for (const p of positives) expect(isCorrectionPrompt(p)).toBe(true);
  });

  test("the same imperative markers mid-prompt are ordinary product language", () => {
    const negatives = [
      "add a back button so users can go back to the list view",
      "if the request fails, try again with exponential backoff",
      "show an error banner when the network is not working",
      "explain how to roll that back before we ship",
      "we should do it again next quarter",
      "the plan, as I said in the ticket, is still fine",
      "ship it like I asked the team to spec it",
      "hmm, I meant to write that down somewhere else",
      "the docs say to undo that migration first",
      "use anything but not that column",
    ];
    for (const p of negatives) expect(isCorrectionPrompt(p)).toBe(false);
  });

  test("a marker buried mid-sentence or without its anchor does not fire", () => {
    expect(isCorrectionPrompt("there is no config file yet")).toBe(false);
    expect(isCorrectionPrompt("no tests needed for this one")).toBe(false); // bare "no" + noun
    expect(isCorrectionPrompt("add a wrong-answer handler")).toBe(false);
    expect(isCorrectionPrompt("implement the undo stack")).toBe(false); // "undo" without object
    expect(isCorrectionPrompt("write docs for the revert command")).toBe(false);
  });

  test("a hyphen after no/nope is a compound word, not a rejection", () => {
    expect(isCorrectionPrompt("No-op the migration for now")).toBe(false);
    expect(isCorrectionPrompt("no-cache headers on the API responses")).toBe(false);
    expect(isCorrectionPrompt("nope-ish naming is fine")).toBe(false);
    // The em-dash form is still a rejection.
    expect(isCorrectionPrompt("no — the other file")).toBe(true);
  });

  test("slash commands and machine-looking prompts never match", () => {
    expect(isCorrectionPrompt("/clear")).toBe(false);
    expect(isCorrectionPrompt("/compact no, wait")).toBe(false);
    expect(isCorrectionPrompt("<command-name>no, undo that</command-name>")).toBe(false);
    expect(isCorrectionPrompt("[Request interrupted by user]")).toBe(false);
  });

  test("markers past the 120-character window do not fire", () => {
    const padding = "please write a detailed summary of the meeting notes from tuesday ".repeat(2);
    expect(padding.length).toBeGreaterThan(120);
    expect(isCorrectionPrompt(`${padding} that's not what i meant`)).toBe(false);
    // The same phrase inside the window does fire.
    expect(isCorrectionPrompt("hold on — that's not what I meant")).toBe(true);
  });

  test("matching is case-insensitive", () => {
    expect(isCorrectionPrompt("NO, THE OTHER ONE")).toBe(true);
    expect(isCorrectionPrompt("STILL BROKEN")).toBe(true);
    expect(isCorrectionPrompt("Try Again")).toBe(true);
  });
});

describe("CORRECTION_PATTERN_SOURCE", () => {
  // Pinning test. `isCorrectionPrompt` runs at INDEX time and only its verdict
  // survives, in the `correction_turns` column — so editing the pattern list
  // silently leaves already-indexed sessions judged by the old heuristic.
  //
  // IF THIS FAILS YOU CHANGED THE CORRECTION HEURISTIC — bump SCHEMA_VERSION in
  // db.ts so indexed correction_turns get rebuilt, then update this constant.
  test("the baked pattern list is pinned to the indexed schema", () => {
    const digest = createHash("sha256")
      .update(CORRECTION_PATTERN_SOURCE.join("\n"))
      .digest("hex")
      .slice(0, 16);
    expect(digest).toBe("043e008d156800f8");
  });
});
