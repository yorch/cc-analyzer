import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionAnalysis } from "./analyze.ts";
import { formatCount, formatUSD, pct } from "./format-shared.ts";
import { cacheTokens, ioTokens } from "./pricing.ts";
import type { WhatIfRepricing } from "./stats-types.ts";

/**
 * Hand a stored session off to a locally-installed Claude Code binary for a
 * natural-language retrospective. cc-analyzer stops at *numbers*; this asks
 * Claude Code to reason over the same session and say what happened and how to
 * run it better.
 *
 * This is the one place the otherwise read-only tool spawns a subprocess, and
 * it is careful about the read-only invariant over `~/.claude`:
 *   - It NEVER uses `--resume`, which would append new turns to the user's real
 *     session file. The session `.jsonl` is treated as an inert file that Claude
 *     *reads* (`--allowedTools Read`, scoped with `--add-dir <session dir>`).
 *   - It does NOT pass `--bare`. Bare mode ignores OAuth/keychain and demands
 *     `ANTHROPIC_API_KEY`; plain `claude -p` uses the user's normal login, which
 *     is what flat-plan (Pro/Max) users have. The cost is that the run loads the
 *     user's own hooks/CLAUDE.md — acceptable for an interactive, opt-in action.
 * The analysis run is itself a Claude Code session (the user's own, under their
 * normal data dir) and costs real tokens, so every surface makes it opt-in and
 * shows the run's own cost when it finishes.
 */

/** Default model for the retrospective: a strong reader at a fraction of opus's
 *  cost — the right default for an action a user may click repeatedly. */
export const DEFAULT_ANALYSIS_MODEL = "sonnet";

/** The model aliases offered as one-click choices; a full model id is also
 *  accepted (see `isValidModel`) and passed straight through to `--model`. */
export const ANALYSIS_MODELS = ["sonnet", "opus", "haiku"] as const;

/** Guard a model string before it reaches `claude --model`. `Bun.spawn` takes
 *  an argv array (no shell), so this is defense in depth for the web route,
 *  which accepts the model from the client. */
export function isValidModel(model: string): boolean {
  return /^[A-Za-z0-9._:-]+$/.test(model) && model.length <= 128;
}

/**
 * Absolute path to a usable `claude` binary, or undefined when Claude Code is
 * not installed — callers show an install hint rather than crashing on spawn.
 * `which` is injectable for tests.
 */
export function resolveClaudeBinary(
  which: (cmd: string) => string | null = (cmd) => Bun.which(cmd),
): string | undefined {
  const found = which("claude");
  if (found) return found;
  // Claude Code's local installer drops the binary here and only shims PATH via
  // a shell alias, which a spawned process won't see.
  const local = join(homedir(), ".claude", "local", "claude");
  return existsSync(local) ? local : undefined;
}

/** One line of a session's grounding digest, or a section skipped when empty. */
function metricLines(a: SessionAnalysis, whatIf?: WhatIfRepricing): string[] {
  const t = a.totals;
  const lines: string[] = [
    `- Cost: ${formatUSD(t.cost.total)}${t.cost.estimated ? " (estimated)" : ""}`,
    `- Tokens: ${formatCount(ioTokens(t.tokens))} I/O + ${formatCount(cacheTokens(t.tokens))} cache`,
    `- Turns: ${t.turns} · API calls: ${t.apiCalls} · Tool calls: ${t.toolCalls}`,
  ];
  if (t.sidechainApiCalls > 0) {
    lines.push(
      `- Subagents: ${formatUSD(t.sidechainCost)} over ${t.sidechainApiCalls} sidechain calls`,
    );
  }
  // Efficiency signals — only mention the ones that actually fired, so the model
  // isn't told "0 retries" as if it mattered.
  const churn: string[] = [];
  if (a.retries > 0) churn.push(`${a.retries} identical-retry tool calls`);
  if (a.redundantReads > 0) churn.push(`${a.redundantReads} redundant file reads`);
  if (a.testFailStreak > 0) churn.push(`longest failing-test streak ${a.testFailStreak}`);
  if (a.testRuns > 0) churn.push(`${a.testRuns} test runs (${a.testFailures} failed)`);
  if (churn.length > 0) lines.push(`- Churn: ${churn.join(", ")}`);
  const corrections: string[] = [];
  if (a.interruptionTurns > 0) corrections.push(`${a.interruptionTurns} interrupted turns`);
  if (a.correctionTurns > 0) {
    const share = t.turns > 0 ? ` (${pct(a.correctionTurns / t.turns)} of turns)` : "";
    corrections.push(`${a.correctionTurns} correction prompts${share}`);
  }
  if (corrections.length > 0) lines.push(`- Corrections: ${corrections.join(", ")}`);
  const ownCompactions = a.compactions.filter((c) => !c.isSidechain && !c.inherited).length;
  if (ownCompactions > 0) lines.push(`- Context compactions: ${ownCompactions}`);
  const models = Object.entries(a.models);
  if (models.length > 0) {
    const mix = models
      .map(([m, u]) => `${m} (${u.apiCalls} calls, ${formatUSD(u.cost.total)})`)
      .join(", ");
    lines.push(`- Model mix: ${mix}`);
  }
  if (whatIf?.summary.bestModel && whatIf.summary.bestDelta < 0) {
    lines.push(
      `- What-if: routing this mix through ${whatIf.summary.bestModel} would reprice to ` +
        `${formatUSD(whatIf.summary.bestCost)} (${formatUSD(whatIf.summary.bestDelta)}); a ` +
        `rate comparison only, tokens and quality would differ.`,
    );
  }
  return lines;
}

/**
 * The grounded analysis prompt handed to `claude -p`. cc-analyzer's own metrics
 * lead so the model reasons from real numbers rather than re-deriving them, then
 * it points at the full transcript for the qualitative read. The read-only
 * instruction is explicit even though the tool grant already enforces it.
 */
export function buildAnalysisPrompt(
  analysis: SessionAnalysis,
  sessionPath: string,
  opts: { whatIf?: WhatIfRepricing } = {},
): string {
  const title = analysis.title ?? analysis.sessionId ?? "(untitled)";
  return [
    "You are reviewing a past Claude Code session to help the user run similar work more effectively.",
    "",
    `Session: ${title}`,
    analysis.projectPath ? `Project: ${analysis.projectPath}` : undefined,
    "",
    "cc-analyzer already measured this session. Use these metrics as ground truth:",
    ...metricLines(analysis, opts.whatIf),
    "",
    `The full transcript is a JSON-lines file at:\n  ${sessionPath}`,
    "It may be large; read the parts you need (it is one JSON object per line).",
    "",
    "Give a concise retrospective covering:",
    "1. What the user was trying to accomplish, and whether it landed.",
    "2. Where time or tokens were spent inefficiently (retries, re-reads, failing-test loops, corrections, compactions).",
    "3. Concrete, specific suggestions to run a similar task faster and cheaper next time.",
    "",
    "This is a read-only review: do NOT modify, create, or delete any files, and do not run commands that change state.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/** A streamed event from a running analysis. */
export type AnalysisEvent =
  | { type: "text"; delta: string }
  | { type: "result"; text: string; costUsd?: number; model: string }
  | { type: "error"; message: string };

/** The subset of a spawned process this module consumes — injectable for tests. */
export interface SpawnedProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
}

export type Spawner = (cmd: string[], cwd: string) => SpawnedProcess;

const defaultSpawner: Spawner = (cmd, cwd) => {
  const child = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { stdout: child.stdout, stderr: child.stderr, exited: child.exited };
};

export interface RunAnalysisOptions {
  claudeBin: string;
  sessionPath: string;
  analysis: SessionAnalysis;
  model: string;
  whatIf?: WhatIfRepricing;
}

/** Build the `claude -p` argv. Exported so tests and callers can assert it. */
export function analysisArgv(opts: RunAnalysisOptions): string[] {
  return [
    opts.claudeBin,
    "-p",
    buildAnalysisPrompt(opts.analysis, opts.sessionPath, { whatIf: opts.whatIf }),
    "--add-dir",
    dirname(opts.sessionPath),
    "--allowedTools",
    "Read",
    "--model",
    opts.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        yield buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    }
    buf += decoder.decode();
    if (buf.trim().length > 0) yield buf;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Run the retrospective, yielding streamed `text` deltas, then a final `result`
 * (with the run's own cost) or an `error`. Parses Claude Code's `stream-json`
 * NDJSON: `stream_event` text deltas stream live, and the terminal `result`
 * message carries the full text and `total_cost_usd`.
 */
export async function* runClaudeAnalysis(
  opts: RunAnalysisOptions,
  deps: { spawn?: Spawner } = {},
): AsyncGenerator<AnalysisEvent> {
  const spawn = deps.spawn ?? defaultSpawner;
  const proc = spawn(analysisArgv(opts), dirname(opts.sessionPath));
  let sawResult = false;
  try {
    for await (const line of readLines(proc.stdout)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue; // Non-JSON noise (shouldn't happen on stdout) — skip.
      }
      if (obj.type === "stream_event") {
        const event = obj.event as { delta?: { type?: string; text?: string } } | undefined;
        if (event?.delta?.type === "text_delta" && typeof event.delta.text === "string") {
          yield { type: "text", delta: event.delta.text };
        }
        continue;
      }
      if (obj.type === "result") {
        sawResult = true;
        if (obj.is_error === true || typeof obj.result !== "string") {
          const msg =
            typeof obj.result === "string" ? obj.result : (obj.subtype as string) || "run failed";
          yield { type: "error", message: msg };
        } else {
          yield {
            type: "result",
            text: obj.result,
            costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined,
            model: opts.model,
          };
        }
      }
    }
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    return;
  }
  const code = await proc.exited;
  if (!sawResult) {
    let stderr = "";
    if (proc.stderr) {
      try {
        stderr = await new Response(proc.stderr).text();
      } catch {
        // best-effort
      }
    }
    yield {
      type: "error",
      message:
        stderr.trim() ||
        (code === 0 ? "Claude Code produced no result." : `Claude Code exited with code ${code}.`),
    };
  }
}

/** The message every surface shows when `claude` isn't installed. */
export const CLAUDE_NOT_FOUND_MESSAGE =
  "Claude Code (`claude`) was not found on PATH. Install it from https://claude.com/claude-code, " +
  "then try again.";
