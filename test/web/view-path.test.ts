import { describe, expect, test } from "bun:test";
import { viewPath } from "../../web/src/view-path.ts";

describe("viewPath (analytics url sanitization)", () => {
  test("maps each view to a stable path", () => {
    expect(viewPath("dashboard")).toBe("/");
    expect(viewPath("insights")).toBe("/insights");
    expect(viewPath("insightsProject")).toBe("/insights/project");
    expect(viewPath("trends")).toBe("/trends");
    expect(viewPath("tools")).toBe("/tools");
    expect(viewPath("project")).toBe("/project");
    expect(viewPath("session")).toBe("/session");
  });

  test("unknown routes fall back to root (never echo raw input)", () => {
    expect(viewPath("something-else")).toBe("/");
    expect(viewPath("")).toBe("/");
  });

  // The core guarantee: id-bearing routes must map to a FIXED path that carries
  // only the view type — the id is not appended, so no session UUID or project
  // path can reach Plausible regardless of which record is open.
  test("id-bearing routes map to a fixed, id-free path", () => {
    const uuid = "0af1e2d3-1234-5678-9abc-def012345678";
    const projectId = "-Users-yorch-code-personal-secret";
    // viewPath takes only the route NAME, never the id — so the output is
    // constant no matter the id, and the id can't appear in it.
    expect(viewPath("session")).toBe("/session");
    expect(viewPath("session")).not.toContain(uuid);
    expect(viewPath("project")).toBe("/project");
    expect(viewPath("project")).not.toContain(projectId);
    expect(viewPath("insightsProject")).toBe("/insights/project");
  });
});
