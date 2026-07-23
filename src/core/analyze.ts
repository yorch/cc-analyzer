import {
  type AssistantEvent,
  type ContentBlock,
  isRealPrompt,
  type SessionEvent,
  type ToolUseBlock,
  type Usage,
  type UserEvent,
} from "./events.ts";
import {
  addCost,
  addTokens,
  type CostBreakdown,
  computeCost,
  type PricingTable,
  resolveModel,
  type TokenCounts,
  zeroCost,
  zeroTokens,
} from "./pricing.ts";
import {
  capDetail,
  makeResultHint,
  resultToText,
  summarizeToolUse,
  type TurnStep,
  truncate,
} from "./steps.ts";

export interface ApiCall {
  uuid?: string;
  model?: string;
  timestamp?: string;
  isSidechain: boolean;
  /** Why the API response ended (e.g. end_turn, tool_use, max_tokens). */
  stopReason?: string;
  tokens: TokenCounts;
  cost: CostBreakdown;
  /** Ordered timeline of this inference: narration, thinking, tool operations. */
  steps: TurnStep[];
}

export interface Turn {
  index: number;
  prompt: string;
  promptId?: string;
  permissionMode?: string;
  startTime?: string;
  endTime?: string;
  models: string[];
  apiCalls: ApiCall[];
  /** Main-chain API calls only — a subagent burst is one main-loop step, so
   * turn-depth analytics count this, not apiCalls.length. */
  mainApiCalls: number;
  tokens: TokenCounts;
  cost: CostBreakdown;
  toolCounts: Record<string, number>;
}

export interface ModelUsage {
  apiCalls: number;
  tokens: TokenCounts;
  cost: CostBreakdown;
  /** Context-window size of the model (pricing `maxInputTokens`), when known —
   * lets the context-fill charts draw the limit line without a pricing table. */
  contextLimit?: number;
}

/**
 * One context compaction. Newer Claude Code versions log a
 * `system`/`compact_boundary` event carrying trigger + pre-compaction token
 * count; older versions only leave the synthetic summary prompt
 * (`isCompactSummary`), which yields a timestamp-only record.
 */
export interface Compaction {
  timestamp?: string;
  /** The boundary/summary event's uuid, when present. Continuation files copy
   * the parent's boundary verbatim (same uuid), and session files themselves
   * get copied around — rollups dedupe own compactions on this id so one
   * compaction never counts twice across rows. */
  uuid?: string;
  /** "auto" | "manual" when known (from compactMetadata). */
  trigger?: string;
  /** Context tokens just before the compaction, when known. */
  preTokens?: number;
  /** True when the compaction happened inside a subagent (sidechain)
   * transcript — it compacted that subagent's own context window, not the
   * main chain's, so it must not be marked on the main context chart. */
  isSidechain?: boolean;
  /** True when the record precedes any API call in the file. Continuation
   * files copy the parent session's final compact_boundary at their start, so
   * such a record describes the *parent's* compaction — portfolio rollups
   * must not count it again here. */
  inherited?: boolean;
}

export interface SessionTotals {
  turns: number;
  apiCalls: number;
  toolCalls: number;
  tokens: TokenCounts;
  cost: CostBreakdown;
  webSearches: number;
  webFetches: number;
  /** API calls made on sidechains (subagents), and their cost. */
  sidechainApiCalls: number;
  sidechainCost: number;
  /** Wall-clock ms where consecutive events were ≤ ACTIVE_GAP_MS apart — the
   * agent (or the human) was actively working, as opposed to the session
   * sitting open. Always ≤ durationMs. */
  activeMs: number;
}

export interface SessionAnalysis {
  sessionId?: string;
  title?: string;
  projectPath?: string;
  gitBranches: string[];
  versions: string[];
  startTime?: string;
  endTime?: string;
  durationMs?: number;
  totals: SessionTotals;
  /** Per-turn timeline. Empty when analysis ran in aggregate-only mode. */
  turns: Turn[];
  models: Record<string, ModelUsage>;
  tools: Record<string, number>;
  /** Per-tool count of tool_uses whose result was an error. */
  toolErrors: Record<string, number>;
  /** Per-skill invocation count (a `Skill` tool_use with a resolvable name). */
  skills: Record<string, number>;
  /** Per-skill count of `Skill` invocations whose result was an error. */
  skillErrors: Record<string, number>;
  subagents: string[];
  filesTouched: string[];
  /** Count of API calls per stop_reason (end_turn, tool_use, max_tokens, …). */
  stopReasons: Record<string, number>;
  /** Count of turns per permission mode ("default" when the event carries none). */
  permissionModes: Record<string, number>;
  /** Bash invocations per command family (git, bun, npm, …). */
  bashCommands: Record<string, number>;
  /** Bash invocations per command family whose result was an error. */
  bashErrors: Record<string, number>;
  /** Raw normalized command heads per shell segment (see `commandHead`) and
   * the subset whose result errored — what the index stores for query-time
   * classification. */
  commandHeads: Record<string, number>;
  commandHeadErrors: Record<string, number>;
  /** Bash invocations that look like a test run, and how many of those failed. */
  testRuns: number;
  testFailures: number;
  /** Consecutive tool calls with identical tool + input (churn / wasted loops). */
  retries: number;
  retriesByTool: Record<string, number>;
  /** Total characters across every turn's prompt (survives aggregate mode). */
  promptChars: number;
  /** Main-chain API calls per turn, in order — the turn-depth series. Available
   * even in aggregate mode, where `turns` is empty. */
  turnDepths: number[];
  /** Context compactions, in session order. Available in aggregate mode too. */
  compactions: Compaction[];
}

export interface AnalyzeOptions {
  /**
   * Build the per-turn timeline (turns + steps + ApiCall objects). Default true.
   * When false, only the aggregate fields are computed — the memory win for the
   * indexer, which never reads `turns` (it uses `promptChars`/`turnDepths`).
   */
  detail?: boolean;
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Gaps between consecutive events longer than this count as idle, not work. */
export const ACTIVE_GAP_MS = 5 * 60_000;

/** Strip leading `FOO=bar`-style env assignments from a command line. */
function stripEnvAssignments(command: string): string {
  let rest = command.trimStart();
  for (;;) {
    const m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  return rest;
}

/** One shared (heuristic) command-line segmentation for the shell metrics:
 * split on `&&`, `;`, pipes, and newlines, env assignments stripped. */
function shellSegments(command: string): string[] {
  return command
    .split(/&&|;|\|{1,2}|\r?\n/)
    .map((segment) => stripEnvAssignments(segment.trim()))
    .filter((segment) => segment !== "");
}

/**
 * The program a shell command line resolves to: leading env assignments are
 * skipped, leading `cd`/`pushd` segments attribute to the command that
 * follows, and paths reduce to their basename (`/usr/bin/git` → `git`).
 */
export function commandFamily(command: string): string | undefined {
  let fallback: string | undefined;
  for (const segment of shellSegments(command)) {
    const first = segment.split(/\s+/, 1)[0] ?? "";
    const base = (first.split("/").pop() ?? "").toLowerCase();
    if (!base) continue;
    if (base === "cd" || base === "pushd") {
      fallback ??= base;
      continue;
    }
    return base;
  }
  return fallback;
}

/**
 * Normalized head of one shell segment: the basename+lowercased program plus
 * up to two following tokens ("npm run test", "git commit -m"). This is the
 * raw signal stored in the index (schema v6), so command classification —
 * families, test-runner detection — happens at query time in `stats.ts` and
 * can evolve without a reindex. `cd`/`pushd` segments are navigation noise
 * and record nothing.
 */
export function commandHead(segment: string): string | undefined {
  const tokens = segment.split(/\s+/, 3);
  const first = tokens[0];
  if (!first) return undefined;
  const base = (first.split("/").pop() ?? "").toLowerCase();
  if (!base || base === "cd" || base === "pushd") return undefined;
  return [base, ...tokens.slice(1)].join(" ").slice(0, 60);
}

// Anchored at the start of a command segment so a runner name appearing in an
// argument (`grep -rn "go test" src/`, `cat jest.config.js`) doesn't match.
const TEST_RUNNER =
  /^(?:(?:bun|npm|pnpm|yarn|deno)\s+(?:run\s+)?test\b|pytest\b|jest\b|vitest\b|go\s+test\b|cargo\s+test\b|mvn\s+test\b|(?:\.\/)?gradlew?\s+test\b|make\s+test\b|rspec\b|phpunit\b|ctest\b)/;

/** Heuristic: does this shell command run a test suite? Each segment is
 * checked at its start (after env assignments), not anywhere in the string.
 * Also valid on a stored `commandHead` (a head is a single clean segment). */
export function isTestCommand(command: string): boolean {
  return shellSegments(command).some((segment) => TEST_RUNNER.test(segment));
}

/** Extract the four priced token categories from a usage block. */
export function usageToTokens(usage?: Usage): TokenCounts {
  if (!usage) return zeroTokens();
  const c5 = usage.cache_creation?.ephemeral_5m_input_tokens;
  const c1 = usage.cache_creation?.ephemeral_1h_input_tokens;
  let write5m = 0;
  let write1h = 0;
  if (c5 !== undefined || c1 !== undefined) {
    write5m = c5 ?? 0;
    write1h = c1 ?? 0;
  } else {
    write5m = usage.cache_creation_input_tokens ?? 0;
  }
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheWrite5mTokens: write5m,
    cacheWrite1hTokens: write1h,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };
}

function isAssistant(e: SessionEvent): e is AssistantEvent {
  return (e as { type?: string }).type === "assistant";
}

function isUser(e: SessionEvent): e is UserEvent {
  return (e as { type?: string }).type === "user";
}

function promptPreview(content: UserEvent["message"]["content"]): string {
  if (typeof content === "string") return content;
  const text = content
    .map((b) => {
      const block = b as ContentBlock & { text?: string };
      return block.type === "text" ? (block.text ?? "") : "";
    })
    .join(" ")
    .trim();
  return text;
}

function stringField(input: unknown, key: string): string | undefined {
  if (typeof input === "object" && input !== null && key in input) {
    const v = (input as Record<string, unknown>)[key];
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

/** A tool_use awaiting its (later-arriving) tool_result. */
interface PendingTool {
  toolName: string;
  skillName?: string;
  /** Bash command family, if this was a Bash call — for deferred `bashErrors`. */
  bashFamily?: string;
  /** Whether this Bash call looked like a test run — for deferred `testFailures`. */
  isTest?: boolean;
  /** Raw command heads of this Bash call — for deferred `commandHeadErrors`. */
  heads?: string[];
  /** The step to patch when the result arrives — only in detail mode. */
  step?: TurnStep;
}

/** Cursor tracking the previous tool call on a chain, for retry/churn detection. */
interface ToolCursor {
  name: string;
  input: unknown;
  json?: string;
}

/**
 * Streaming accumulator behind both `analyzeSession` (array) and
 * `analyzeSessionStream`. A single forward pass: tool_uses register in
 * `pending` and are resolved when their `tool_result` arrives later, so error
 * attribution and step results work without a second pass over the events.
 */
class SessionAnalyzer {
  private readonly turns: Turn[] = [];
  private readonly gitBranches = new Set<string>();
  private readonly versions = new Set<string>();
  private readonly models: Record<string, ModelUsage> = {};
  private readonly tools: Record<string, number> = {};
  private readonly toolErrors: Record<string, number> = {};
  private readonly skills: Record<string, number> = {};
  private readonly skillErrors: Record<string, number> = {};
  private readonly subagents = new Set<string>();
  private readonly filesTouched = new Set<string>();
  private readonly stopReasons: Record<string, number> = {};
  private readonly permissionModes: Record<string, number> = {};
  private readonly bashCommands: Record<string, number> = {};
  private readonly bashErrors: Record<string, number> = {};
  private readonly commandHeads: Record<string, number> = {};
  private readonly commandHeadErrors: Record<string, number> = {};
  private readonly retriesByTool: Record<string, number> = {};
  private readonly turnDepths: number[] = [];
  private readonly compactions: Compaction[] = [];
  // A compact_boundary is immediately followed by its isCompactSummary prompt;
  // pairing them (per chain kind, since subagents compact too) keeps one
  // compaction from being recorded twice. Cleared on the next assistant line,
  // so a summary-only file (older versions) still records. Holds the pending
  // boundary's sidechain-ness; undefined = no boundary pending.
  private pendingBoundarySidechain: boolean | undefined;
  private title?: string;
  private sessionId?: string;
  private projectPath?: string;
  private startTime?: string;
  private endTime?: string;
  private webSearches = 0;
  private webFetches = 0;
  private toolCallCount = 0;
  private apiCallCount = 0;
  private turnCount = 0;
  private testRuns = 0;
  private testFailures = 0;
  private retries = 0;
  private sidechainApiCalls = 0;
  private sidechainCost = 0;
  private promptChars = 0;
  private totalTokens = zeroTokens();
  private totalCost = zeroCost();
  private current?: Turn;

  // Turn depth: main-chain calls in the open turn, finalized to `turnDepths` at
  // each turn boundary (so it works even in aggregate mode, where `turns` is
  // never built).
  private hasTurn = false;
  private currentDepth = 0;

  // One retry cursor per chain, reset at each new turn: a user-requested
  // re-run or an interleaved call from a *different* subagent must not read
  // as churn, while a subagent repeating its own call must. Inputs are
  // serialized lazily (only when tool names match) — Write/Edit inputs can be
  // MB-scale.
  private readonly prevToolByChain = new Map<string, ToolCursor>();
  // Chain identity: "" is the main chain; a sidechain event belongs to its
  // parent's chain, or roots a new one when its parent is main-chain/unknown
  // (the spawn point). Events are appended parent-before-child, so the single
  // forward pass resolves every chain; only sidechain uuids are stored.
  private readonly chainOfUuid = new Map<string, string>();

  // Every parsed event timestamp (ms); sorted once at the end for active time,
  // so interleaved out-of-order sidechain lines can't skew the sum.
  private readonly eventMs: number[] = [];

  // Streamed responses log one `assistant` line per content block, each
  // repeating the same message id and full usage. `seenUsage` de-dups so usage
  // is counted once; `callsByKey` (detail only) merges continuation steps into
  // the originating ApiCall; `stoppedKeys` records which calls already had a
  // stop_reason counted (it can arrive on any line of the call).
  private readonly seenUsage = new Set<string>();
  private readonly callsByKey = new Map<string, ApiCall>();
  private readonly stoppedKeys = new Set<string>();
  private readonly pending = new Map<string, PendingTool>();

  constructor(
    private readonly pricing: PricingTable,
    private readonly detail: boolean,
  ) {}

  private touchTime(ts?: string): void {
    if (!ts) return;
    if (!this.startTime || ts < this.startTime) this.startTime = ts;
    if (!this.endTime || ts > this.endTime) this.endTime = ts;
    if (this.detail && this.current) {
      if (!this.current.startTime || ts < this.current.startTime) this.current.startTime = ts;
      if (!this.current.endTime || ts > this.current.endTime) this.current.endTime = ts;
    }
    const ms = Date.parse(ts);
    if (!Number.isNaN(ms)) this.eventMs.push(ms);
  }

  /** Resolve (and register) an event's chain id ("" = main chain). */
  private chainOf(e: { uuid?: string; parentUuid?: string | null; isSidechain?: boolean }): string {
    if (e.isSidechain !== true) return "";
    const parentChain = e.parentUuid ? this.chainOfUuid.get(e.parentUuid) : undefined;
    const chain = parentChain || e.uuid || "sidechain";
    if (e.uuid) this.chainOfUuid.set(e.uuid, chain);
    return chain;
  }

  private usageKey(e: AssistantEvent): string | undefined {
    const mid = e.message.id;
    if (mid && e.requestId) return `${mid}:${e.requestId}`;
    return mid ?? e.requestId;
  }

  /** Count a call's stop_reason once — on whichever line first carries one. */
  private countStopReason(reason: string, key: string | undefined): void {
    if (key !== undefined) {
      if (this.stoppedKeys.has(key)) return;
      this.stoppedKeys.add(key);
    }
    this.stopReasons[reason] = (this.stopReasons[reason] ?? 0) + 1;
  }

  /** Attach a tool_result to its pending tool_use: count errors, patch the step. */
  private resolveResult(id: string, isError: boolean, rawContent: unknown): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (isError) {
      this.toolErrors[p.toolName] = (this.toolErrors[p.toolName] ?? 0) + 1;
      if (p.skillName) this.skillErrors[p.skillName] = (this.skillErrors[p.skillName] ?? 0) + 1;
      if (p.bashFamily) this.bashErrors[p.bashFamily] = (this.bashErrors[p.bashFamily] ?? 0) + 1;
      if (p.isTest) this.testFailures += 1;
      for (const head of p.heads ?? []) {
        this.commandHeadErrors[head] = (this.commandHeadErrors[head] ?? 0) + 1;
      }
    }
    if (this.detail && p.step) {
      const text = resultToText(rawContent);
      const capped = capDetail(text);
      p.step.status = isError ? "error" : "ok";
      p.step.resultHint = makeResultHint(isError, text);
      p.step.detail = {
        input: p.step.detail?.input,
        result: capped.text,
        truncated: (p.step.detail?.truncated ?? false) || capped.truncated,
      };
    }
  }

  push(event: SessionEvent): void {
    const meta = event as {
      sessionId?: string;
      cwd?: string;
      gitBranch?: string;
      version?: string;
      type?: string;
      aiTitle?: string;
    };
    // Resolve (and register) every event's chain — sidechains thread through
    // user tool_result events too, not just assistant lines.
    const chain = this.chainOf(
      event as { uuid?: string; parentUuid?: string | null; isSidechain?: boolean },
    );
    if (meta.sessionId && !this.sessionId) this.sessionId = meta.sessionId;
    if (meta.cwd && !this.projectPath) this.projectPath = meta.cwd;
    if (meta.gitBranch) this.gitBranches.add(meta.gitBranch);
    if (meta.version) this.versions.add(meta.version);
    if (meta.type === "ai-title" && meta.aiTitle) this.title = meta.aiTitle;

    if (meta.type === "system") {
      const sys = event as {
        subtype?: string;
        timestamp?: string;
        uuid?: string;
        compactMetadata?: { trigger?: string; preTokens?: number };
      };
      if (sys.subtype === "compact_boundary") {
        const side = (event as { isSidechain?: boolean }).isSidechain === true;
        this.compactions.push({
          timestamp: sys.timestamp,
          ...(sys.uuid ? { uuid: sys.uuid } : {}),
          trigger: sys.compactMetadata?.trigger,
          preTokens: sys.compactMetadata?.preTokens,
          ...(side ? { isSidechain: true } : {}),
          ...(this.apiCallCount === 0 ? { inherited: true } : {}),
        });
        this.pendingBoundarySidechain = side;
      }
    }

    if (isUser(event)) {
      if (event.isCompactSummary === true) {
        // Only record when no boundary event announced this compaction —
        // older Claude Code versions write just the summary prompt.
        const side = event.isSidechain === true;
        if (this.pendingBoundarySidechain === side) this.pendingBoundarySidechain = undefined;
        else
          this.compactions.push({
            timestamp: event.timestamp,
            ...(event.uuid ? { uuid: event.uuid } : {}),
            ...(side ? { isSidechain: true } : {}),
            ...(this.apiCallCount === 0 ? { inherited: true } : {}),
          });
      }
      // Resolve any tool_result blocks first (a user event may carry them
      // whether or not it is also a genuine prompt).
      const content = event.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as ContentBlock & {
            tool_use_id?: string;
            is_error?: boolean;
            content?: unknown;
          };
          if (b.type === "tool_result" && b.tool_use_id) {
            this.resolveResult(b.tool_use_id, b.is_error === true, b.content);
          }
        }
      }
      if (isRealPrompt(event)) {
        const prompt = promptPreview(content);
        this.promptChars += prompt.length;
        // Finalize the previous turn's depth before opening this one.
        if (this.hasTurn) this.turnDepths.push(this.currentDepth);
        this.hasTurn = true;
        this.currentDepth = 0;
        this.turnCount += 1;
        const mode = event.permissionMode ?? "default";
        this.permissionModes[mode] = (this.permissionModes[mode] ?? 0) + 1;
        // A new turn is a fresh start: repeating the previous turn's last call
        // (e.g. the user asked to run it again) is not churn.
        this.prevToolByChain.clear();
        if (this.detail) {
          this.current = {
            index: this.turns.length,
            prompt,
            promptId: event.promptId,
            permissionMode: event.permissionMode,
            models: [],
            apiCalls: [],
            mainApiCalls: 0,
            tokens: zeroTokens(),
            cost: zeroCost(),
            toolCounts: {},
          };
          this.turns.push(this.current);
        }
      }
      this.touchTime(event.timestamp);
      return;
    }

    if (isAssistant(event)) {
      this.pushAssistant(event, chain);
      return;
    }

    this.touchTime((event as { timestamp?: string }).timestamp);
  }

  private pushAssistant(event: AssistantEvent, chain: string): void {
    // The boundary→summary pair is adjacent on its own chain; an assistant
    // line on that chain kind closes it. An interleaved line from the *other*
    // kind (e.g. a subagent streaming while the main chain compacts) must not
    // clear it, or the still-coming summary would record a second compaction.
    if (this.pendingBoundarySidechain === (event.isSidechain === true)) {
      this.pendingBoundarySidechain = undefined;
    }
    this.touchTime(event.timestamp);
    const key = this.usageKey(event);
    const isContinuation = key !== undefined && this.seenUsage.has(key);

    // Every content block appears on exactly one line, so tool counting +
    // pending registration run for every assistant line (including
    // continuations); only usage counting is gated on the first line.
    const steps: TurnStep[] = [];
    for (const block of event.message.content) {
      const b = block as ContentBlock & { text?: string; thinking?: string };
      if (b.type === "text") {
        if (!this.detail) continue;
        const text = b.text ?? "";
        if (text.trim() === "") continue;
        const capped = capDetail(text);
        steps.push({
          kind: "note",
          label: "Assistant",
          summary: truncate(text, 200),
          detail: { result: capped.text, truncated: capped.truncated },
        });
        continue;
      }
      if (b.type === "thinking") {
        if (!this.detail) continue;
        const think = b.thinking ?? "";
        const capped = capDetail(think);
        steps.push({
          kind: "thinking",
          label: "thinking",
          summary: think.trim() === "" ? "(hidden)" : truncate(think, 160),
          detail: { result: capped.text, truncated: capped.truncated },
        });
        continue;
      }
      if (b.type !== "tool_use") continue;

      const tu = block as ToolUseBlock;
      this.toolCallCount += 1;
      this.tools[tu.name] = (this.tools[tu.name] ?? 0) + 1;
      if (this.detail && this.current) {
        this.current.toolCounts[tu.name] = (this.current.toolCounts[tu.name] ?? 0) + 1;
      }

      // Churn: a tool call identical to the immediately preceding one on the
      // same chain (same tool, same input) is a retry — the loop re-did work.
      const prevTool = this.prevToolByChain.get(chain);
      const cursor: ToolCursor = { name: tu.name, input: tu.input };
      if (prevTool && prevTool.name === tu.name) {
        prevTool.json ??= JSON.stringify(prevTool.input ?? null);
        cursor.json = JSON.stringify(tu.input ?? null);
        if (cursor.json === prevTool.json) {
          this.retries += 1;
          this.retriesByTool[tu.name] = (this.retriesByTool[tu.name] ?? 0) + 1;
        }
      }
      this.prevToolByChain.set(chain, cursor);

      let skillName: string | undefined;
      if (tu.name === "Skill") {
        skillName = stringField(tu.input, "skill") ?? stringField(tu.input, "command");
        if (skillName) this.skills[skillName] = (this.skills[skillName] ?? 0) + 1;
      } else if (tu.name === "Task" || tu.name === "Agent") {
        const t = stringField(tu.input, "subagent_type");
        if (t) this.subagents.add(t);
      }
      if (FILE_TOOLS.has(tu.name)) {
        const fp = stringField(tu.input, "file_path");
        if (fp) this.filesTouched.add(fp);
      }

      // Bash command families + test runs + raw command heads (counted now;
      // error/failure attribution deferred to the tool_result via `pending`).
      let bashFamily: string | undefined;
      let isTest = false;
      let heads: string[] | undefined = [];
      if (tu.name === "Bash") {
        const cmd = stringField(tu.input, "command");
        if (cmd) {
          bashFamily = commandFamily(cmd);
          if (bashFamily) this.bashCommands[bashFamily] = (this.bashCommands[bashFamily] ?? 0) + 1;
          if (isTestCommand(cmd)) {
            isTest = true;
            this.testRuns += 1;
          }
          for (const segment of shellSegments(cmd)) {
            const head = commandHead(segment);
            if (!head) continue;
            this.commandHeads[head] = (this.commandHeads[head] ?? 0) + 1;
            heads.push(head);
          }
        }
      }

      if (heads.length === 0) heads = undefined;

      let step: TurnStep | undefined;
      if (this.detail) {
        const { kind, label, summary } = summarizeToolUse(tu.name, tu.input);
        const inputCapped = capDetail(JSON.stringify(tu.input ?? null, null, 2));
        step = {
          kind,
          tool: tu.name,
          label,
          summary,
          toolUseId: tu.id,
          detail: { input: inputCapped.text, truncated: inputCapped.truncated },
        };
        steps.push(step);
      }
      this.pending.set(tu.id, { toolName: tu.name, skillName, bashFamily, isTest, heads, step });
    }

    // A continuation line of an already-counted API call: keep its steps on the
    // originating ApiCall, but never re-count its usage or re-price it. Its
    // stop_reason may still be the one that closed the response.
    if (isContinuation) {
      if (this.detail && key !== undefined) {
        const call = this.callsByKey.get(key);
        if (call) {
          call.steps.push(...steps);
          const reason = event.message.stop_reason;
          if (reason && !call.stopReason) call.stopReason = reason;
        }
      }
      const reason = event.message.stop_reason;
      if (reason) this.countStopReason(reason, key);
      return;
    }
    if (key !== undefined) this.seenUsage.add(key);

    // First (or only) line of this API call: count and price its usage once.
    const usage = event.message.usage;
    this.webSearches += usage?.server_tool_use?.web_search_requests ?? 0;
    this.webFetches += usage?.server_tool_use?.web_fetch_requests ?? 0;

    const tokens = usageToTokens(usage);
    const model = event.message.model;
    const resolved = model ? resolveModel(this.pricing, model) : undefined;
    const cost = computeCost(tokens, resolved?.pricing);
    // A family-heuristic match (non-exact) is still an estimate.
    if (resolved && !resolved.exact) cost.estimated = true;

    const stopReason = event.message.stop_reason ?? undefined;
    if (stopReason) this.countStopReason(stopReason, key);

    this.apiCallCount += 1;
    const isSidechain = event.isSidechain === true;
    if (isSidechain) {
      this.sidechainApiCalls += 1;
      this.sidechainCost += cost.total;
    } else if (this.hasTurn) {
      this.currentDepth += 1;
    }
    this.totalTokens = addTokens(this.totalTokens, tokens);
    this.totalCost = addCost(this.totalCost, cost);
    if (model) {
      let mu = this.models[model];
      if (!mu) {
        mu = { apiCalls: 0, tokens: zeroTokens(), cost: zeroCost() };
        const limit = resolved?.pricing.maxInputTokens;
        if (limit) mu.contextLimit = limit;
        this.models[model] = mu;
      }
      mu.apiCalls += 1;
      mu.tokens = addTokens(mu.tokens, tokens);
      mu.cost = addCost(mu.cost, cost);
    }

    if (this.detail) {
      const apiCall: ApiCall = {
        uuid: event.uuid,
        model,
        timestamp: event.timestamp,
        isSidechain,
        stopReason,
        tokens,
        cost,
        steps,
      };
      if (key !== undefined) this.callsByKey.set(key, apiCall);
      if (this.current) {
        this.current.apiCalls.push(apiCall);
        if (!isSidechain) this.current.mainApiCalls += 1;
        this.current.tokens = addTokens(this.current.tokens, tokens);
        this.current.cost = addCost(this.current.cost, cost);
        if (model && !this.current.models.includes(model)) this.current.models.push(model);
      }
    }
  }

  finish(): SessionAnalysis {
    // Finalize the last open turn's depth.
    if (this.hasTurn) this.turnDepths.push(this.currentDepth);

    // Active time: sum gaps between consecutive timestamps ≤ ACTIVE_GAP_MS
    // (longer gaps are the session sitting idle). Sorting first makes the sum
    // exact under any event interleaving and keeps activeMs ≤ durationMs.
    this.eventMs.sort((a, b) => a - b);
    let activeMs = 0;
    for (let i = 1; i < this.eventMs.length; i++) {
      const gap = (this.eventMs[i] as number) - (this.eventMs[i - 1] as number);
      if (gap <= ACTIVE_GAP_MS) activeMs += gap;
    }

    const totals: SessionTotals = {
      // Counted over every API call — including calls before the first prompt —
      // so totals always agree with `models`.
      turns: this.turnCount,
      apiCalls: this.apiCallCount,
      toolCalls: this.toolCallCount,
      tokens: this.totalTokens,
      cost: this.totalCost,
      webSearches: this.webSearches,
      webFetches: this.webFetches,
      sidechainApiCalls: this.sidechainApiCalls,
      sidechainCost: this.sidechainCost,
      activeMs,
    };
    return {
      sessionId: this.sessionId,
      title: this.title,
      projectPath: this.projectPath,
      gitBranches: [...this.gitBranches],
      versions: [...this.versions],
      startTime: this.startTime,
      endTime: this.endTime,
      durationMs:
        this.startTime && this.endTime
          ? new Date(this.endTime).getTime() - new Date(this.startTime).getTime()
          : undefined,
      totals,
      turns: this.turns,
      models: this.models,
      tools: this.tools,
      toolErrors: this.toolErrors,
      skills: this.skills,
      skillErrors: this.skillErrors,
      subagents: [...this.subagents],
      filesTouched: [...this.filesTouched],
      stopReasons: this.stopReasons,
      permissionModes: this.permissionModes,
      bashCommands: this.bashCommands,
      bashErrors: this.bashErrors,
      commandHeads: this.commandHeads,
      commandHeadErrors: this.commandHeadErrors,
      testRuns: this.testRuns,
      testFailures: this.testFailures,
      retries: this.retries,
      retriesByTool: this.retriesByTool,
      promptChars: this.promptChars,
      turnDepths: this.turnDepths,
      compactions: this.compactions,
    };
  }
}

/** Analyze a session's events into per-turn and aggregate metrics. */
export function analyzeSession(events: SessionEvent[], pricing: PricingTable): SessionAnalysis {
  const analyzer = new SessionAnalyzer(pricing, true);
  for (const event of events) analyzer.push(event);
  return analyzer.finish();
}

/**
 * Analyze a session from a stream of events, without materializing the full
 * event array — the memory win for bulk consumers over large sessions. With
 * `detail: false` the per-turn timeline is skipped entirely (aggregates only);
 * `promptChars` and `turnDepths` still carry the turn-derived aggregates the
 * indexer needs.
 */
export async function analyzeSessionStream(
  events: AsyncIterable<SessionEvent>,
  pricing: PricingTable,
  opts: AnalyzeOptions = {},
): Promise<SessionAnalysis> {
  const analyzer = new SessionAnalyzer(pricing, opts.detail ?? true);
  for await (const event of events) analyzer.push(event);
  return analyzer.finish();
}
