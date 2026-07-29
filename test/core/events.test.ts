import { describe, expect, test } from "bun:test";
import { isCorrectionPrompt, isInterruptionMarker } from "../../src/core/events.ts";

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

describe("isCorrectionPrompt", () => {
  test("each marker family fires at a prompt start", () => {
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
      // Miscommunication.
      "that's not what I meant at all",
      "hmm, I meant the staging config",
      "I didn't mean delete it",
      "you misunderstood the requirement",
      // Non-working outcome.
      "still broken after that change",
      "the test is still failing",
      "that didn't work",
      "it doesn't work on Windows",
      "the button is not working",
      "same error as before",
      // Re-ask.
      "try again with the real path",
      "do it again but keep the comments",
      "as I said, only the CLI needs it",
      "like I asked, use tabs",
    ];
    for (const p of positives) expect(isCorrectionPrompt(p)).toBe(true);
  });

  test("a marker buried mid-sentence or without its anchor does not fire", () => {
    expect(isCorrectionPrompt("there is no config file yet")).toBe(false);
    expect(isCorrectionPrompt("no tests needed for this one")).toBe(false); // bare "no" + noun
    expect(isCorrectionPrompt("add a wrong-answer handler")).toBe(false);
    expect(isCorrectionPrompt("implement the undo stack")).toBe(false); // "undo" without object
    expect(isCorrectionPrompt("write docs for the revert command")).toBe(false);
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
