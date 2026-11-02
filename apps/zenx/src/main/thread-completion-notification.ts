import type {
  ServerNotificationMethod,
  ServerNotificationParams,
} from "../protocol-client/index.js";

/** Keep Host cleanup on the selected native subscription, not a suppressed CAS event. */
export function completedThreadTurn(
  method: ServerNotificationMethod,
  params: ServerNotificationParams[ServerNotificationMethod],
): { threadId: string; failed: boolean } | undefined {
  if (method === "zen/thread/event") {
    const { event } = params as ServerNotificationParams["zen/thread/event"];
    if (event.type === "turn_completed")
      return { threadId: event.threadId, failed: event.status !== "completed" };
  } else if (method === "turn/completed") {
    const event = params as ServerNotificationParams["turn/completed"];
    return {
      threadId: event.threadId,
      failed: event.turn.status !== "completed",
    };
  }
  return undefined;
}
