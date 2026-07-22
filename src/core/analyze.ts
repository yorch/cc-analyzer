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
  tokens: TokenCounts;
  cost: CostBreakdown;
  toolCounts: Record<string, number>;
}

export interface ModelUsage {
  apiCalls: number;
  tokens: TokenCounts;
  cost: CostBreakdown;
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
  /** Bash invocations that look like a test run, and how many of those failed. */
  testRuns: number;
  testFailures: number;
  /** Consecutive tool calls with identical tool + input (churn / wasted loops). */
  retries: number;
  retriesByTool: Record<string, number>;
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

/**
 * The program a shell command line resolves to: leading env assignments are
 * skipped, a leading `cd … && real` attributes to `real`, and paths reduce to
 * their basename (`/usr/bin/git` → `git`).
 */
export function commandFamily(command: string, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  const rest = stripEnvAssignments(command);
  const first = rest.split(/\s+/, 1)[0] ?? "";
  const base = (first.split("/").pop() ?? "").toLowerCase();
  if (!base) return undefined;
  if (base === "cd" || base === "pushd") {
    const after = rest.match(/(?:&&|;)([\s\S]+)$/);
    if (after?.[1]) return commandFamily(after[1], depth + 1) ?? base;
  }
  return base;
}

// Anchored at the start of a command segment so a runner name appearing in an
// argument (`grep -rn "go test" src/`, `cat jest.config.js`) doesn't match.
const TEST_RUNNER =
  /^(?:(?:bun|npm|pnpm|yarn|deno)\s+(?:run\s+)?test\b|pytest\b|jest\b|vitest\b|go\s+test\b|cargo\s+test\b|mvn\s+test\b|(?:\.\/)?gradlew?\s+test\b|make\s+test\b|rspec\b|phpunit\b|ctest\b)/;

/** Heuristic: does this shell command run a test suite? Each `&&`/`;`/`|`
 * segment is checked at its start (after env assignments), not anywhere. */
export function isTestCommand(command: string): boolean {
  return command
    .split(/&&|;|\|{1,2}/)
    .some((segment) => TEST_RUNNER.test(stripEnvAssignments(segment.trim())));
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

interface ToolResult {
  isError: boolean;
  text: string;
}

/** Map each tool_use_id to its result (error flag + text) from tool_result blocks. */
function collectToolResults(events: SessionEvent[]): Map<string, ToolResult> {
  const map = new Map<string, ToolResult>();
  for (const e of events) {
    if (!isUser(e)) continue;
    const content = e.message.content;
    if (typeof content === "string") continue;
    for (const block of content) {
      const b = block as ContentBlock & {
        tool_use_id?: string;
        is_error?: boolean;
        content?: unknown;
      };
      if (b.type === "tool_result" && b.tool_use_id) {
        map.set(b.tool_use_id, { isError: b.is_error === true, text: resultToText(b.content) });
      }
    }
  }
  return map;
}

function stringField(input: unknown, key: string): string | undefined {
  if (typeof input === "object" && input !== null && key in input) {
    const v = (input as Record<string, unknown>)[key];
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

/** Analyze a session's events into per-turn and aggregate metrics. */
export function analyzeSession(events: SessionEvent[], pricing: PricingTable): SessionAnalysis {
  const toolResults = collectToolResults(events);

  const turns: Turn[] = [];
  const gitBranches = new Set<string>();
  const versions = new Set<string>();
  const models: Record<string, ModelUsage> = {};
  const tools: Record<string, number> = {};
  const toolErrors: Record<string, number> = {};
  const skills: Record<string, number> = {};
  const skillErrors: Record<string, number> = {};
  const subagents = new Set<string>();
  const filesTouched = new Set<string>();
  let title: string | undefined;
  let sessionId: string | undefined;
  let projectPath: string | undefined;
  let startTime: string | undefined;
  let endTime: string | undefined;
  let webSearches = 0;
  let webFetches = 0;
  let toolCallCount = 0;
  let apiCallCount = 0;
  let totalTokens = zeroTokens();
  let totalCost = zeroCost();
  let current: Turn | undefined;
  const stopReasons: Record<string, number> = {};
  const permissionModes: Record<string, number> = {};
  const bashCommands: Record<string, number> = {};
  const bashErrors: Record<string, number> = {};
  let testRuns = 0;
  let testFailures = 0;
  let retries = 0;
  const retriesByTool: Record<string, number> = {};
  // Separate cursors for the main chain and sidechains, reset at each new
  // turn: a user-requested re-run or an interleaved subagent call must not
  // read as churn. (Parallel sidechains still share one cursor — the log
  // carries no chain id to tell them apart.)
  let prevToolKeyMain: string | undefined;
  let prevToolKeySide: string | undefined;
  let sidechainApiCalls = 0;
  let sidechainCost = 0;
  let activeMs = 0;
  let prevEventMs: number | undefined;
  const allCalls: ApiCall[] = [];

  // Streamed responses are logged as one `assistant` line per content block,
  // each repeating the same message id and full usage. Merge those lines into a
  // single ApiCall keyed by (message id / requestId), counting usage once —
  // keyed rather than adjacency-based so interleaved main-chain and sidechain
  // streams still merge to the right call.
  const callsByKey = new Map<string, ApiCall>();
  const usageKey = (e: AssistantEvent): string | undefined => {
    const mid = e.message.id;
    if (mid && e.requestId) return `${mid}:${e.requestId}`;
    return mid ?? e.requestId;
  };

  const touchTime = (ts?: string) => {
    if (!ts) return;
    if (!startTime || ts < startTime) startTime = ts;
    if (!endTime || ts > endTime) endTime = ts;
    if (current) {
      if (!current.startTime || ts < current.startTime) current.startTime = ts;
      if (!current.endTime || ts > current.endTime) current.endTime = ts;
    }
    // Active time: events are appended roughly chronologically, so short gaps
    // between consecutive events are work; long ones are the session sitting
    // idle. The cursor only moves forward — interleaved sidechain lines can
    // arrive out of order, and re-walking an already-covered interval would
    // double-count it and break the activeMs ≤ durationMs invariant.
    const ms = Date.parse(ts);
    if (!Number.isNaN(ms) && (prevEventMs === undefined || ms > prevEventMs)) {
      if (prevEventMs !== undefined) {
        const gap = ms - prevEventMs;
        if (gap <= ACTIVE_GAP_MS) activeMs += gap;
      }
      prevEventMs = ms;
    }
  };

  for (const event of events) {
    const meta = event as {
      sessionId?: string;
      cwd?: string;
      gitBranch?: string;
      version?: string;
      timestamp?: string;
      type?: string;
      aiTitle?: string;
    };
    if (meta.sessionId && !sessionId) sessionId = meta.sessionId;
    if (meta.cwd && !projectPath) projectPath = meta.cwd;
    if (meta.gitBranch) gitBranches.add(meta.gitBranch);
    if (meta.version) versions.add(meta.version);
    if (meta.type === "ai-title" && meta.aiTitle) title = meta.aiTitle;

    if (isUser(event) && isRealPrompt(event)) {
      current = {
        index: turns.length,
        prompt: promptPreview(event.message.content),
        promptId: event.promptId,
        permissionMode: event.permissionMode,
        models: [],
        apiCalls: [],
        tokens: zeroTokens(),
        cost: zeroCost(),
        toolCounts: {},
      };
      turns.push(current);
      const mode = event.permissionMode ?? "default";
      permissionModes[mode] = (permissionModes[mode] ?? 0) + 1;
      // A new turn is a fresh start: repeating the previous turn's last call
      // (e.g. the user asked to run it again) is not churn.
      prevToolKeyMain = undefined;
      prevToolKeySide = undefined;
      touchTime(event.timestamp);
      continue;
    }

    if (isAssistant(event)) {
      touchTime(event.timestamp);
      const key = usageKey(event);
      const existing = key !== undefined ? callsByKey.get(key) : undefined;

      const steps: TurnStep[] = [];
      for (const block of event.message.content) {
        const b = block as ContentBlock & { text?: string; thinking?: string };
        if (b.type === "text") {
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
        toolCallCount += 1;
        tools[tu.name] = (tools[tu.name] ?? 0) + 1;
        if (current) current.toolCounts[tu.name] = (current.toolCounts[tu.name] ?? 0) + 1;

        // Churn: a tool call identical to the immediately preceding one on
        // the same chain (same tool, same input) is a retry — the loop re-did
        // work it just did.
        const toolKey = `${tu.name} ${JSON.stringify(tu.input ?? null)}`;
        const onSidechain = event.isSidechain === true;
        if (toolKey === (onSidechain ? prevToolKeySide : prevToolKeyMain)) {
          retries += 1;
          retriesByTool[tu.name] = (retriesByTool[tu.name] ?? 0) + 1;
        }
        if (onSidechain) prevToolKeySide = toolKey;
        else prevToolKeyMain = toolKey;

        let skillName: string | undefined;
        if (tu.name === "Skill") {
          skillName = stringField(tu.input, "skill") ?? stringField(tu.input, "command");
          if (skillName) skills[skillName] = (skills[skillName] ?? 0) + 1;
        } else if (tu.name === "Task" || tu.name === "Agent") {
          const t = stringField(tu.input, "subagent_type");
          if (t) subagents.add(t);
        }
        if (FILE_TOOLS.has(tu.name)) {
          const fp = stringField(tu.input, "file_path");
          if (fp) filesTouched.add(fp);
        }

        const result = toolResults.get(tu.id);
        if (tu.name === "Bash") {
          const cmd = stringField(tu.input, "command");
          if (cmd) {
            const family = commandFamily(cmd);
            if (family) {
              bashCommands[family] = (bashCommands[family] ?? 0) + 1;
              if (result?.isError) bashErrors[family] = (bashErrors[family] ?? 0) + 1;
            }
            if (isTestCommand(cmd)) {
              testRuns += 1;
              if (result?.isError) testFailures += 1;
            }
          }
        }
        if (result?.isError) {
          toolErrors[tu.name] = (toolErrors[tu.name] ?? 0) + 1;
          if (skillName) skillErrors[skillName] = (skillErrors[skillName] ?? 0) + 1;
        }
        const { kind, label, summary } = summarizeToolUse(tu.name, tu.input);
        const inputCapped = capDetail(JSON.stringify(tu.input ?? null, null, 2));
        const resultCapped = result ? capDetail(result.text) : undefined;
        steps.push({
          kind,
          tool: tu.name,
          label,
          summary,
          toolUseId: tu.id,
          status: result ? (result.isError ? "error" : "ok") : undefined,
          resultHint: result ? makeResultHint(result.isError, result.text) : undefined,
          detail: {
            input: inputCapped.text,
            result: resultCapped?.text,
            truncated: inputCapped.truncated || resultCapped?.truncated === true,
          },
        });
      }

      // A continuation line of an already-counted API call: keep its steps on
      // the originating ApiCall, but never re-count its usage or re-price it.
      // stop_reason arrives on whichever streamed line closed the response, so
      // continuation lines may carry it for an already-created call.
      if (existing) {
        existing.steps.push(...steps);
        if (event.message.stop_reason) existing.stopReason = event.message.stop_reason;
        continue;
      }

      // First (or only) line of this API call: count and price its usage once.
      const usage = event.message.usage;
      webSearches += usage?.server_tool_use?.web_search_requests ?? 0;
      webFetches += usage?.server_tool_use?.web_fetch_requests ?? 0;

      const tokens = usageToTokens(usage);
      const model = event.message.model;
      const resolved = model ? resolveModel(pricing, model) : undefined;
      const cost = computeCost(tokens, resolved?.pricing);
      // A family-heuristic match (non-exact) is still an estimate.
      if (resolved && !resolved.exact) cost.estimated = true;

      const apiCall: ApiCall = {
        uuid: event.uuid,
        model,
        timestamp: event.timestamp,
        isSidechain: event.isSidechain === true,
        stopReason: event.message.stop_reason ?? undefined,
        tokens,
        cost,
        steps,
      };
      if (key !== undefined) callsByKey.set(key, apiCall);
      allCalls.push(apiCall);

      apiCallCount += 1;
      if (apiCall.isSidechain) {
        sidechainApiCalls += 1;
        sidechainCost += cost.total;
      }
      totalTokens = addTokens(totalTokens, tokens);
      totalCost = addCost(totalCost, cost);
      if (model) {
        let mu = models[model];
        if (!mu) {
          mu = { apiCalls: 0, tokens: zeroTokens(), cost: zeroCost() };
          models[model] = mu;
        }
        mu.apiCalls += 1;
        mu.tokens = addTokens(mu.tokens, tokens);
        mu.cost = addCost(mu.cost, cost);
      }

      if (current) {
        current.apiCalls.push(apiCall);
        current.tokens = addTokens(current.tokens, tokens);
        current.cost = addCost(current.cost, cost);
        if (model && !current.models.includes(model)) current.models.push(model);
      }
      continue;
    }

    touchTime((event as { timestamp?: string }).timestamp);
  }

  // stop_reason may land on any streamed line of a call, so it's folded here,
  // after every continuation line has had a chance to fill it in.
  for (const call of allCalls) {
    if (call.stopReason) stopReasons[call.stopReason] = (stopReasons[call.stopReason] ?? 0) + 1;
  }

  // Totals are accumulated over every API call — including calls that arrive
  // before the first genuine prompt — so they always agree with `models`.
  const totals: SessionTotals = {
    turns: turns.length,
    apiCalls: apiCallCount,
    toolCalls: toolCallCount,
    tokens: totalTokens,
    cost: totalCost,
    webSearches,
    webFetches,
    sidechainApiCalls,
    sidechainCost,
    activeMs,
  };

  return {
    sessionId,
    title,
    projectPath,
    gitBranches: [...gitBranches],
    versions: [...versions],
    startTime,
    endTime,
    durationMs:
      startTime && endTime
        ? new Date(endTime).getTime() - new Date(startTime).getTime()
        : undefined,
    totals,
    turns,
    models,
    tools,
    toolErrors,
    skills,
    skillErrors,
    subagents: [...subagents],
    filesTouched: [...filesTouched],
    stopReasons,
    permissionModes,
    bashCommands,
    bashErrors,
    testRuns,
    testFailures,
    retries,
    retriesByTool,
  };
}
