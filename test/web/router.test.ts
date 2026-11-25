import { describe, expect, test } from "bun:test";
import { resolveHashParam } from "../../web/src/router.ts";

const VIEWS = ["tools", "agents", "compactions"] as const;

describe("resolveHashParam", () => {
  test("reads a permitted value", () => {
    expect(resolveHashParam("#/tools?view=agents", "view", "tools", VIEWS)).toBe("agents");
  });
  test("falls back when absent, disallowed, or without a query", () => {
    expect(resolveHashParam("#/tools", "view", "tools", VIEWS)).toBe("tools");
    expect(resolveHashParam("#/tools?view=nope", "view", "tools", VIEWS)).toBe("tools");
    expect(resolveHashParam("#/tools?q=x", "view", "tools", VIEWS)).toBe("tools");
  });
  test("is independent of the allowed array's identity", () => {
    const a = resolveHashParam("#/t?view=agents", "view", "tools", [...VIEWS]);
    const b = resolveHashParam("#/t?view=agents", "view", "tools", [...VIEWS]);
    expect(a).toBe(b);
  });
  test("without an allow-list any value passes; picks the right key", () => {
    expect(resolveHashParam("#/p?q=hi&view=x", "q", "")).toBe("hi");
  });
});
