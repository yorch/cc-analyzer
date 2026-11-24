/**
 * The ONE redaction path for session exports.
 *
 * Bun-free and pure. Every surface that emits a shareable session (CLI
 * `analyze --redact` / `export`, the TUI export, `GET /api/sessions/:id/export`,
 * the markdown/HTML builders) goes through `redactAnalysis()` /
 * `buildSessionJsonPayload()` so what "redacted" means cannot drift between
 * them (it did, four times over, before this module existed).
 *
 * Allowlist-minded: the redactor is a generic deep walk, not a list of fields
 * to blank. Numbers, booleans and structure survive; a *string* survives only
 * when its key is in `REDACT_KEPT_STRING_KEYS` (tool names, model ids,
 * timestamps, enum-like fields); a record's *keys* survive only for the
 * records in `REDACT_KEPT_RECORD_KEYS` (model ids, tool names, stop reasons,
 * permission modes). Everything else — including a string field added to
 * `SessionAnalysis` next year — is replaced by `REDACTED`. Records whose keys
 * are command text (`bashCommands`…) are emptied; skill names are anonymized
 * (`skill-1`, …) because they are user-authored config.
 *
 * A new *record-typed* field whose keys are free text must be added to
 * `REDACT_DROPPED_KEYS` (or the anonymized set); the canary test in
 * `test/core/redact.test.ts` fails if a fixture string survives anywhere
 * outside the lists below.
 */

import type { SessionAnalysis } from "./analyze.ts";
import type { CostBasis } from "./cost-framing.ts";
import type { SessionHealthReport } from "./session-health.ts";
import type { SessionCostRank, WhatIfRepricing } from "./stats-types.ts";
import type { TranscriptItem } from "./transcript.ts";

export const REDACTED = "[redacted]";

/** Transcript caps, centralized so every surface truncates identically. */
export const TRANSCRIPT_MAX_ITEMS = 600;
export const TRANSCRIPT_MAX_BODY_CHARS = 2000;

/**
 * Keys whose string values are tool/model/enum/timestamp identifiers — not
 * session text. Arrays of strings under these keys are kept too (`models`,
 * `versions`, `subagents`).
 */
export const REDACT_KEPT_STRING_KEYS: ReadonlySet<string> = new Set([
  "sessionId",
  "model",
  "models",
  "tool",
  "kind",
  "label",
  "status",
  "role",
  "stopReason",
  "trigger",
  "timestamp",
  "startTime",
  "endTime",
  "permissionMode",
  "subagentType",
  "subagents",
  "versions",
]);

/**
 * Records whose KEYS are identifiers (model ids, tool names, enums). Keys of
 * objects are preserved by the walk (typed objects have fixed keys); this list
 * names the identifier-keyed records so the canary test can tell them apart
 * from free-text-keyed ones, which must be in `REDACT_DROPPED_KEYS`.
 */
export const REDACT_KEPT_RECORD_KEYS: ReadonlySet<string> = new Set([
  "models",
  "tools",
  "toolErrors",
  "toolCounts",
  "retriesByTool",
  "stopReasons",
  "permissionModes",
]);

/** Records keyed by free text (command heads…): emptied wholesale. */
export const REDACT_DROPPED_KEYS: ReadonlySet<string> = new Set([
  "bashCommands",
  "bashErrors",
  "commandHeads",
  "commandHeadErrors",
]);

/** Records keyed by user-authored skill names: keys become `skill-N`. */
const SKILL_RECORD_KEYS: ReadonlySet<string> = new Set(["skills", "skillErrors", "skillTurnCosts"]);

/** Object keys removed outright (full tool input/result bodies). */
const OMITTED_KEYS: ReadonlySet<string> = new Set(["detail"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function scrub(
  value: unknown,
  key: string,
  skillNames: Map<string, string>,
  safe: ReadonlySet<string> = REDACT_KEPT_STRING_KEYS,
): unknown {
  if (typeof value === "string") return safe.has(key) ? value : REDACTED;
  if (Array.isArray(value)) return value.map((v) => scrub(v, key, skillNames, safe));
  if (!isPlainObject(value)) return value; // number | boolean | null | undefined
  if (REDACT_DROPPED_KEYS.has(key)) return {};
  const out: Record<string, unknown> = {};
  if (SKILL_RECORD_KEYS.has(key)) {
    for (const [k, v] of Object.entries(value)) {
      out[skillNames.get(k) ?? "skill-?"] = scrub(v, k, skillNames, safe);
    }
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    if (OMITTED_KEYS.has(k)) continue;
    out[k] = scrub(v, k, skillNames, safe);
  }
  return out;
}

/**
 * Deep-cloned copy of `analysis` safe to share: numeric metrics, structure,
 * tool names, model ids and timestamps survive; every free-text, path,
 * command, branch, title, prompt, summary and result field is replaced by
 * `REDACTED`. Arrays of redacted strings keep their length (so "files
 * touched: 12" still reads), the strings themselves are placeholders. The
 * input is never mutated.
 */
export function redactAnalysis(analysis: SessionAnalysis): SessionAnalysis {
  const names = new Set<string>();
  for (const k of SKILL_RECORD_KEYS) {
    const rec = (analysis as unknown as Record<string, unknown>)[k];
    if (isPlainObject(rec)) for (const n of Object.keys(rec)) names.add(n);
  }
  const skillNames = new Map<string, string>(
    [...names].sort().map((n, i) => [n, `skill-${i + 1}`] as [string, string]),
  );
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(analysis as unknown as Record<string, unknown>)) {
    out[k] = scrub(v, k, skillNames);
  }
  return out as unknown as SessionAnalysis;
}

/** Extra string keys that are dates / model ids / enums in portfolio aggregates. */
const AGGREGATE_SAFE_KEYS: ReadonlySet<string> = new Set([
  ...REDACT_KEPT_STRING_KEYS,
  "firstDay",
  "lastDay",
  "day",
  "month",
  "prevMonth",
  "week",
  "session_id",
  "start_time",
  "end_time",
  "mode",
  "reason",
]);

/**
 * Same allowlist walk for a portfolio/project aggregate payload (stats rows):
 * numbers and dates survive, every other string (project paths, titles, command
 * heads, skill names) becomes `REDACTED`. Callers should still pick the
 * sections they emit — this is the safety net, not the selection.
 */
export function redactAggregate<T>(value: T): T {
  return scrub(value, "", new Map(), AGGREGATE_SAFE_KEYS) as T;
}

/** Cap a transcript at the shared item/body limits (never mutates the input). */
export function capTranscript(items: readonly TranscriptItem[]): TranscriptItem[] {
  return items
    .slice(0, TRANSCRIPT_MAX_ITEMS)
    .map((t) => ({ ...t, body: t.body.slice(0, TRANSCRIPT_MAX_BODY_CHARS) }));
}

/** Transcript with every body blanked (labels are tool names / fixed words). */
export function redactTranscript(items: readonly TranscriptItem[]): TranscriptItem[] {
  return items.map((t) => ({ ...t, body: REDACTED }));
}

export interface SessionJsonPayloadOptions {
  redact?: boolean;
  includeTranscript?: boolean;
  /** Raw (uncapped) transcript; the builder caps and, when redacting, blanks it. */
  transcript?: readonly TranscriptItem[];
  /** Number of unparseable lines (`parsed.errors.length`). Always emitted. */
  parseErrors?: number;
  health?: SessionHealthReport;
  whatIf?: WhatIfRepricing;
  rank?: SessionCostRank | null;
  costBasis?: CostBasis;
}

/**
 * The exact JSON-able object every surface emits for one session, so CLI,
 * TUI and web exports are byte-identical for the same inputs.
 */
export function buildSessionJsonPayload(
  analysis: SessionAnalysis,
  opts: SessionJsonPayloadOptions = {},
): Record<string, unknown> {
  const redact = opts.redact === true;
  const base = redact ? redactAnalysis(analysis) : analysis;
  const payload: Record<string, unknown> = {
    ...base,
    parseErrors: opts.parseErrors ?? 0,
    health: opts.health,
    whatIf: opts.whatIf,
    rank: opts.rank,
    costBasis: opts.costBasis,
  };
  if (opts.includeTranscript && opts.transcript) {
    const capped = capTranscript(opts.transcript);
    payload.transcript = redact ? redactTranscript(capped) : capped;
  }
  return payload;
}
