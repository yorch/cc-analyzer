import { z } from "zod";

/**
 * Tolerant Zod schemas for Claude Code session JSONL records.
 *
 * Every object schema is `loose` so unknown / future fields are preserved
 * rather than stripped — newer Claude Code versions must never break parsing.
 */

export const usageSchema = z.looseObject({
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation: z
    .looseObject({
      ephemeral_5m_input_tokens: z.number().optional(),
      ephemeral_1h_input_tokens: z.number().optional(),
    })
    .optional(),
  server_tool_use: z
    .looseObject({
      web_search_requests: z.number().optional(),
      web_fetch_requests: z.number().optional(),
    })
    .optional(),
});
export type Usage = z.infer<typeof usageSchema>;

const textBlockSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string().default(""),
});
const thinkingBlockSchema = z.looseObject({
  type: z.literal("thinking"),
  thinking: z.string().default(""),
});
const toolUseBlockSchema = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
const toolResultBlockSchema = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
});
const unknownBlockSchema = z.looseObject({ type: z.string() });

export const contentBlockSchema = z.union([
  textBlockSchema,
  thinkingBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
  unknownBlockSchema,
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type ToolUseBlock = z.infer<typeof toolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof toolResultBlockSchema>;

const baseMeta = {
  uuid: z.string().optional(),
  parentUuid: z.string().nullable().optional(),
  sessionId: z.string().optional(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  version: z.string().optional(),
  isSidechain: z.boolean().optional(),
  userType: z.string().optional(),
};

export const assistantEventSchema = z.looseObject({
  type: z.literal("assistant"),
  ...baseMeta,
  requestId: z.string().optional(),
  message: z.looseObject({
    id: z.string().optional(),
    role: z.literal("assistant").optional(),
    model: z.string().optional(),
    stop_reason: z.string().nullable().optional(),
    content: z.array(contentBlockSchema).default([]),
    usage: usageSchema.optional(),
  }),
});
export type AssistantEvent = z.infer<typeof assistantEventSchema>;

export const userEventSchema = z.looseObject({
  type: z.literal("user"),
  ...baseMeta,
  promptId: z.string().optional(),
  permissionMode: z.string().optional(),
  isMeta: z.boolean().optional(),
  /** True on the synthetic summary prompt written right after a compaction. */
  isCompactSummary: z.boolean().optional(),
  message: z.looseObject({
    role: z.literal("user").optional(),
    content: z.union([z.string(), z.array(contentBlockSchema)]),
  }),
});
export type UserEvent = z.infer<typeof userEventSchema>;

export const systemEventSchema = z.looseObject({
  type: z.literal("system"),
  ...baseMeta,
  subtype: z.string().optional(),
  level: z.string().optional(),
  toolUseID: z.string().optional(),
  /** Present on `subtype: "compact_boundary"` events (context compaction). */
  compactMetadata: z
    .looseObject({
      trigger: z.string().optional(),
      preTokens: z.number().optional(),
    })
    .optional(),
});
export type SystemEvent = z.infer<typeof systemEventSchema>;

export const aiTitleEventSchema = z.looseObject({
  type: z.literal("ai-title"),
  sessionId: z.string().optional(),
  aiTitle: z.string().default(""),
});
export type AiTitleEvent = z.infer<typeof aiTitleEventSchema>;

export const lastPromptEventSchema = z.looseObject({
  type: z.literal("last-prompt"),
  sessionId: z.string().optional(),
  leafUuid: z.string().optional(),
});

export const permissionModeEventSchema = z.looseObject({
  type: z.literal("permission-mode"),
  sessionId: z.string().optional(),
  permissionMode: z.string().optional(),
});

export const fileHistorySnapshotEventSchema = z.looseObject({
  type: z.literal("file-history-snapshot"),
  messageId: z.string().optional(),
  isSnapshotUpdate: z.boolean().optional(),
  snapshot: z.unknown().optional(),
});

export const attachmentEventSchema = z.looseObject({
  type: z.literal("attachment"),
  ...baseMeta,
  attachment: z.unknown().optional(),
});

export const unknownEventSchema = z.looseObject({ type: z.string() });
export type UnknownEvent = z.infer<typeof unknownEventSchema>;

/** Registry of known event schemas keyed by their `type` discriminator. */
export const schemaByType: Record<string, z.ZodType> = {
  assistant: assistantEventSchema,
  user: userEventSchema,
  system: systemEventSchema,
  "ai-title": aiTitleEventSchema,
  "last-prompt": lastPromptEventSchema,
  "permission-mode": permissionModeEventSchema,
  "file-history-snapshot": fileHistorySnapshotEventSchema,
  attachment: attachmentEventSchema,
};

export type SessionEvent =
  | AssistantEvent
  | UserEvent
  | SystemEvent
  | AiTitleEvent
  | UnknownEvent
  | Record<string, unknown>;

/**
 * How much of a session file this parser actually understood — the honesty
 * counter behind the whole product, since the JSONL format is undocumented and
 * moves between Claude Code releases.
 *
 * - `lines`: non-empty lines seen (blank lines are not content).
 * - `parseErrors`: lines that produced NO event — invalid JSON, or valid JSON
 *   that isn't an object. Their content is genuinely lost.
 * - `unknownEvents`: lines kept as a tolerant "unknown" event. This merges the
 *   two tolerant cases — a KNOWN `type` whose Zod schema no longer validates
 *   (schema drift) and a `type` this parser has never heard of — because they
 *   are the same actionable signal ("this build doesn't fully understand this
 *   file") and the index stores one column per counter.
 *
 * Lives here rather than in `parser.ts` so `analyze.ts` (and through it the web
 * SPA, which type-imports `SessionAnalysis`) can name the shape without pulling
 * the Bun-only file reader into the browser typecheck graph.
 */
export interface ParseCoverage {
  lines: number;
  parseErrors: number;
  unknownEvents: number;
}

/**
 * A user event starts a new turn only if it is a genuine prompt. Shared by the
 * analyzer and the transcript builder so turn boundaries never diverge between
 * them (a *turn* = one genuine prompt plus its assistant/tool loop).
 *
 * Not a genuine prompt when:
 * - it's a sidechain (subagent) task prompt — belongs to the enclosing turn;
 * - it's system-injected (`isMeta`: caveats, command stdout, reminders);
 * - it's the machine-written post-compaction summary (`isCompactSummary`) —
 *   the interrupted turn continues after it, the user typed nothing;
 * - it carries only `tool_result` blocks (a loop continuation).
 *
 * Note: `promptId` is present on tool_result carriers too, so it can't be the
 * discriminator.
 */
export function isRealPrompt(e: UserEvent): boolean {
  if (e.isSidechain === true) return false;
  if (e.isMeta === true) return false;
  if (e.isCompactSummary === true) return false;
  const content = e.message.content;
  if (typeof content === "string") return true;
  return content.some((b) => (b as ContentBlock).type !== "tool_result");
}

/**
 * Is this user-message text the machine-written interruption marker?
 *
 * When the user interrupts a response mid-flight (Esc), Claude Code writes a
 * literal user message — observed verbatim in real transcripts as
 * `[Request interrupted by user]`, or `[Request interrupted by user for tool
 * use]` when a pending tool call was cancelled. Matched by prefix (after
 * trimming) so trailing whitespace or a future suffix variant still counts;
 * the bracketed prefix is distinctive enough that a human prompt will not
 * start with it.
 */
export function isInterruptionMarker(text: string): boolean {
  return text.trimStart().startsWith("[Request interrupted by user");
}

/** Does this user event carry a machine-written interruption marker? */
export function isInterruptionEvent(event: UserEvent): boolean {
  return hasInterruptionContent(event.message.content);
}

function hasInterruptionContent(content: UserEvent["message"]["content"] | unknown): boolean {
  if (typeof content === "string") return isInterruptionMarker(content);
  if (!Array.isArray(content)) return false;
  return content.some((item) => {
    if (typeof item === "string") return isInterruptionMarker(item);
    const block = item as { type?: string; text?: string; content?: unknown };
    if (block?.type === "text") return isInterruptionMarker(block.text ?? "");
    if (block?.type === "tool_result") return hasInterruptionContent(block.content);
    return false;
  });
}

/** Only this leading window of a prompt is scanned for correction markers —
 * a phrase buried deep in a long prompt is context, not how the prompt opens. */
const CORRECTION_WINDOW = 120;

/* ——— Correction markers —————————————————————————————————————————————————
 * ⚠ These two lists ARE the `correction_turns` index column: `isCorrectionPrompt`
 * runs at index time and only the verdict is stored, exactly like
 * `isTestCommand()` behind `test_fail_streak`. Editing a pattern therefore
 * changes what already-indexed rows would have said — bump `SCHEMA_VERSION` in
 * `db.ts` so the index is rebuilt, or the two heuristics coexist in one table.
 * The pinning test in `test/core/events.test.ts` fails on any edit here and
 * repeats that instruction.
 *
 * Two tiers, because the phrases differ in how much they mean on their own.
 */

/**
 * Tier 1 — outcome and miscommunication phrases. These state that the previous
 * turn went wrong, and they say so specifically enough that position inside the
 * opening window doesn't change the meaning ("hold on — that's not what I
 * meant"). Matched anywhere in the window.
 */
const CORRECTION_OUTCOME_PATTERNS: readonly RegExp[] = [
  /\bthat'?s not what i\b/,
  /\bnot what i (?:meant|asked|wanted)\b/,
  /\bi didn'?t mean\b/,
  /\byou misunderstood\b/,
  /\bstill (?:broken|failing|doesn'?t|not working)\b/,
  /\b(?:didn'?t|doesn'?t) work\b/,
  /\bsame error\b/,
];

/**
 * Tier 2 — imperative and ambiguous phrases. Every one of these is also
 * ordinary product language in the middle of a feature request ("add a back
 * button so users can go back to the list view", "if the request fails, try
 * again with exponential backoff", "show a banner when the network is not
 * working"). They only count as corrections when the prompt *opens* with them,
 * so they are anchored with `^` — leading whitespace is already trimmed off.
 */
const CORRECTION_OPENING_PATTERNS: readonly RegExp[] = [
  // Leading rejection. "no"/"nope" only when punctuation follows ("no, the
  // other file"), so "no tests needed" never matches — and the ASCII hyphen is
  // deliberately NOT in the class, or "No-op the migration" and "no-cache
  // headers" would read as rejections.
  /^(?:no|nope)\s*[,.!;:—]/,
  /^(?:not that|wrong)\b/,
  // Explicit undo/redo — the verbs still need an object ("undo that"), so
  // "undo stack implementation" never matches even at a prompt start.
  /^(?:please )?(?:undo|revert) (?:that|this|it|the last)\b/,
  /^(?:please )?roll (?:that |this |it )?back\b/,
  /^go back to\b/,
  /^i meant\b/,
  // Non-working outcome, in its ambiguous bare form.
  /^(?:it'?s |it |that'?s |that )?not working\b/,
  // Re-ask — the user repeats what they already asked for.
  /^(?:please )?try (?:that |it |this )?again\b/,
  /^(?:please )?do it again\b/,
  /^as i said\b/,
  /^like i asked\b/,
];

/**
 * Every correction pattern's source, outcome tier first — the exact heuristic
 * baked into the index. Exported only so the pinning test can hash it; see the
 * warning above before changing anything it covers.
 */
export const CORRECTION_PATTERN_SOURCE: readonly string[] = [
  ...CORRECTION_OUTCOME_PATTERNS,
  ...CORRECTION_OPENING_PATTERNS,
].map(String);

/**
 * Does this REAL user prompt open by correcting the previous turn?
 *
 * A conservative, **English-only keyword heuristic** — biased and imperfect by
 * construction. It only inspects the first `CORRECTION_WINDOW` characters
 * (lowercased) and anchors every marker to a phrase start: outcome phrases may
 * sit anywhere in that window, ambiguous imperative ones only at the very
 * start of the prompt (see the two pattern lists). Slash commands and
 * machine-looking prompts (starting with `<`, `/`, or `[` — XML payloads,
 * commands, bracketed markers like the interruption message) never match.
 * Non-English corrections are missed entirely, and plenty of English ones
 * will be too: prefer missing corrections to inventing them, because the
 * downstream diagnostics accuse prompts of causing rework.
 */
export function isCorrectionPrompt(text: string): boolean {
  const trimmed = text.trimStart();
  const first = trimmed[0];
  if (first === "<" || first === "/" || first === "[") return false;
  const head = trimmed.slice(0, CORRECTION_WINDOW).toLowerCase();
  return (
    CORRECTION_OUTCOME_PATTERNS.some((re) => re.test(head)) ||
    CORRECTION_OPENING_PATTERNS.some((re) => re.test(head))
  );
}
