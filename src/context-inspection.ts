import type {
  CanonicalItem,
  CanonicalProviderSelection,
  UserInput,
} from "./item.js";
import { latestCompaction } from "./context-compaction.js";
import { compileModelMessages, type ModelMessage } from "./model.js";
import { estimateModelMessageInputTokens } from "./model-usage.js";

export interface ContextPreview {
  text: string;
  truncated: boolean;
}
export interface ContextInspection {
  throughItemId: string | null;
  estimatedMessageTokens: number;
  messageCount: number;
  messages: Array<{ role: ModelMessage["role"]; preview: ContextPreview }>;
  rules: Array<{ source: string; preview: ContextPreview }>;
  rulesOmitted: number;
  compaction: null | {
    source: string;
    boundary: string;
    summary: ContextPreview;
    retainedItemIds: string[];
    retainedOmitted: number;
  };
  toolNames: string[];
}

export function isContextInspection(
  value: unknown,
): value is ContextInspection {
  const record = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null;
  const count = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const strings = (v: unknown) =>
    Array.isArray(v) && v.every((x) => typeof x === "string");
  const isPreview = (v: unknown) =>
    record(v) && typeof v.text === "string" && typeof v.truncated === "boolean";
  if (!record(value)) return false;
  const c = value.compaction;
  return (
    (value.throughItemId === null || typeof value.throughItemId === "string") &&
    count(value.estimatedMessageTokens) &&
    count(value.messageCount) &&
    count(value.rulesOmitted) &&
    strings(value.toolNames) &&
    Array.isArray(value.rules) &&
    value.rules.every(
      (r) => record(r) && typeof r.source === "string" && isPreview(r.preview),
    ) &&
    Array.isArray(value.messages) &&
    value.messages.every(
      (m) =>
        record(m) &&
        ["user", "assistant", "tool", "reasoning"].includes(String(m.role)) &&
        isPreview(m.preview),
    ) &&
    (c === null ||
      (record(c) &&
        typeof c.source === "string" &&
        typeof c.boundary === "string" &&
        isPreview(c.summary) &&
        strings(c.retainedItemIds) &&
        count(c.retainedOmitted)))
  );
}

const preview = (text: string): ContextPreview => ({
  text: text.slice(0, 2000),
  truncated: text.length > 2000,
});
// Never serialize binary/media payloads, or opaque provider reasoning, into the inspector.
function contentText(content: UserInput): string {
  return content
    .map((part) =>
      part.type === "text"
        ? part.text
        : `[${part.type} attachment; payload omitted]`,
    )
    .join("\n");
}
function messageText(message: ModelMessage): string {
  if (message.role === "reasoning")
    return message.contentVisibility === "opaque"
      ? "[Opaque provider reasoning; content unavailable]"
      : (message.summary ?? message.reasoningContent);
  if (message.role === "user")
    return "content" in message ? contentText(message.content) : message.text;
  if (message.role === "tool")
    return `${message.callId}\n${message.text}${message.modelContent ? `\n${contentText(message.modelContent)}` : ""}`;
  return `${message.text ?? ""}${"toolCalls" in message ? `\n${message.toolCalls.map((call) => call.name).join(", ")}` : ""}`;
}

export function projectContextInspection(
  items: readonly CanonicalItem[],
  selection?: CanonicalProviderSelection,
): ContextInspection {
  const messages = compileModelMessages(items, selection);
  const compaction = latestCompaction(items);
  const ruleItem = items.findLast(
    (item) =>
      (item.type === "turn_started" || item.type === "context_compaction") &&
      item.workspaceInstructions !== undefined,
  );
  const rules =
    ruleItem?.type === "turn_started" || ruleItem?.type === "context_compaction"
      ? (ruleItem.workspaceInstructions ?? [])
      : [];
  return {
    throughItemId: items.at(-1)?.id ?? null,
    estimatedMessageTokens: estimateModelMessageInputTokens(messages),
    messageCount: messages.length,
    messages: messages.slice(-80).map((message) => ({
      role: message.role,
      preview: preview(messageText(message)),
    })),
    rules: rules
      .slice(0, 40)
      .map((file) => ({ source: file.path, preview: preview(file.text) })),
    rulesOmitted: Math.max(0, rules.length - 40),
    compaction: compaction
      ? {
          source: compaction.id,
          boundary: compaction.coveredThroughItemId,
          summary: preview(compaction.summary),
          retainedItemIds: compaction.retainedItemIds.slice(0, 80),
          retainedOmitted: Math.max(0, compaction.retainedItemIds.length - 80),
        }
      : null,
    toolNames: [
      ...new Set(
        messages.flatMap((message) =>
          message.role === "assistant" && "toolCalls" in message
            ? message.toolCalls.map((call) => call.name)
            : [],
        ),
      ),
    ].slice(0, 80),
  };
}
