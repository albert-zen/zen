import type { ToolInvocation } from "../../../../src/tool.js";
import type { ThreadSnapshot } from "../../../../src/app-server.js";
import type { ZenXRoom } from "./trigger-types.js";

/** Names come only from existing local Room membership, never tool arguments. */
export function foregroundAgentName(
  threadId: string | undefined,
  rooms: readonly ZenXRoom[],
): string {
  if (!threadId) return "ZenX Agent";
  const names = new Set(
    rooms
      .flatMap((room) =>
        room.members
          .filter((member) => member.threadId === threadId)
          .map((member) => member.name.trim()),
      )
      .filter(Boolean),
  );
  return names.size === 1 ? [...names][0]! : "ZenX Agent";
}

interface ForegroundOwnerPort {
  request(
    method: "zen/thread/read",
    params: { threadId: string },
  ): Promise<{ thread: ThreadSnapshot }>;
  request(
    method: "turn/interrupt",
    params: { threadId: string; turnId: string },
  ): Promise<unknown>;
}

export async function stopForegroundOwner(
  port: ForegroundOwnerPort,
  invocation: Pick<ToolInvocation, "threadId" | "canonicalToolCallId">,
): Promise<void> {
  const { threadId, canonicalToolCallId } = invocation;
  if (!threadId || !canonicalToolCallId) return;
  const { thread } = await port.request("zen/thread/read", { threadId });
  const call = thread.items.find(
    (item) => item.type === "tool_call" && item.id === canonicalToolCallId,
  );
  if (
    thread.id !== threadId ||
    !call?.turnId ||
    !thread.turns.some(
      (turn) => turn.id === call.turnId && turn.status === "inProgress",
    )
  )
    return;
  try {
    await port.request("turn/interrupt", { threadId, turnId: call.turnId });
  } catch (error) {
    // A naturally completed old Turn is never replaced by a newer target.
    const code =
      error &&
      typeof error === "object" &&
      "data" in error &&
      error.data &&
      typeof error.data === "object" &&
      "zenCode" in error.data
        ? error.data.zenCode
        : undefined;
    if (code !== "turn_not_running") throw error;
  }
}
