import {
  type AssistantEvent,
  type ContentBlock,
  isRealPrompt,
  type SessionEvent,
  type UserEvent,
} from "./events.ts";

export type TranscriptRole = "user" | "assistant" | "system";
export type TranscriptKind = "prompt" | "text" | "thinking" | "tool_use" | "tool_result";

export interface TranscriptItem {
  index: number;
  turnIndex: number;
  role: TranscriptRole;
  kind: TranscriptKind;
  /** Short header label, e.g. "You", "Assistant", "thinking", "Bash". */
  label: string;
  /** Full text body (may be long; callers truncate for display). */
  body: string;
  isError?: boolean;
  timestamp?: string;
}

function isAssistant(e: SessionEvent): e is AssistantEvent {
  return (e as { type?: string }).type === "assistant";
}
function isUser(e: SessionEvent): e is UserEvent {
  return (e as { type?: string }).type === "user";
}

/** Normalize a tool_result `content` (string | blocks) into readable text. */
function contentToText(content: unknown): string {
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

/**
 * Flatten a session's events into a linear, human-readable transcript. Shared by
 * the TUI and web transcript readers. Turn numbering follows genuine prompts.
 */
export function buildTranscript(events: SessionEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let turnIndex = -1;
  let index = 0;

  const push = (item: Omit<TranscriptItem, "index" | "turnIndex">) => {
    items.push({ ...item, index: index++, turnIndex: Math.max(turnIndex, 0) });
  };

  for (const event of events) {
    if (isUser(event)) {
      const content = event.message.content;
      // Post-compaction summaries are machine-written, not prompts (see
      // isRealPrompt) — keep them readable but clearly labeled as system.
      if (event.isCompactSummary === true) {
        push({
          role: "system",
          kind: "text",
          label: "Compaction summary",
          body: typeof content === "string" ? content : contentToText(content),
          timestamp: event.timestamp,
        });
        continue;
      }
      if (isRealPrompt(event)) {
        turnIndex++;
        push({
          role: "user",
          kind: "prompt",
          label: "You",
          body: typeof content === "string" ? content : contentToText(content),
          timestamp: event.timestamp,
        });
        continue;
      }
      // tool_result carrier
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as ContentBlock & {
            tool_use_id?: string;
            content?: unknown;
            is_error?: boolean;
          };
          if (b.type === "tool_result") {
            push({
              role: "user",
              kind: "tool_result",
              label: b.is_error ? "result (error)" : "result",
              body: contentToText(b.content),
              isError: b.is_error === true,
              timestamp: event.timestamp,
            });
          }
        }
      }
      continue;
    }

    if (isAssistant(event)) {
      for (const block of event.message.content) {
        const b = block as ContentBlock & {
          text?: string;
          thinking?: string;
          name?: string;
          input?: unknown;
        };
        if (b.type === "text") {
          push({
            role: "assistant",
            kind: "text",
            label: "Assistant",
            body: b.text ?? "",
            timestamp: event.timestamp,
          });
        } else if (b.type === "thinking") {
          push({
            role: "assistant",
            kind: "thinking",
            label: "thinking",
            body: b.thinking ?? "",
            timestamp: event.timestamp,
          });
        } else if (b.type === "tool_use") {
          push({
            role: "assistant",
            kind: "tool_use",
            label: b.name ?? "tool",
            body: typeof b.input === "string" ? b.input : JSON.stringify(b.input, null, 2),
            timestamp: event.timestamp,
          });
        }
      }
    }
  }

  return items;
}
