import { describe, expect, test } from "bun:test";
import { type ClipboardHost, copyText } from "../../web/src/clipboard.ts";

describe("copyText", () => {
  test("writes through a working clipboard and reports success", async () => {
    const written: string[] = [];
    const host: ClipboardHost = {
      clipboard: {
        writeText: async (text) => {
          written.push(text);
        },
      },
    };
    expect(await copyText("# digest", host)).toBe(true);
    expect(written).toEqual(["# digest"]);
  });

  // The regression: `serve --host 0.0.0.0` is plain http, so a phone on the LAN
  // has no `navigator.clipboard` at all. Reaching into it used to throw a
  // synchronous TypeError that no `.catch()` could absorb.
  test("reports failure instead of throwing when the API is absent", async () => {
    expect(await copyText("x", {})).toBe(false);
    expect(await copyText("x", undefined)).toBe(false);
    expect(await copyText("x", { clipboard: {} })).toBe(false);
  });

  test("a rejected write is a failure, not an unhandled rejection", async () => {
    const host: ClipboardHost = {
      clipboard: { writeText: () => Promise.reject(new Error("permission denied")) },
    };
    expect(await copyText("x", host)).toBe(false);
  });
});
