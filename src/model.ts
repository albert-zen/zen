import { deduplicateMediaContent } from "./model-content.js";
import {
  contentFromUserMessage,
  textFromUserInput,
  type CanonicalProviderSelection,
  type CanonicalItem,
  type UserInput,
} from "./item.js";
import {
  CONTEXT_COMPACTION_SUMMARY_PREFIX,
  isAgenticContextCompaction,
  itemsAfterLatestAgenticCompaction,
  latestCompaction,
} from "./context-compaction.js";

export interface TextModelMessage {
  role: "user" | "assistant";
  text: string;
}

export interface TypedUserModelMessage {
  role: "user";
  content: UserInput;
}

export interface ToolCallModelMessage {
  role: "assistant";
  text?: string;
  toolCalls: Array<{
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

export interface ToolResultModelMessage {
  role: "tool";
  callId: string;
  text: string;
  exitCode: number;
  modelContent?: UserInput;
}

export interface ReasoningModelMessage {
  role: "reasoning";
  reasoningContent: string;
  summary?: string;
  contentVisibility: "public" | "opaque";
  providerItemId?: string;
}

export type ModelMessage =
  | TextModelMessage
  | TypedUserModelMessage
  | ToolCallModelMessage
  | ToolResultModelMessage
  | ReasoningModelMessage;

export type ReasoningEffort = string;

export interface ModelRequest {
  model: string;
  /** null leaves Provider-specific reasoning controls out of the request. */
  reasoningEffort: ReasoningEffort | null;
  messages: ModelMessage[];
  tools: ModelTool[];
  signal: AbortSignal;
  /**
   * Optional provider cache hint. It identifies the authoritative Zen Thread,
   * but providers must not treat it as a second persisted conversation.
   */
  sessionId?: string;
}

export interface ModelTool {
  /** Optional source-language presentation; canonical arguments remain JSON. */
  rawSource?: { language: "javascript"; argument: "code" };
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ModelEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_started"; reasoningId: string }
  | {
      type: "reasoning_summary_delta";
      reasoningId: string;
      delta: string;
    }
  | {
      type: "reasoning_content_delta";
      reasoningId: string;
      delta: string;
    }
  | {
      type: "reasoning";
      reasoningId?: string;
      reasoningContent: string;
      summary?: string;
      contentVisibility: "public" | "opaque";
      providerItemId?: string;
    }
  | {
      type: "tool_call";
      callId: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: "usage";
      inputTokens: number;
      /** Total input tokens served from a Provider cache, when reported. */
      cachedInputTokens?: number;
      outputTokens: number;
      /** Output tokens spent on reasoning, when reported separately. */
      reasoningOutputTokens?: number;
    };

export interface ModelAdapter {
  readonly provider: string;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export function compileModelMessages(
  items: readonly CanonicalItem[],
  targetSelection?: CanonicalProviderSelection,
): ModelMessage[] {
  const turnSelections = new Map<string, CanonicalProviderSelection>();
  for (const item of items) {
    if (item.type === "turn_started" && item.selection !== undefined) {
      turnSelections.set(item.turnId, item.selection);
    }
  }
  const compaction = latestCompaction(items);
  if (compaction === undefined) {
    return compileCanonicalModelMessages(
      items,
      targetSelection,
      turnSelections,
    );
  }
  const boundaryIndex = items.findIndex(
    (item) => item.id === compaction.coveredThroughItemId,
  );
  if (boundaryIndex < 0) {
    throw new Error(
      `Context compaction boundary does not exist: ${compaction.coveredThroughItemId}`,
    );
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const retained = compaction.retainedItemIds.map((id) => {
    const item = byId.get(id);
    if (item === undefined) {
      throw new Error(`Retained context Item does not exist: ${id}`);
    }
    return item;
  });
  const afterBoundary = isAgenticContextCompaction(compaction)
    ? itemsAfterLatestAgenticCompaction(items)
    : items.slice(boundaryIndex + 1);
  const policyItem = items
    .slice(0, boundaryIndex + 1)
    .findLast(
      (item) =>
        item.type === "thread_metadata" ||
        (item.type === "thread_configuration_changed" && "permissions" in item),
    );
  const policy =
    policyItem?.type === "thread_metadata"
      ? policyItem.sandbox
      : policyItem?.type === "thread_configuration_changed" &&
          "permissions" in policyItem
        ? policyItem.permissions.to.sandbox
        : undefined;
  return [
    ...compileCanonicalModelMessages(retained, targetSelection, turnSelections),
    {
      role: "user",
      text: `${CONTEXT_COMPACTION_SUMMARY_PREFIX}${compaction.summary}`,
    },
    ...(policy !== undefined &&
    (policy !== "danger-full-access" ||
      policyItem?.type === "thread_configuration_changed")
      ? [{ role: "user" as const, text: filePermissionContext(policy) }]
      : []),
    ...compileCanonicalModelMessages(
      afterBoundary,
      targetSelection,
      turnSelections,
    ),
  ];
}

function compileCanonicalModelMessages(
  items: readonly CanonicalItem[],
  targetSelection: CanonicalProviderSelection | undefined,
  turnSelections: ReadonlyMap<string, CanonicalProviderSelection>,
): ModelMessage[] {
  items = withoutNestedToolLifecycle(orderSteeredMessagesForSampling(items));
  const messages: ModelMessage[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) {
      continue;
    }
    switch (item.type) {
      case "user_message":
        if (item.content === undefined) {
          messages.push({ role: "user", text: item.text });
        } else {
          messages.push({
            role: "user",
            content: contentFromUserMessage(item),
          });
        }
        break;
      case "agent_message":
        if (items[index + 1]?.type === "tool_call") {
          const toolCalls: ToolCallModelMessage["toolCalls"] = [];
          let cursor = index + 1;
          while (cursor < items.length) {
            const candidate = items[cursor];
            if (candidate?.type !== "tool_call") {
              break;
            }
            toolCalls.push({
              callId: candidate.callId,
              name: candidate.name,
              arguments: candidate.arguments,
            });
            cursor += 1;
          }
          messages.push({
            role: "assistant",
            text: item.text,
            toolCalls,
          });
          index = cursor - 1;
        } else if (item.text.length > 0) {
          messages.push({ role: "assistant", text: item.text });
        }
        break;
      case "tool_call":
        {
          const toolCalls: ToolCallModelMessage["toolCalls"] = [];
          let cursor = index;
          while (cursor < items.length) {
            const candidate = items[cursor];
            if (candidate?.type !== "tool_call") {
              break;
            }
            toolCalls.push({
              callId: candidate.callId,
              name: candidate.name,
              arguments: candidate.arguments,
            });
            cursor += 1;
          }
          messages.push({ role: "assistant", toolCalls });
          index = cursor - 1;
        }
        break;
      case "tool_result":
        messages.push({
          role: "tool",
          callId: item.callId,
          text: item.output,
          exitCode: item.exitCode,
          ...(item.modelContent === undefined
            ? {}
            : { modelContent: item.modelContent }),
        });
        break;
      case "reasoning": {
        if (item.incomplete === true) break;
        const producingSelection = turnSelections.get(item.turnId);
        if (
          targetSelection !== undefined &&
          producingSelection !== undefined &&
          producingSelection.providerProfileId ===
            targetSelection.providerProfileId &&
          producingSelection.modelId === targetSelection.modelId &&
          item.reasoningContent !== undefined &&
          item.contentVisibility !== undefined
        ) {
          messages.push({
            role: "reasoning",
            reasoningContent: item.reasoningContent,
            contentVisibility: item.contentVisibility,
            ...(item.summary === undefined ? {} : { summary: item.summary }),
            ...(item.providerItemId === undefined
              ? {}
              : { providerItemId: item.providerItemId }),
          });
        }
        break;
      }
      case "failure":
        messages.push({
          role: "assistant",
          text: `[failure: ${item.message}]`,
        });
        break;
      case "thread_metadata":
        if (item.sandbox !== "danger-full-access")
          messages.push({
            role: "user",
            text: filePermissionContext(item.sandbox),
          });
        break;
      case "thread_configuration_changed":
        if ("permissions" in item)
          messages.push({
            role: "user",
            text: filePermissionContext(item.permissions.to.sandbox),
          });
        break;
      case "context_compaction":
      case "model_usage":
      case "turn_aborted":
      case "turn_completed":
      case "user_message_queued":
      case "turn_replacement_requested":
      case "turn_started":
        break;
    }
  }
  return messages;
}

function withoutNestedToolLifecycle(
  items: readonly CanonicalItem[],
): readonly CanonicalItem[] {
  const nestedCalls = new Map<string, string>();
  for (const item of items) {
    if (item.type === "tool_call" && item.parentCallId !== undefined) {
      nestedCalls.set(
        `${item.turnId}\0${item.callId}`,
        `${item.turnId}\0${item.parentCallId}`,
      );
    }
  }
  if (nestedCalls.size === 0) return items;
  const modelContentByParent = new Map<string, UserInput>();
  for (const item of items) {
    if (item.type !== "tool_result" || item.modelContent === undefined)
      continue;
    let parent = nestedCalls.get(`${item.turnId}\0${item.callId}`);
    if (parent === undefined) continue;
    const ancestors = new Set<string>();
    while (nestedCalls.has(parent) && !ancestors.has(parent)) {
      ancestors.add(parent);
      parent = nestedCalls.get(parent)!;
    }
    modelContentByParent.set(parent, [
      ...(modelContentByParent.get(parent) ?? []),
      ...item.modelContent,
    ]);
  }
  const projected: CanonicalItem[] = [];
  for (const item of items) {
    if (item.type === "tool_call") {
      if (item.parentCallId === undefined) projected.push(item);
      continue;
    }
    if (item.type !== "tool_result") {
      projected.push(item);
      continue;
    }
    const key = `${item.turnId}\0${item.callId}`;
    if (nestedCalls.has(key)) continue;
    const nestedContent = modelContentByParent.get(key);
    projected.push(
      nestedContent === undefined
        ? item
        : {
            ...item,
            modelContent: deduplicateMediaContent([
              ...(item.modelContent ?? []),
              ...nestedContent,
            ]),
          },
    );
  }
  return projected;
}

/**
 * Canonical order records when facts happened. A steer accepted while a model
 * response or its tools are in flight therefore appears before that response
 * in the journal. `deliveryAfter` is the durable ordering anchor that lets the
 * sampling projection place the message after the completed assistant step.
 */
function orderSteeredMessagesForSampling(
  items: readonly CanonicalItem[],
): readonly CanonicalItem[] {
  const anchored = new Map<
    string,
    Array<{
      item: Extract<CanonicalItem, { type: "user_message" }>;
      index: number;
    }>
  >();
  const unanchored: Array<{ item: CanonicalItem; originalIndex: number }> = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) {
      continue;
    }
    if (item.type === "user_message" && item.deliveryAfter !== undefined) {
      const pending = anchored.get(item.deliveryAfter) ?? [];
      pending.push({ item, index });
      anchored.set(item.deliveryAfter, pending);
    } else {
      unanchored.push({ item, originalIndex: index });
    }
  }
  if (anchored.size === 0) {
    return items;
  }

  const insertion = new Map<number, CanonicalItem[]>();
  const fallback = new Map<number, CanonicalItem[]>();
  for (const [anchorId, pending] of anchored) {
    const anchorIndex = unanchored.findIndex(
      ({ item }) =>
        item.id === anchorId ||
        (item.type === "tool_call" && item.modelResponseId === anchorId),
    );
    if (anchorIndex < 0) {
      for (const { item, index } of pending) {
        const target = fallback.get(index) ?? [];
        target.push(item);
        fallback.set(index, target);
      }
      continue;
    }

    let insertionIndex = anchorIndex;
    const anchor = unanchored[anchorIndex]?.item;
    if (anchor?.type === "agent_message" || anchor?.type === "tool_call") {
      const callIds = new Set<string>();
      const firstCallIndex =
        anchor.type === "tool_call" ? anchorIndex : anchorIndex + 1;
      for (
        let cursor = firstCallIndex;
        cursor < unanchored.length;
        cursor += 1
      ) {
        const candidate = unanchored[cursor]?.item;
        if (
          candidate?.type !== "tool_call" ||
          candidate.modelResponseId !== anchorId
        ) {
          break;
        }
        callIds.add(candidate.callId);
      }
      if (callIds.size > 0) {
        for (
          let cursor = anchorIndex + 1;
          cursor < unanchored.length;
          cursor += 1
        ) {
          const candidate = unanchored[cursor]?.item;
          if (
            candidate?.type === "tool_result" &&
            callIds.has(candidate.callId)
          ) {
            insertionIndex = cursor;
          }
        }
      }
    }
    const target = insertion.get(insertionIndex) ?? [];
    target.push(...pending.map(({ item }) => item));
    insertion.set(insertionIndex, target);
  }

  const ordered: CanonicalItem[] = [];
  for (let index = 0; index < unanchored.length; index += 1) {
    const entry = unanchored[index];
    if (entry === undefined) {
      continue;
    }
    for (const [originalIndex, values] of [...fallback]) {
      if (originalIndex <= entry.originalIndex) {
        ordered.push(...values);
        fallback.delete(originalIndex);
      }
    }
    ordered.push(entry.item);
    ordered.push(...(insertion.get(index) ?? []));
  }
  for (const values of fallback.values()) {
    ordered.push(...values);
  }
  return ordered;
}

export class FakeModel implements ModelAdapter {
  readonly provider = "fake";

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const latest = request.messages.at(-1);
    if (latest?.role === "tool") {
      yield* streamWords(`Command result:\n${latest.text}`, request.signal);
      return;
    }

    const latestUser = [...request.messages]
      .reverse()
      .find(
        (message): message is TextModelMessage | TypedUserModelMessage =>
          message.role === "user",
      );
    const text =
      latestUser !== undefined &&
      "content" in latestUser &&
      latestUser.content !== undefined
        ? textFromUserInput(latestUser.content)
        : ((latestUser as TextModelMessage | undefined)?.text ?? "");
    if (text.startsWith("!shell ")) {
      yield {
        type: "tool_call",
        callId: `fake_${Date.now().toString(36)}`,
        name: "shell",
        arguments: { command: text.slice("!shell ".length) },
      };
      return;
    }
    if (text.startsWith("!tool ")) {
      const invocation = text.slice("!tool ".length);
      const separator = invocation.indexOf(" ");
      const name = separator < 0 ? invocation : invocation.slice(0, separator);
      const definition = request.tools.find((tool) => tool.name === name);
      if (definition === undefined) {
        yield* streamWords(`Unknown fake tool: ${name}`, request.signal);
        return;
      }
      const rawArguments =
        separator < 0 ? "{}" : invocation.slice(separator + 1);
      let arguments_: unknown;
      try {
        arguments_ = JSON.parse(rawArguments);
      } catch {
        yield* streamWords(
          `Invalid fake tool arguments for ${name}`,
          request.signal,
        );
        return;
      }
      if (
        typeof arguments_ !== "object" ||
        arguments_ === null ||
        Array.isArray(arguments_)
      ) {
        yield* streamWords(
          `Invalid fake tool arguments for ${name}`,
          request.signal,
        );
        return;
      }
      yield {
        type: "tool_call",
        callId: `fake_${Date.now().toString(36)}`,
        name,
        arguments: arguments_ as Record<string, unknown>,
      };
      return;
    }

    yield* streamWords(`Echo: ${text}`, request.signal);
    yield {
      type: "usage",
      inputTokens: text.length,
      outputTokens: text.length + 6,
    };
  }
}

async function* streamWords(
  text: string,
  signal: AbortSignal,
): AsyncIterable<ModelEvent> {
  const parts = text.match(/\S+\s*|\s+/g) ?? [text];
  for (const part of parts) {
    signal.throwIfAborted();
    yield { type: "text_delta", delta: part };
    await Promise.resolve();
  }
}

function filePermissionContext(
  sandbox: import("./item.js").SandboxMode,
): string {
  if (sandbox === "danger-full-access")
    return "File permission mode: Full Access. File operations may run without approval.";
  return `File permission mode: ${sandbox === "read-only" ? "Read Only: no automatic file writes" : "Workspace Write: write only within the thread working directory"}. Shell enforces the file policy; apply_patch rejects disallowed paths. Use shell sandbox_permissions: require_escalated to request one-time approval when broader file access is needed. run_code and plugin tools require one-time approval because their execution is not file-sandboxed. Network access is unchanged.`;
}
