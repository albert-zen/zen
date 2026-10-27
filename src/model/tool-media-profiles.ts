import type {
  ChatToolMediaCapability,
  ChatToolMediaEvidenceConflict,
} from "./tool-media-transport.js";

/** Deliberately empty: reviewed documentation does not yet prove a consistent native contract. */
export const BUILTIN_CHAT_TOOL_MEDIA_CAPABILITIES: readonly ChatToolMediaCapability[] =
  Object.freeze([]);

/** Evidence conflicts are observations, not inferred native capabilities or durable state. */
export const BUILTIN_CHAT_TOOL_MEDIA_EVIDENCE_CONFLICTS: readonly ChatToolMediaEvidenceConflict[] =
  Object.freeze([
    Object.freeze({
      protocol: "chat-completions" as const,
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-flash",
      reviewedOn: "2026-10-25",
      evidence:
        "https://api-docs.deepseek.com/api/create-chat-completion/ permits tool images; https://api-docs.deepseek.com/guides/vision/ says user-only",
    }),
    Object.freeze({
      protocol: "chat-completions" as const,
      endpoint:
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      model: "qwen3-vl-plus",
      reviewedOn: "2026-10-25",
      evidence:
        "https://help.aliyun.com/en/model-studio/qwen-function-calling permits tool images; https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions requires tool strings",
    }),
  ]);
