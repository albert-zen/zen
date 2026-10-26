import type { AttachmentRef } from "../../../src/attachment-ref.js";
import {
  contentFromUserMessage,
  type CanonicalItem,
} from "../../../src/item.js";

export type ZenXThreadAttachmentProjection = Record<
  string,
  readonly AttachmentRef[]
>;

// The canonical Items already own these immutable references. Both Host and
// renderer use this pure projection; payload reads remain behind the Host API.
export function projectThreadAttachmentItems(
  items: readonly CanonicalItem[],
): ZenXThreadAttachmentProjection {
  const calls = new Map(
    items.flatMap((item) =>
      item.type === "tool_call"
        ? [[JSON.stringify([item.turnId, item.callId]), item.id] as const]
        : [],
    ),
  );
  return Object.fromEntries(
    items.flatMap((item) => {
      const id =
        item.type === "user_message" || item.type === "context_message"
          ? item.id
          : item.type === "tool_result"
            ? calls.get(JSON.stringify([item.turnId, item.callId]))
            : undefined;
      if (id === undefined) return [];
      const content =
        item.type === "user_message"
          ? contentFromUserMessage(item)
          : item.type === "context_message"
            ? item.content
            : item.type === "tool_result"
              ? (item.modelContent ?? [])
              : [];
      const attachments = content.flatMap((part) =>
        part.type === "image" ? [part.attachment] : [],
      );
      return attachments.length === 0 ? [] : [[id, attachments] as const];
    }),
  );
}
