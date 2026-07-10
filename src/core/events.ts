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
