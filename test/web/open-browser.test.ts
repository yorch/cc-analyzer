import { describe, expect, test } from "bun:test";
import { browserCommand } from "../../src/web/open-browser.ts";

describe("browserCommand", () => {
  const url = "http://localhost:4317";

  test("uses the native opener on supported platforms", () => {
    expect(browserCommand(url, "darwin")).toEqual(["open", url]);
    expect(browserCommand(url, "linux")).toEqual(["xdg-open", url]);
    expect(browserCommand(url, "win32")).toEqual(["cmd", "/c", "start", "", url]);
  });

  test("returns undefined on unsupported platforms", () => {
    expect(browserCommand(url, "aix")).toBeUndefined();
  });
});
