/**
 * Pure cost-basis framing strings, shared by the CLI, TUI, and web SPA.
 *
 * cc-analyzer always *derives* dollar figures the same way — token counts ×
 * API rates (see "Cost is derived, not stored" in AGENTS.md). For an API-key
 * user that number approximates a real bill. Most Claude Code users are on a
 * flat subscription (Pro/Max) though, where those same dollars are
 * API-equivalent value — what the usage would have cost at API rates, not
 * money owed. `CostBasis` is a display preference only: it never changes how
 * a number is computed, only how it is framed. Bun-free so the web SPA
 * renders the exact same wording as the CLI/TUI.
 */

export type CostBasis = "api" | "subscription";

/** One canonical sentence. Every surface renders this verbatim — no per-surface
 *  rewording — so the framing can't drift between the CLI, TUI, and web. */
const SUBSCRIPTION_NOTE =
  "Flat-plan subscription: dollar figures are API-equivalent value — what this usage would " +
  "cost at API rates — not a bill.";

/** The framing note for a basis, or `undefined` when none is needed (an
 *  API-key user's dollars already read as a bill, so there's nothing extra to
 *  say). Callers render the note only when it's defined. */
export function costFramingNote(basis: CostBasis): string | undefined {
  return basis === "subscription" ? SUBSCRIPTION_NOTE : undefined;
}

/** Short noun for a headline dollar figure, matching the basis. */
export function costNoun(basis: CostBasis): string {
  return basis === "subscription" ? "API-equivalent value" : "spend";
}
