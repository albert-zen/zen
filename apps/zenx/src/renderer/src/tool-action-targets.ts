import type { CanonicalItem } from "../../../../../src/item.js";
import type { ModelReferenceBinding } from "../../../../../src/model-references.js";
import type { MessageSourceTarget } from "./message-source-navigation.js";

/** Disposable links derived only from the exact canonical tool result and its trusted refs. */
export type ToolActionTarget = { label: "message" | "trigger" } & (
  { target: MessageSourceTarget } | { unavailable: "missing" | "remote" }
);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export function projectToolActionTargets(
  threadId: string,
  items: readonly CanonicalItem[],
): ReadonlyMap<string, ToolActionTarget> {
  const actions = new Map<string, ToolActionTarget>();
  const calls = new Map<
    string,
    Extract<CanonicalItem, { type: "tool_call" }>
  >();
  const bindings = new Map<string, ModelReferenceBinding>();
  for (const item of items) {
    if (item.threadId !== threadId) continue;
    if (item.type === "tool_call") {
      calls.set(item.callId, item);
      continue;
    }
    if (item.type !== "tool_result") continue;
    for (const binding of item.referenceBindings ?? [])
      if (binding.ownerThreadId === threadId)
        bindings.set(binding.ref, binding);
    const call = calls.get(item.callId);
    if (!call || call.imported || item.exitCode !== 0) continue;
    const label = ["zenx_threads_send", "zenx_subagents_send"].includes(
      call.name,
    )
      ? "message"
      : ["zenx_triggers_create", "zenx_triggers_update"].includes(call.name)
        ? "trigger"
        : undefined;
    if (!label) continue;
    let output: Record<string, unknown> | undefined;
    try {
      output = object(JSON.parse(item.output));
    } catch {
      /* No identity inferred from prose. */
    }
    const bound = (ref: unknown, namespace: string, kind: string) => {
      const binding = typeof ref === "string" ? bindings.get(ref) : undefined;
      return binding?.namespace === namespace && binding.kind === kind
        ? object(binding.value)
        : undefined;
    };
    if (label === "trigger") {
      const id =
        text(bound(output?.ref, "triggers", "trigger")?.id) ?? text(output?.id);
      const destinationThread =
        text(bound(output?.thread, "threads", "thread")?.id) ??
        text(output?.threadId);
      actions.set(
        call.id,
        id
          ? {
              label,
              target: {
                kind: "trigger",
                id,
                ...(destinationThread ? { threadId: destinationThread } : {}),
              },
            }
          : { label, unavailable: "missing" },
      );
      continue;
    }
    const thread = bound(output?.ref, "threads", "thread");
    const message = bound(output?.message, "threads", "item");
    const id = text(thread?.id) ?? text(output?.threadId);
    const itemId = text(message?.id) ?? text(output?.messageId);
    const remote =
      (thread?.device !== undefined && thread.device !== "local") ||
      (call.arguments.device !== undefined &&
        call.arguments.device !== "local");
    if (remote) actions.set(call.id, { label, unavailable: "remote" });
    else if (
      id &&
      itemId &&
      (!message || (message.threadId === id && message.device === "local"))
    )
      actions.set(call.id, { label, target: { kind: "thread", id, itemId } });
    else actions.set(call.id, { label, unavailable: "missing" });
  }
  return actions;
}

/** A queued receipt can only resolve via its canonical client identity, never matching text. */
export function resolveDeliveredMessage(
  items: readonly CanonicalItem[],
  receiptId: string,
): { itemId: string } | "missing" | "pending" | "cancelled" {
  const receipt = items.find((item) => item.id === receiptId);
  if (!receipt) return "missing";
  if (receipt.type === "thread_message" || receipt.type === "user_message")
    return { itemId: receipt.id };
  if (
    receipt.type !== "thread_message_queued" &&
    receipt.type !== "user_message_queued" &&
    receipt.type !== "turn_replacement_requested"
  )
    return "missing";
  if (
    items.some(
      (item) =>
        (item.type === "thread_message_cancelled" ||
          item.type === "user_message_queue_cancelled") &&
        item.threadId === receipt.threadId &&
        item.queuedItemId === receipt.id,
    )
  )
    return "cancelled";
  const delivered = items.find(
    (item) =>
      (item.type === "thread_message" || item.type === "user_message") &&
      item.threadId === receipt.threadId &&
      item.clientId === receipt.clientId,
  );
  return delivered ? { itemId: delivered.id } : "pending";
}
