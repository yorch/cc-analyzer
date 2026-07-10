/**
 * Turn "steps": a structured, human-readable timeline of what happened inside a
 * turn — assistant narration, thinking markers, and tool operations with a
 * tool-aware one-line summary plus a result status/hint. Shared by the web and
 * TUI turn views and by `analyze --json`.
 */

export type StepKind =
  | "note" // assistant narration text
  | "thinking" // reasoning marker
  | "run" // Bash / shell
  | "read" // Read
  | "edit" // Write / Edit / MultiEdit / NotebookEdit
  | "search" // Grep / Glob / ToolSearch
  | "skill" // Skill
  | "subagent" // Task / Agent
  | "web" // WebSearch / WebFetch
  | "task" // TodoWrite / TaskCreate / TaskUpdate / SendMessage
  | "ask" // AskUserQuestion
  | "tool"; // anything else

export interface StepDetail {
  /** Full tool input (JSON), capped. */
  input?: string;
  /** Full result or narration text, capped. */
  result?: string;
  truncated?: boolean;
}

export interface TurnStep {
  kind: StepKind;
  /** Raw tool name for operations. */
  tool?: string;
  /** Display label: "Bash", "Edit", "Skill", "Assistant", "thinking"… */
  label: string;
  /** One-line summary (command / path / query / skill / text snippet). */
  summary: string;
  status?: "ok" | "error";
  /** Short result hint: "exit 0", "3 lines", or an error's first line. */
  resultHint?: string;
  toolUseId?: string;
  detail?: StepDetail;
}

const DETAIL_CAP = 2000;
const SUMMARY_CAP = 140;

export function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** Cap a long string for inline "expand" detail, flagging truncation. */
export function capDetail(s: string): { text: string; truncated: boolean } {
  if (s.length <= DETAIL_CAP) return { text: s, truncated: false };
  return { text: s.slice(0, DETAIL_CAP), truncated: true };
}

function str(input: unknown, key: string): string | undefined {
  if (typeof input === "object" && input !== null && key in input) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return undefined;
}

/** Normalize a tool_result `content` (string | blocks) into readable text. */
export function resultToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        const block = b as { type?: string; text?: string };
        if (block.type === "text") return block.text ?? "";
        if (block.type === "image") return "[image]";
        return block.text ?? "";
      })
      .join("\n");
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return "";
}

export interface ToolSummary {
  kind: StepKind;
  label: string;
  summary: string;
}

/** Map a tool_use (name + input) to a kind, label, and one-line summary. */
export function summarizeToolUse(name: string, input: unknown): ToolSummary {
  const s = (v: string | undefined, fallback = "") => truncate(v ?? fallback, SUMMARY_CAP);
  switch (name) {
    case "Bash":
      return {
        kind: "run",
        label: "Bash",
        summary: s(str(input, "description") ?? str(input, "command")),
      };
    case "Read":
      return { kind: "read", label: "Read", summary: s(str(input, "file_path")) };
    case "Write":
      return { kind: "edit", label: "Write", summary: s(str(input, "file_path")) };
    case "Edit":
      return { kind: "edit", label: "Edit", summary: s(str(input, "file_path")) };
    case "MultiEdit":
      return { kind: "edit", label: "MultiEdit", summary: s(str(input, "file_path")) };
    case "NotebookEdit":
      return { kind: "edit", label: "NotebookEdit", summary: s(str(input, "notebook_path")) };
    case "Grep":
      return { kind: "search", label: "Grep", summary: s(str(input, "pattern")) };
    case "Glob":
      return { kind: "search", label: "Glob", summary: s(str(input, "pattern")) };
    case "ToolSearch":
      return { kind: "search", label: "ToolSearch", summary: s(str(input, "query")) };
    case "Skill":
      return {
        kind: "skill",
        label: "Skill",
        summary: s(str(input, "skill") ?? str(input, "command")),
      };
    case "Task":
    case "Agent": {
      const t = str(input, "subagent_type");
      const d = str(input, "description");
      return { kind: "subagent", label: name, summary: s([t, d].filter(Boolean).join(" · ")) };
    }
    case "WebSearch":
      return { kind: "web", label: "WebSearch", summary: s(str(input, "query")) };
    case "WebFetch":
      return { kind: "web", label: "WebFetch", summary: s(str(input, "url")) };
    case "AskUserQuestion":
      return {
        kind: "ask",
        label: "AskUserQuestion",
        summary: s(str(input, "question") ?? "question"),
      };
    case "TodoWrite":
      return { kind: "task", label: "TodoWrite", summary: "update todos" };
    case "TaskCreate":
      return {
        kind: "task",
        label: "TaskCreate",
        summary: s(str(input, "title") ?? str(input, "description")),
      };
    case "TaskUpdate":
      return {
        kind: "task",
        label: "TaskUpdate",
        summary: s(str(input, "status") ?? str(input, "title")),
      };
    case "SendMessage":
      return {
        kind: "task",
        label: "SendMessage",
        summary: s(str(input, "to") ?? str(input, "message")),
      };
    default: {
      // Generic: first string field or compact JSON.
      const first =
        input && typeof input === "object"
          ? Object.values(input as Record<string, unknown>).find((v) => typeof v === "string")
          : undefined;
      return { kind: "tool", label: name, summary: s(typeof first === "string" ? first : "") };
    }
  }
}

/** A short status hint derived from a tool's result text. */
export function makeResultHint(isError: boolean, resultText: string): string | undefined {
  const text = (resultText ?? "").trim();
  if (isError) {
    const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "error";
    return truncate(firstLine, 80);
  }
  if (text === "") return undefined;
  const lines = text.split("\n").length;
  if (lines > 1) return `${lines} lines`;
  return truncate(text, 80);
}
