import type { ThreadSnapshot } from "../../../../../src/app-server.js";
import type { CanonicalItem, ToolResultItem } from "../../../../../src/item.js";
import type { ClientRequestParams } from "../../protocol-client/types.js";

export const COCKPIT_CONTENT_TYPE = "cockpit-component/card";
export const COCKPIT_STALE_MS = 30_000;
export function cockpitGroup(
  summary: { threadId: string; status: string },
  approvals: ReadonlySet<string>,
) {
  if (summary.status === "systemError") return "Unknown";
  if (approvals.has(summary.threadId)) return "Needs attention";
  return summary.status === "active" ? "Running" : "Idle";
}

type ActionMethod = "turn/start" | "turn/steer" | "turn/interrupt";
export type CockpitRequest = <M extends ActionMethod>(
  method: M,
  params: ClientRequestParams[M],
) => Promise<unknown>;
export async function cockpitSend(
  request: CockpitRequest,
  snapshot: ThreadSnapshot,
  text: string,
  clientUserMessageId: string,
) {
  if (!text.trim())
    throw new Error("Enter a message before running the Agent.");
  if (snapshot.archived)
    throw new Error("Open the conversation to unarchive this task first.");
  const active = snapshot.turns.find((turn) => turn.status === "inProgress");
  const input = [{ type: "text" as const, text }];
  if (active)
    return request("turn/steer", {
      threadId: snapshot.id,
      expectedTurnId: active.id,
      input,
      clientUserMessageId,
    });
  return request("turn/start", {
    threadId: snapshot.id,
    input,
    clientUserMessageId,
  });
}
export async function cockpitInterrupt(
  request: CockpitRequest,
  snapshot: ThreadSnapshot,
) {
  const active = snapshot.turns.find((turn) => turn.status === "inProgress");
  if (!active)
    throw new Error("No active Turn in this snapshot. Refresh the task.");
  return request("turn/interrupt", {
    threadId: snapshot.id,
    turnId: active.id,
  });
}

export interface CockpitComponent {
  title: string;
  html: string;
  sources: readonly CanonicalItem[];
}
export function readCockpitComponent(
  snapshot: ThreadSnapshot,
  result: ToolResultItem,
): CockpitComponent {
  if (
    result.contentType !== COCKPIT_CONTENT_TYPE ||
    result.exitCode !== 0 ||
    (result.executionStatus !== undefined &&
      result.executionStatus !== "completed")
  )
    throw new Error("Component requires a successful structured tool result.");
  const position = snapshot.items.findIndex((item) => item.id === result.id);
  if (position < 0 || result.threadId !== snapshot.id)
    throw new Error("Component is not part of this Thread.");
  const preceding = snapshot.items.slice(0, position);
  const call = preceding.find(
    (item) =>
      item.type === "tool_call" &&
      item.callId === result.callId &&
      item.turnId === result.turnId &&
      item.threadId === snapshot.id,
  );
  if (
    !call ||
    call.type !== "tool_call" ||
    call.name !== "cockpit_component_publish"
  )
    throw new Error("Component producing call is unavailable.");
  const data = result.structuredContent;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Invalid component data.");
  const value = data as Record<string, unknown>;
  if (
    value.version !== 1 ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title.length > 120 ||
    typeof value.html !== "string" ||
    new TextEncoder().encode(value.html).length > 24_576 ||
    !Array.isArray(value.sourceItemIds) ||
    value.sourceItemIds.length < 1 ||
    value.sourceItemIds.length > 12
  )
    throw new Error(
      "Invalid or oversized component. Inspect the source result.",
    );
  const sources = value.sourceItemIds.map((id) => {
    const item = preceding.find(
      (candidate) => candidate.id === id && candidate.threadId === snapshot.id,
    );
    if (!item)
      throw new Error(
        "Component source is missing or does not precede the result.",
      );
    return item;
  });
  return { title: value.title, html: value.html, sources };
}

export function cockpitEventText(item: CanonicalItem): string {
  if (item.type === "user_message" && item.content)
    return item.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  if (item.type === "turn_completed") return `Turn ${item.status}`;
  if ("text" in item && typeof item.text === "string") return item.text;
  if (item.type === "tool_call") return item.name;
  if (item.type === "tool_result") return item.output;
  if (item.type === "failure") return item.message;
  return item.type.replaceAll("_", " ");
}
