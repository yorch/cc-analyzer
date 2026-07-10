import type {
  AssistantEvent,
  ContentBlock,
  SessionEvent,
  ToolUseBlock,
  Usage,
  UserEvent,
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

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  isError: boolean;
}

export interface ApiCall {
  uuid?: string;
  model?: string;
  timestamp?: string;
  isSidechain: boolean;
  tokens: TokenCounts;
  cost: CostBreakdown;
  toolCalls: ToolCall[];
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
  skills: string[];
  subagents: string[];
  filesTouched: string[];
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

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

/**
 * A user event starts a new turn only if it is a genuine prompt. User events
 * that merely carry `tool_result` blocks are loop continuations, not turns.
 */
function isRealPrompt(e: UserEvent): boolean {
  // System-injected user messages (caveats, command stdout, reminders) are not
  // genuine prompts. Note: promptId is present on tool_result carriers too, so
  // it cannot be used as a discriminator.
  if (e.isMeta === true) return false;
  const content = e.message.content;
  if (typeof content === "string") return true;
  return content.some((b) => (b as ContentBlock).type !== "tool_result");
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

/** Build a map of tool_use_id -> is_error from every tool_result in the session. */
function collectToolErrors(events: SessionEvent[]): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const e of events) {
    if (!isUser(e)) continue;
    const content = e.message.content;
    if (typeof content === "string") continue;
    for (const block of content) {
      const b = block as ContentBlock & { tool_use_id?: string; is_error?: boolean };
      if (b.type === "tool_result" && b.tool_use_id) {
        map.set(b.tool_use_id, b.is_error === true);
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
  const toolErrors = collectToolErrors(events);

  const turns: Turn[] = [];
  const gitBranches = new Set<string>();
  const versions = new Set<string>();
  const models: Record<string, ModelUsage> = {};
  const tools: Record<string, number> = {};
  const skills = new Set<string>();
  const subagents = new Set<string>();
  const filesTouched = new Set<string>();
  let title: string | undefined;
  let sessionId: string | undefined;
  let projectPath: string | undefined;
  let startTime: string | undefined;
  let endTime: string | undefined;
  let webSearches = 0;
  let webFetches = 0;
  let current: Turn | undefined;

  const touchTime = (ts?: string) => {
    if (!ts) return;
    if (!startTime || ts < startTime) startTime = ts;
    if (!endTime || ts > endTime) endTime = ts;
    if (current) {
      if (!current.startTime || ts < current.startTime) current.startTime = ts;
      if (!current.endTime || ts > current.endTime) current.endTime = ts;
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
      touchTime(event.timestamp);
      continue;
    }

    if (isAssistant(event)) {
      touchTime(event.timestamp);
      const usage = event.message.usage;
      webSearches += usage?.server_tool_use?.web_search_requests ?? 0;
      webFetches += usage?.server_tool_use?.web_fetch_requests ?? 0;

      const tokens = usageToTokens(usage);
      const model = event.message.model;
      const resolved = model ? resolveModel(pricing, model) : undefined;
      const cost = computeCost(tokens, resolved?.pricing);
      // A family-heuristic match (non-exact) is still an estimate.
      if (resolved && !resolved.exact) cost.estimated = true;

      const toolCalls: ToolCall[] = [];
      for (const block of event.message.content) {
        if ((block as ContentBlock).type !== "tool_use") continue;
        const tu = block as ToolUseBlock;
        tools[tu.name] = (tools[tu.name] ?? 0) + 1;
        toolCalls.push({
          id: tu.id,
          name: tu.name,
          input: tu.input,
          isError: toolErrors.get(tu.id) === true,
        });
        if (tu.name === "Skill") {
          const s = stringField(tu.input, "skill") ?? stringField(tu.input, "command");
          if (s) skills.add(s);
        } else if (tu.name === "Task") {
          const t = stringField(tu.input, "subagent_type");
          if (t) subagents.add(t);
        }
        if (FILE_TOOLS.has(tu.name)) {
          const fp = stringField(tu.input, "file_path");
          if (fp) filesTouched.add(fp);
        }
      }

      const apiCall: ApiCall = {
        uuid: event.uuid,
        model,
        timestamp: event.timestamp,
        isSidechain: event.isSidechain === true,
        tokens,
        cost,
        toolCalls,
      };

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
        for (const tc of toolCalls)
          current.toolCounts[tc.name] = (current.toolCounts[tc.name] ?? 0) + 1;
      }
      continue;
    }

    touchTime((event as { timestamp?: string }).timestamp);
  }

  const totals: SessionTotals = {
    turns: turns.length,
    apiCalls: 0,
    toolCalls: 0,
    tokens: zeroTokens(),
    cost: zeroCost(),
    webSearches,
    webFetches,
  };
  for (const turn of turns) {
    totals.apiCalls += turn.apiCalls.length;
    totals.tokens = addTokens(totals.tokens, turn.tokens);
    totals.cost = addCost(totals.cost, turn.cost);
    for (const call of turn.apiCalls) totals.toolCalls += call.toolCalls.length;
  }

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
    skills: [...skills],
    subagents: [...subagents],
    filesTouched: [...filesTouched],
  };
}
