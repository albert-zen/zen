import {
  previewFromInputMessage,
  type CanonicalItem,
} from "../../../../../src/item.js";

export type InformationCommunication = {
  id: string;
  senderThreadId: string;
  senderName?: string;
  sourceTool: { itemId: string; callId: string };
  excerpt: string;
};
export type InformationCommunications = {
  ownerThreadId: string;
  messages: readonly InformationCommunication[];
};

/** Only already-loaded canonical inbound local facts for this exact owner. */
export function projectInformationCommunications(
  ownerThreadId: string | null,
  loadedThreadId: string | undefined,
  pending: boolean,
  items: readonly CanonicalItem[] | undefined,
): InformationCommunications | undefined {
  if (!ownerThreadId || pending || loadedThreadId !== ownerThreadId || !items)
    return undefined;
  const messages: InformationCommunication[] = [];
  const seen = new Set<string>();
  for (
    let index = items.length - 1;
    index >= 0 && messages.length < 3;
    index--
  ) {
    const item = items[index]!;
    if (
      item.type !== "thread_message" ||
      item.threadId !== ownerThreadId ||
      item.sender.deviceId !== undefined ||
      !item.id ||
      seen.has(item.id) ||
      !item.sender.threadId ||
      !item.sender.toolCallId ||
      !item.sender.callId
    )
      continue;
    seen.add(item.id);
    const text = previewFromInputMessage(item).replace(/\s+/g, " ").trim();
    messages.push({
      id: item.id,
      senderThreadId: item.sender.threadId,
      senderName: item.sender.threadName,
      sourceTool: {
        itemId: item.sender.toolCallId,
        callId: item.sender.callId,
      },
      excerpt: text.length > 180 ? `${text.slice(0, 180)}…` : text,
    });
  }
  return { ownerThreadId, messages };
}
