import { canonicalMediaPart, linkCanonicalMediaPart } from "./media-content.js";
/** Compiler-owned materialization planning. AppServer alone performs commits. */
import type { CanonicalItem, ContextMessageItem, UserInput } from "./item.js";
import {
  copyModelMessageContextCategory,
  modelMessageSource,
  modelUserContent,
  type ModelMessage,
} from "./model.js";

interface MessageBinding {
  itemId: string;
  content: UserInput;
}
const bindings = new WeakMap<object, MessageBinding>();
/** Passive inspection identity; absence never authorizes dispatch. */
export function committedModelContentItemId(
  message: object,
): string | undefined {
  return bindings.get(message)?.itemId;
}

export function copyCommittedMessageBinding(
  source: object,
  target: object,
): void {
  const binding = bindings.get(source);
  if (binding) bindings.set(target, binding);
}

/** Opaque provider reasoning is protocol data; only its public summary is text. */
export function messageSemanticContent(message: ModelMessage): UserInput {
  if (message.role === "user") return modelUserContent(message);
  if (message.role === "tool")
    return [
      { type: "text", text: message.text },
      ...(message.modelContent ?? []),
    ];
  if (message.role === "reasoning")
    return [
      ...(message.contentVisibility === "public"
        ? [{ type: "text" as const, text: message.reasoningContent }]
        : []),
      ...(message.summary === undefined
        ? []
        : [{ type: "text" as const, text: message.summary }]),
    ];
  return message.text ? [{ type: "text", text: message.text }] : [];
}

function sameContent(left: UserInput, right: UserInput): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function key(
  item: Pick<
    ContextMessageItem,
    | "sourceItemIds"
    | "role"
    | "origin"
    | "purpose"
    | "compilerPolicyVersion"
    | "variant"
  >,
): string {
  return JSON.stringify([
    item.sourceItemIds,
    item.role,
    item.origin,
    item.purpose,
    item.compilerPolicyVersion,
    item.variant,
  ]);
}

export interface ContextMaterializationPlan {
  pending: ContextMessageItem[];
  /** Resolves only from the confirmed journal view, not from pending drafts. */
  resolve(items: readonly CanonicalItem[]): {
    messages: ModelMessage[];
    instructions?: string;
    instructionsItemId?: string;
  };
}

export function planContextMaterialization(options: {
  items: readonly CanonicalItem[];
  messages: readonly ModelMessage[];
  threadId: string;
  turnId?: string;
  instructions?: string | undefined;
  inputModalities?: readonly string[] | null | undefined;
  id: () => string;
  now: () => string;
}): ContextMaterializationPlan {
  const pending: ContextMessageItem[] = [];
  const existing = new Map<string, ContextMessageItem>();
  for (const item of options.items)
    if (item.type === "context_message") {
      const prior = existing.get(key(item));
      if (prior && !sameContent(prior.content, item.content))
        throw new Error("Conflicting canonical context materialization");
      existing.set(key(item), item);
    }
  const requireRecord = (
    content: UserInput,
    role: ContextMessageItem["role"],
    source: {
      itemIds: string[];
      purpose: string;
      origin: ContextMessageItem["origin"];
      variant?: string;
    },
  ): string => {
    if (
      !source.itemIds.length ||
      source.itemIds.some((id) => !options.items.some((item) => item.id === id))
    )
      throw new Error("Model context has no committed canonical source");
    const draft: ContextMessageItem = {
      type: "context_message",
      id: "",
      threadId: options.threadId,
      ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
      createdAt: "",
      compilerPolicyVersion: 1,
      sourceItemIds: [...source.itemIds],
      role,
      origin: source.origin,
      purpose: source.purpose,
      variant: source.variant ?? "base",
      content: structuredClone(content),
    };
    const prior = existing.get(key(draft));
    if (prior) {
      if (
        source.purpose === "provider-instructions" &&
        !sameContent(prior.content, content)
      )
        throw new Error(
          "Provider instructions changed within a canonical admission; start a new Turn before sampling",
        );
      // This semantic state already has an authority. Current templates are
      // not allowed to silently rewrite the text established by that record.
      return prior.id;
    }
    draft.id = options.id();
    draft.createdAt = options.now();
    pending.push(draft);
    existing.set(key(draft), draft);
    return draft.id;
  };
  const targets = options.messages.map((message) => {
    const content = messageSemanticContent(message);
    if (!content.length) return undefined;
    const source = modelMessageSource(message);
    if (!source) throw new Error("Model message bypassed the context compiler");
    const direct =
      source.itemIds.length === 1
        ? options.items.find((item) => item.id === source.itemIds[0])
        : undefined;
    // A new human message already owns its complete text and metadata. Do not
    // manufacture another record or a per-sample copy of that same content.
    if (
      direct?.type === "user_message" &&
      direct.contentAuthority?.version === 1 &&
      direct.content &&
      sameContent(content, direct.content)
    )
      return direct.id;
    const sourceItems = options.items.filter((item) =>
      source.itemIds.includes(item.id),
    );
    const hasMedia = sourceItems.some((item) => {
      const parts =
        item.type === "user_message" || item.type === "thread_message"
          ? item.content
          : item.type === "tool_result"
            ? item.modelContent
            : undefined;
      return parts?.some((part) => part.type !== "text");
    });
    if (!hasMedia) return requireRecord(content, message.role, source);
    const terminalTurns = new Set(
      options.items
        .filter(
          (item) =>
            item.type === "turn_completed" || item.type === "turn_aborted",
        )
        .map((item) => item.turnId),
    );
    const recoveries = options.items.filter(
      (item) =>
        item.type === "failure" &&
        item.recovery &&
        (item.recovery.mediaScope === "exact" ||
          !terminalTurns.has(item.turnId)) &&
        item.recovery.withheldMedia.some((part) =>
          source.itemIds.includes(part.itemId),
        ),
    );
    return requireRecord(content, message.role, {
      ...source,
      itemIds: [
        ...new Set([...source.itemIds, ...recoveries.map((item) => item.id)]),
      ],
      variant: JSON.stringify([
        source.variant ?? "base",
        "media",
        [...new Set(options.inputModalities ?? ["text"])].sort(),
      ]),
    });
  });
  const instructionsId = options.instructions
    ? requireRecord([{ type: "text", text: options.instructions }], "system", {
        itemIds: [
          options.items.findLast(
            (item) =>
              item.type === "turn_started" ||
              (item.type === "thread_configuration_changed" &&
                !("permissions" in item)),
          )?.id ?? options.items[0]!.id,
        ],
        purpose: "provider-instructions",
        origin: "host",
      })
    : undefined;
  return {
    pending,
    resolve(items) {
      const byId = new Map(items.map((item) => [item.id, item]));
      const contentFor = (id: string): UserInput => {
        const item = byId.get(id);
        if (
          !(
            item?.type === "context_message" || item?.type === "user_message"
          ) ||
          !item.content
        )
          throw new Error(
            "Model dispatch requires confirmed canonical content commit",
          );
        return item.content;
      };
      const messages = options.messages.map((message, index) => {
        const id = targets[index];
        if (id === undefined) return message;
        const content = contentFor(id);
        // Follow the compiler's exact ephemeral occurrence identity, never a
        // hash/value search: equal blobs can be distinct canonical occurrences.
        const plannedContent = messageSemanticContent(message);
        const resolvedContent = content.map((part, index) => {
          const cloned = structuredClone(part);
          if (part.type === "text") return cloned;
          const planned = plannedContent[index];
          if (
            planned === undefined ||
            planned.type === "text" ||
            JSON.stringify(planned) !== JSON.stringify(part)
          )
            throw new Error(
              "Canonical media occurrence no longer matches the selected source",
            );
          linkCanonicalMediaPart(canonicalMediaPart(planned), cloned);
          return cloned;
        });
        const resolved = restoreMessageContent(message, resolvedContent);
        copyModelMessageContextCategory(message, resolved);
        bindings.set(resolved, { itemId: id, content });
        return resolved;
      });
      if (instructionsId === undefined) return { messages };
      const content = contentFor(instructionsId);
      const first = content[0];
      if (first?.type !== "text")
        throw new Error("Invalid canonical system instructions");
      return {
        messages,
        instructions: first.text,
        instructionsItemId: instructionsId,
      };
    },
  };
}

function restoreMessageContent(
  message: ModelMessage,
  content: UserInput,
): ModelMessage {
  const textAt = (index: number): string => {
    const part = content[index];
    if (part?.type !== "text") throw new Error("Expected canonical text part");
    return part.text;
  };
  if (message.role === "user") {
    if (
      "text" in message &&
      content.length === 1 &&
      content[0]?.type === "text"
    )
      return { ...message, text: content[0].text };
    return { ...message, content };
  }
  if (message.role === "tool")
    return {
      ...message,
      text: textAt(0),
      ...(content.length > 1 ? { modelContent: content.slice(1) } : {}),
    };
  if (message.role === "reasoning") {
    if (message.contentVisibility === "opaque")
      return { ...message, summary: textAt(0) };
    return {
      ...message,
      reasoningContent: textAt(0),
      ...(content.length > 1 ? { summary: textAt(1) } : {}),
    };
  }
  return { ...message, text: textAt(0) };
}

export function assertCommittedModelContent(
  items: readonly CanonicalItem[],
  messages: readonly ModelMessage[],
  instructions?: string,
  instructionsItemId?: string,
): void {
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const message of messages) {
    const content = messageSemanticContent(message);
    if (!content.length) continue;
    const binding = bindings.get(message);
    const item = binding && byId.get(binding.itemId);
    if (
      !(item?.type === "context_message" || item?.type === "user_message") ||
      !item.content ||
      !sameContent(content, item.content)
    )
      throw new Error("Uncommitted model message content: dispatch refused");
    if (
      (item.type === "context_message" && item.role !== message.role) ||
      (item.type === "user_message" && message.role !== "user")
    )
      throw new Error("Canonical model message role changed");
    if (message.role === "tool" && item.type === "context_message") {
      const result = item.sourceItemIds
        .map((id) => byId.get(id))
        .find((source) => source?.type === "tool_result");
      if (result?.type !== "tool_result" || result.callId !== message.callId)
        throw new Error("Canonical tool result pairing changed");
    }
  }
  if (instructions) {
    const item = instructionsItemId && byId.get(instructionsItemId);
    if (
      !item ||
      item.type !== "context_message" ||
      item.role !== "system" ||
      !sameContent(item.content, [{ type: "text", text: instructions }])
    )
      throw new Error("Uncommitted model instructions: dispatch refused");
  }
}
