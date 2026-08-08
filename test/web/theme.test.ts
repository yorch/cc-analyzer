import { describe, expect, test } from "bun:test";
import { normalizeThemePref, resolveTheme, THEME_PREFS } from "../../web/src/theme.ts";

describe("normalizeThemePref", () => {
  test("keeps the three known preferences", () => {
    expect(normalizeThemePref("system")).toBe("system");
    expect(normalizeThemePref("light")).toBe("light");
    expect(normalizeThemePref("dark")).toBe("dark");
  });

  test("coerces null/unknown to system", () => {
    expect(normalizeThemePref(null)).toBe("system");
    expect(normalizeThemePref(undefined)).toBe("system");
    expect(normalizeThemePref("")).toBe("system");
    expect(normalizeThemePref("Light")).toBe("system");
    expect(normalizeThemePref(42)).toBe("system");
  });

  test("THEME_PREFS lists exactly the normalizable values, in display order", () => {
    expect(THEME_PREFS).toEqual(["system", "light", "dark"]);
    for (const p of THEME_PREFS) expect(normalizeThemePref(p)).toBe(p);
  });
});

describe("resolveTheme", () => {
  test("an explicit choice ignores the OS preference", () => {
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("system defers to the OS preference", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
  });
});
