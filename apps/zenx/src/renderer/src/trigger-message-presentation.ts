import type { ThreadItem } from "../../protocol-client/index.js";
import type { TriggerHistoryEntry } from "../../main/trigger-types.js";

/** UI-only projection of the Host's exact wakeup formatter. Never grants source authority. */
export function triggerMessagePresentation(
  text: string,
  sourceId?: string,
): {
  text: string;
  name?: string;
  envelope?: string;
} {
  const fallback = { text };
  if (!sourceId || /[\r\n]/u.test(sourceId)) return fallback;
  const prefix = `[ZenX trigger wakeup]\nTrigger ID: ${sourceId}\n`;
  if (!text.startsWith(prefix)) return fallback;
  const separator = "\n\nInjected prompt:\n";
  const boundary = text.indexOf(separator, prefix.length);
  if (boundary < 0 || text.slice(0, boundary).includes("\r")) return fallback;
  const lines = text.slice(prefix.length, boundary).split("\n");
  if (!lines.shift()?.startsWith("Reason: ")) return fallback;
  const registered = lines.pop();
  if (!registered?.startsWith("Registered trigger: ")) return fallback;
  const name = registered.slice("Registered trigger: ".length);
  if (!name.trim() || name.includes("\r")) return fallback;
  const fields = [
    "Source device: ",
    "Source workspace: ",
    "Source Thread: ",
    "Source Turn: ",
    "Source Room: ",
    "Source Room message: ",
  ];
  let previous = -1;
  for (const line of lines) {
    const index = fields.findIndex((field) => line.startsWith(field));
    if (index <= previous || line.includes("\r")) return fallback;
    previous = index;
  }
  const start = boundary + separator.length;
  return { name, text: text.slice(start), envelope: text.slice(0, start) };
}

/** Recognize only the Host builder's envelope. Unknown formats remain behind disclosure. */
export function hostMessageSummary(
  text: string,
  historyPrompt?: string,
): string {
  if (!text.startsWith("[ZenX trigger wakeup]\n")) return "";
  const headerEnd = text.indexOf("\n\nInjected prompt:\n");
  if (headerEnd < 0) return "";
  const header = text.slice(0, headerEnd);
  const title = /^Registered trigger: (.+)$/mu.exec(header)?.[1]?.trim();
  const promptStart = headerEnd + "\n\nInjected prompt:\n".length;
  const promptEnd = text
    .slice(promptStart)
    .search(
      /\n\n(?:Current Room message \(|Bounded source context \(|PAW context:|Reply Room ID:|Associated assistant Room IDs:)/u,
    );
  const prompt =
    historyPrompt ??
    text.slice(
      promptStart,
      promptEnd < 0 ? undefined : promptStart + promptEnd,
    );
  const excerpt = prompt.trim().replace(/\s+/gu, " ").slice(0, 180);
  return [title?.slice(0, 120), excerpt].filter(Boolean).join(" · ");
}

/** The same exact client/source match used by the transcript renderer and its Find projection. */
export function findInputWakeup(
  item: Extract<
    ThreadItem,
    { type: "userMessage" | "threadMessage" | "hostMessage" }
  >,
  entries: readonly TriggerHistoryEntry[],
) {
  return entries.find(
    (entry) =>
      entry.clientUserMessageId === item.clientId &&
      (item.type === "userMessage" ||
        (item.type === "hostMessage" &&
          (item.source === "trigger"
            ? entry.triggerId === item.sourceId
            : item.source === "room" && entry.sourceRoomId === item.sourceId))),
  );
}
