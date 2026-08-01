import type { CanonicalItem } from "./item.js";

export interface TextModelMessage {
  role: "user" | "assistant";
  text: string;
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
}

export type ModelMessage =
  TextModelMessage | ToolCallModelMessage | ToolResultModelMessage;

export interface ModelRequest {
  model: string;
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
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ModelEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning"; summary: string }
  | {
      type: "tool_call";
      callId: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
    };

export interface ModelAdapter {
  readonly provider: string;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export function compileModelMessages(
  items: readonly CanonicalItem[],
): ModelMessage[] {
  items = orderSteeredMessagesForSampling(items);
  const messages: ModelMessage[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) {
      continue;
    }
    switch (item.type) {
      case "user_message":
        messages.push({ role: "user", text: item.text });
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
        });
        break;
      case "failure":
        messages.push({
          role: "assistant",
          text: `[failure: ${item.message}]`,
        });
        break;
      case "reasoning":
      case "thread_configuration_changed":
      case "thread_metadata":
      case "turn_aborted":
      case "turn_completed":
      case "turn_replacement_requested":
      case "turn_started":
        break;
    }
  }
  return messages;
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
      .find((message): message is TextModelMessage => message.role === "user");
    const text = latestUser?.text ?? "";
    if (text.startsWith("!shell ")) {
      yield {
        type: "tool_call",
        callId: `fake_${Date.now().toString(36)}`,
        name: "shell",
        arguments: { command: text.slice("!shell ".length) },
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
