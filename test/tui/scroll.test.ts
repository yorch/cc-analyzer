import { describe, expect, test } from "bun:test";
import { scrollOffset } from "../../src/tui/scroll.ts";

describe("scrollOffset", () => {
  const size = 5;

  test("cursor inside the window leaves the offset unchanged", () => {
    expect(scrollOffset(3, 0, size)).toBe(0);
    expect(scrollOffset(4, 0, size)).toBe(0); // last visible row (offset+size-1)
  });

  test("cursor past the bottom edge scrolls down by one", () => {
    expect(scrollOffset(5, 0, size)).toBe(1); // next − size + 1
    expect(scrollOffset(9, 3, size)).toBe(5);
  });

  test("cursor above the top edge scrolls up to the cursor", () => {
    expect(scrollOffset(2, 5, size)).toBe(2);
    expect(scrollOffset(0, 3, size)).toBe(0);
  });

  test("jumping to the last row shows a full trailing window", () => {
    // total = 20, jump cursor to 19 from the top → window ends at 19
    expect(scrollOffset(19, 0, size)).toBe(15); // 19 − 5 + 1
  });

  test("jumping to the top row resets the offset to 0", () => {
    expect(scrollOffset(0, 15, size)).toBe(0);
  });
});
