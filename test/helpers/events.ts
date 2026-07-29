/**
 * Session-event builders shared by the analysis tests.
 *
 * Every suite that feeds `analyzeSession` hand-rolled the same three shapes —
 * an assistant line, a user prompt, a `tool_result` line — with only the fields
 * they cared about differing. These builders are the union of those shapes:
 * optional fields are *omitted* rather than defaulted, so a caller passing
 * nothing gets exactly the minimal event, and a suite that depends on (say) a
 * `stop_reason` or a `requestId` still spells it out.
 *
 * Events are cast to `SessionEvent`: they are literals written against the
 * undocumented JSONL shape, not parser output.
 */

import type { SessionEvent } from "../../src/core/events.ts";

/** ISO timestamps on a fixed UTC day — `clock(2026, 7, 1)(minutes, seconds)`. */
export function clock(year: number, month: number, day: number, hour = 12) {
  return (minutes: number, seconds = 0): string =>
    new Date(Date.UTC(year, month - 1, day, hour, minutes, seconds)).toISOString();
}

export interface AssistantOptions {
  uuid: string;
  timestamp: string;
  /** `message.id`; defaults to `msg_<uuid>`. */
  messageId?: string;
  model?: string;
  content?: unknown[];
  usage?: Record<string, unknown>;
  parentUuid?: string;
  isSidechain?: boolean;
  requestId?: string;
  /** Omitted entirely when undefined — pass `null` for an explicit null. */
  stopReason?: string | null;
}

/** One assistant line (one API response's content block, as Claude Code logs it). */
export function assistantEvent(opts: AssistantOptions): SessionEvent {
  return {
    type: "assistant",
    uuid: opts.uuid,
    timestamp: opts.timestamp,
    ...(opts.parentUuid === undefined ? {} : { parentUuid: opts.parentUuid }),
    ...(opts.isSidechain === undefined ? {} : { isSidechain: opts.isSidechain }),
    ...(opts.requestId === undefined ? {} : { requestId: opts.requestId }),
    message: {
      id: opts.messageId ?? `msg_${opts.uuid}`,
      role: "assistant",
      model: opts.model ?? "claude-opus-4-7",
      ...(opts.stopReason === undefined ? {} : { stop_reason: opts.stopReason }),
      content: opts.content ?? [{ type: "text", text: "ok" }],
      usage: opts.usage ?? { input_tokens: 10, output_tokens: 20 },
    },
  } as unknown as SessionEvent;
}

/** A genuine user prompt — the event `isRealPrompt()` opens a turn on. */
export function promptEvent(uuid: string, timestamp: string, text = uuid): SessionEvent {
  return {
    type: "user",
    uuid,
    timestamp,
    message: { role: "user", content: text },
  } as unknown as SessionEvent;
}

/** A `tool_use` content block, for an assistant line's `content`. */
export const toolUseBlock = (id: string, name: string, input: unknown) => ({
  type: "tool_use",
  id,
  name,
  input,
});

/** The user line carrying a tool's result back — never a real prompt. */
export function toolResultEvent(opts: {
  uuid: string;
  timestamp: string;
  toolUseId: string;
  isError: boolean;
  content?: string;
}): SessionEvent {
  return {
    type: "user",
    uuid: opts.uuid,
    timestamp: opts.timestamp,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: opts.toolUseId,
          is_error: opts.isError,
          content: opts.content ?? "out",
        },
      ],
    },
  } as unknown as SessionEvent;
}
