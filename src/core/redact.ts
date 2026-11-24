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

/** Built-in agent types / tools that are product vocabulary, not user config. */
export const BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set([
  "general-purpose",
  "Explore",
  "Plan",
  "statusline-setup",
  "output-style-setup",
  "claude-code-guide",
  "Task",
  "Agent",
  "Read",
  "Bash",
  "Edit",
  "Write",
  "Grep",
  "Glob",
]);

/** Compaction triggers Claude Code writes. */
export const KNOWN_COMPACT_TRIGGERS: ReadonlySet<string> = new Set(["auto", "manual"]);
/** Anthropic API stop reasons. */
export const KNOWN_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_turn",
  "tool_use",
  "max_tokens",
  "stop_sequence",
  "pause_turn",
  "refusal",
]);
/** Claude Code permission modes. */
export const KNOWN_PERMISSION_MODES: ReadonlySet<string> = new Set([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "auto",
  "dontAsk",
]);

/** Enum-ish string keys validated against a known-values set (else REDACTED). */
const ENUM_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  trigger: KNOWN_COMPACT_TRIGGERS,
  stopReason: KNOWN_STOP_REASONS,
  permissionMode: KNOWN_PERMISSION_MODES,
};
/** Records keyed by enum values: key validated like the string form. */
const ENUM_RECORD_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  stopReasons: KNOWN_STOP_REASONS,
  permissionModes: KNOWN_PERMISSION_MODES,
};
/** Records keyed by tool names (MCP server segment is anonymized). */
const TOOL_RECORD_KEYS: ReadonlySet<string> = new Set([
  "tools",
  "toolErrors",
  "toolCounts",
  "retriesByTool",
]);
const VERSION_PATTERN = /^\d+\.\d+\.\d+/;
const MCP_TOOL = /^mcp__(.+?)__(.+)$/;

/** Stable anonymization of user-authored names within one redaction pass. */
interface Names {
  skills: Map<string, string>;
  mcp: Map<string, string>;
  agents: Map<string, string>;
}

function emptyNames(): Names {
  return { skills: new Map(), mcp: new Map(), agents: new Map() };
}

function alias(map: Map<string, string>, name: string, prefix: string): string {
  let v = map.get(name);
  if (v === undefined) {
    v = `${prefix}-${map.size + 1}`;
    map.set(name, v);
  }
  return v;
}

/** `mcp__<server>__<tool>` -> `mcp__mcp-server-N__<tool>`; other names unchanged. */
function anonTool(name: string, names: Names): string {
  const m = MCP_TOOL.exec(name);
  if (!m) return name;
  return `mcp__${alias(names.mcp, m[1] as string, "mcp-server")}__${m[2]}`;
}

function anonAgent(name: string, names: Names): string {
  return BUILTIN_AGENT_TYPES.has(name) ? name : alias(names.agents, name, "agent");
}

function safeString(value: string, key: string, names: Names): string {
  const enumSet = ENUM_KEYS[key];
  if (enumSet) return enumSet.has(value) ? value : REDACTED;
  if (key === "version" || key === "versions")
    return VERSION_PATTERN.test(value) ? value : REDACTED;
  if (key === "subagentType" || key === "subagents") return anonAgent(value, names);
  return anonTool(value, names);
}

function addTo(out: Record<string, unknown>, k: string, v: unknown): void {
  const prev = out[k];
  out[k] = typeof prev === "number" && typeof v === "number" ? prev + v : v;
}

function scrub(
  value: unknown,
  key: string,
  names: Names,
  safe: ReadonlySet<string> = REDACT_KEPT_STRING_KEYS,
): unknown {
  if (typeof value === "string") return safe.has(key) ? safeString(value, key, names) : REDACTED;
  if (Array.isArray(value)) return value.map((v) => scrub(v, key, names, safe));
  if (!isPlainObject(value)) return value; // number | boolean | null | undefined
  if (REDACT_DROPPED_KEYS.has(key)) return {};
  const out: Record<string, unknown> = {};
  if (SKILL_RECORD_KEYS.has(key)) {
    for (const [k, v] of Object.entries(value)) {
      out[names.skills.get(k) ?? "skill-?"] = scrub(v, k, names, safe);
    }
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    if (OMITTED_KEYS.has(k)) continue;
    const enumSet = ENUM_RECORD_KEYS[key];
    let outKey = k;
    if (enumSet) outKey = enumSet.has(k) ? k : REDACTED;
    else if (TOOL_RECORD_KEYS.has(key)) outKey = anonTool(k, names);
    addTo(out, outKey, scrub(v, k, names, safe));
  }
  return out;
}

/** Collect MCP server / agent names so aliases are numbered deterministically. */
function collectNames(value: unknown, key: string, mcp: Set<string>, agents: Set<string>): void {
  if (typeof value === "string") {
    const m = MCP_TOOL.exec(value);
    if (m) mcp.add(m[1] as string);
    if (key === "subagentType" || key === "subagents") agents.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectNames(v, key, mcp, agents);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [k, v] of Object.entries(value)) {
    const m = MCP_TOOL.exec(k);
    if (m && TOOL_RECORD_KEYS.has(key)) mcp.add(m[1] as string);
    collectNames(v, k, mcp, agents);
  }
}

/**
 * Deep-cloned copy of `analysis` safe to share: numeric metrics, structure,
 * tool names, model ids and timestamps survive; every free-text, path,
 * command, branch, title, prompt, summary and result field is replaced by
 * `REDACTED`. User-authored config names are anonymized: skills (`skill-N`),
 * MCP servers inside tool names (`mcp__mcp-server-N__tool`) and custom
 * subagent types (`agent-N`; built-ins stay). Enum-ish strings (compaction
 * trigger, stop reason, permission mode, version) survive only when they match
 * known values. Arrays of redacted strings keep their length. The input is
 * never mutated.
 */
export function redactAnalysis(analysis: SessionAnalysis): SessionAnalysis {
  const skillSet = new Set<string>();
  for (const k of SKILL_RECORD_KEYS) {
    const rec = (analysis as unknown as Record<string, unknown>)[k];
    if (isPlainObject(rec)) for (const n of Object.keys(rec)) skillSet.add(n);
  }
  const mcpSet = new Set<string>();
  const agentSet = new Set<string>();
  collectNames(analysis, "", mcpSet, agentSet);
  const names = emptyNames();
  names.skills = new Map(
    [...skillSet].sort().map((n, i) => [n, `skill-${i + 1}`] as [string, string]),
  );
  for (const n of [...mcpSet].sort()) alias(names.mcp, n, "mcp-server");
  for (const n of [...agentSet].filter((x) => !BUILTIN_AGENT_TYPES.has(x)).sort())
    alias(names.agents, n, "agent");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(analysis as unknown as Record<string, unknown>)) {
    out[k] = scrub(v, k, names);
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
  return scrub(value, "", emptyNames(), AGGREGATE_SAFE_KEYS) as T;
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
