/**
 * Explainable structural health checks for one Claude Code session.
 *
 * The checks are deliberately conservative: they report observable conditions,
 * never repair source history, and treat missing parents as warnings because a
 * continuation file may legitimately begin in the middle of a chain.
 */

import {
  type ContentBlock,
  isInterruptionEvent,
  isRealPrompt,
  type ParseCoverage,
  type SessionEvent,
  type UserEvent,
} from "./events.ts";
import type { ParseError } from "./parser.ts";

export type SessionHealthStatus = "healthy" | "warning" | "damaged";
export type SessionHealthSeverity = "warning" | "error";

export type SessionHealthCode =
  | "unparseable-lines"
  | "schema-drift"
  | "empty-session"
  | "no-user-prompt"
  | "no-assistant-response"
  | "multiple-session-ids"
  | "duplicate-uuid"
  | "missing-parent"
  | "missing-leaf"
  | "unmatched-tool-use"
  | "orphan-tool-result"
  | "interrupted-response"
  | "unanswered-prompt";

export interface SessionHealthFinding {
  code: SessionHealthCode;
  severity: SessionHealthSeverity;
  title: string;
  evidence: string;
  action: string;
}

export interface SessionHealthReport {
  status: SessionHealthStatus;
  events: number;
  /** Lines that produced no event and were skipped. */
  parseErrors: number;
  /** Lines preserved only as tolerant unknown events. */
  unknownEvents: number;
  findings: SessionHealthFinding[];
}

interface EventMeta {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  sessionId?: unknown;
  leafUuid?: unknown;
  isSidechain?: unknown;
  message?: { content?: unknown };
}

function meta(event: SessionEvent): EventMeta {
  return event as EventMeta;
}

function contentBlocks(event: SessionEvent): ContentBlock[] {
  const content = meta(event).message?.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Build a read-only structural health report from a fully parsed session. */
export function inspectSessionHealth(
  events: SessionEvent[],
  parseErrors: ParseError[] = [],
  coverage?: ParseCoverage,
): SessionHealthReport {
  const findings: SessionHealthFinding[] = [];
  const schemaErrors = parseErrors.filter((error) => error.error.startsWith("schema mismatch"));
  const skippedErrors = parseErrors.length - schemaErrors.length;
  const unknownEvents = coverage?.unknownEvents ?? schemaErrors.length;

  if (skippedErrors > 0) {
    findings.push({
      code: "unparseable-lines",
      severity: "error",
      title: "Session contains unparseable records",
      evidence: `${plural(skippedErrors, "line")} could not be represented as session events and were skipped.`,
      action:
        "Preserve the source file and inspect the reported JSONL lines before relying on this history.",
    });
  }
  if (unknownEvents > 0) {
    findings.push({
      code: "schema-drift",
      severity: "warning",
      title: "Some records were kept as unknown events",
      evidence: `${plural(unknownEvents, "line")} used an unfamiliar type or schema and remained available through tolerant parsing.`,
      action:
        "Update cc-analyzer if possible; the installed Claude Code version may write newer fields.",
    });
  }

  if (events.length === 0) {
    findings.push({
      code: "empty-session",
      severity: "error",
      title: "No session events were readable",
      evidence: "The source produced zero usable events.",
      action:
        "Check that this is a Claude Code JSONL session and restore it from a backup if available.",
    });
    return finish(events.length, skippedErrors, unknownEvents, findings);
  }

  const prompts = events.filter(
    (event) =>
      meta(event).type === "user" &&
      isRealPrompt(event as UserEvent) &&
      !isInterruptionEvent(event as UserEvent),
  );
  const assistants = events.filter(
    (event) => meta(event).type === "assistant" && meta(event).isSidechain !== true,
  );

  if (prompts.length === 0) {
    findings.push({
      code: "no-user-prompt",
      severity: "warning",
      title: "No main-chain user prompt was found",
      evidence: "The file may be metadata-only or a continuation fragment.",
      action:
        "Locate the preceding or primary session file before attempting to resume this history.",
    });
  }
  if (assistants.length === 0) {
    findings.push({
      code: "no-assistant-response",
      severity: "warning",
      title: "No main-chain assistant response was found",
      evidence: "The session contains no recorded main-chain assistant event.",
      action: "Treat the last prompt as interrupted and resume only if its intent is still clear.",
    });
  }

  const sessionIds = new Set(
    events.flatMap((event) => {
      const value = meta(event).sessionId;
      return typeof value === "string" && value.length > 0 ? [value] : [];
    }),
  );
  if (sessionIds.size > 1) {
    findings.push({
      code: "multiple-session-ids",
      severity: "error",
      title: "Multiple session IDs appear in one source",
      evidence: `${sessionIds.size} distinct session IDs were recorded: ${[...sessionIds].slice(0, 3).join(", ")}${sessionIds.size > 3 ? ", …" : ""}.`,
      action:
        "Do not resume this file until you verify whether histories were concatenated or copied incorrectly.",
    });
  }

  const uuidCounts = new Map<string, number>();
  for (const event of events) {
    const uuid = meta(event).uuid;
    if (typeof uuid === "string" && uuid.length > 0) {
      uuidCounts.set(uuid, (uuidCounts.get(uuid) ?? 0) + 1);
    }
  }
  const duplicateUuids = [...uuidCounts].filter(([, count]) => count > 1);
  if (duplicateUuids.length > 0) {
    findings.push({
      code: "duplicate-uuid",
      severity: "error",
      title: "Duplicate event UUIDs were found",
      evidence: `${plural(duplicateUuids.length, "UUID")} appeared more than once.`,
      action: "Inspect the source for duplicated or merged records before trusting chain order.",
    });
  }

  const knownUuids = new Set(uuidCounts.keys());
  const missingParents = new Set<string>();
  for (const event of events) {
    const parent = meta(event).parentUuid;
    if (typeof parent === "string" && parent.length > 0 && !knownUuids.has(parent)) {
      missingParents.add(parent);
    }
  }
  if (missingParents.size > 0) {
    findings.push({
      code: "missing-parent",
      severity: "warning",
      title: "Some parent events are outside this file",
      evidence: `${plural(missingParents.size, "referenced parent")} could not be found locally.`,
      action:
        "Check for an earlier continuation file; this can be valid, but the local chain is incomplete.",
    });
  }

  const missingLeaves = new Set<string>();
  for (const event of events) {
    const leaf = meta(event).leafUuid;
    if (typeof leaf === "string" && leaf.length > 0 && !knownUuids.has(leaf))
      missingLeaves.add(leaf);
  }
  if (missingLeaves.size > 0) {
    findings.push({
      code: "missing-leaf",
      severity: "warning",
      title: "The recorded conversation leaf is missing",
      evidence: `${plural(missingLeaves.size, "leaf UUID")} did not resolve to an event in this file.`,
      action:
        "Claude Code may not be able to resume the intended branch; preserve the file and inspect related sessions.",
    });
  }

  const toolUses = new Set<string>();
  const toolResults = new Set<string>();
  for (const event of events) {
    for (const block of contentBlocks(event)) {
      if (block.type === "tool_use" && typeof block.id === "string") toolUses.add(block.id);
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        toolResults.add(block.tool_use_id);
      }
    }
  }
  const unmatchedUses = [...toolUses].filter((id) => !toolResults.has(id));
  if (unmatchedUses.length > 0) {
    findings.push({
      code: "unmatched-tool-use",
      severity: "warning",
      title: "Tool calls are missing recorded results",
      evidence: `${plural(unmatchedUses.length, "tool call")} had no matching tool_result record.`,
      action:
        "Treat the affected work as interrupted and verify its side effects before continuing.",
    });
  }
  const orphanResults = [...toolResults].filter((id) => !toolUses.has(id));
  if (orphanResults.length > 0) {
    findings.push({
      code: "orphan-tool-result",
      severity: "warning",
      title: "Tool results refer to calls outside this file",
      evidence: `${plural(orphanResults.length, "tool result")} had no matching tool_use record.`,
      action:
        "Look for an earlier continuation file before interpreting these results in isolation.",
    });
  }

  let finalPromptIndex = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (
      event &&
      meta(event).type === "user" &&
      isRealPrompt(event as UserEvent) &&
      !isInterruptionEvent(event as UserEvent)
    ) {
      finalPromptIndex = index;
      break;
    }
  }
  let finalInterruptionIndex = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (
      event &&
      meta(event).type === "user" &&
      meta(event).isSidechain !== true &&
      isInterruptionEvent(event as UserEvent)
    ) {
      finalInterruptionIndex = index;
      break;
    }
  }
  if (
    finalInterruptionIndex >= 0 &&
    !events
      .slice(finalInterruptionIndex + 1)
      .some((event) => meta(event).type === "assistant" && meta(event).isSidechain !== true)
  ) {
    findings.push({
      code: "interrupted-response",
      severity: "warning",
      title: "The session ended after an interruption",
      evidence: "A machine-written interruption marker has no later main-chain assistant response.",
      action:
        "Verify any pending tool side effects, then resume with the intended next instruction.",
    });
  }
  if (
    assistants.length > 0 &&
    finalPromptIndex >= 0 &&
    !events
      .slice(finalPromptIndex + 1)
      .some((event) => meta(event).type === "assistant" && meta(event).isSidechain !== true)
  ) {
    findings.push({
      code: "unanswered-prompt",
      severity: "warning",
      title: "The final prompt has no assistant response",
      evidence: "No main-chain assistant event follows the last genuine user prompt.",
      action:
        "Resume or restate the prompt only after checking whether its requested side effects already occurred.",
    });
  }

  return finish(events.length, skippedErrors, unknownEvents, findings);
}

function finish(
  events: number,
  parseErrors: number,
  unknownEvents: number,
  findings: SessionHealthFinding[],
): SessionHealthReport {
  const status: SessionHealthStatus = findings.some((finding) => finding.severity === "error")
    ? "damaged"
    : findings.length > 0
      ? "warning"
      : "healthy";
  return { status, events, parseErrors, unknownEvents, findings };
}
