import type {
  ServerNotificationMethod,
  ServerNotificationParams,
  Thread,
  ThreadItem,
  Turn,
} from "../../protocol-client/index.js";

export function applyThreadViewNotification(
  thread: Thread,
  method: ServerNotificationMethod,
  params: ServerNotificationParams[ServerNotificationMethod],
  nowSeconds = Math.floor(Date.now() / 1_000),
): Thread {
  if (method === "thread/name/updated") {
    const event = params as ServerNotificationParams["thread/name/updated"];
    return event.threadId === thread.id
      ? { ...thread, name: event.threadName, updatedAt: nowSeconds }
      : thread;
  }
  if (method === "turn/started") {
    const event = params as ServerNotificationParams["turn/started"];
    return event.threadId === thread.id
      ? {
          ...thread,
          status: { type: "active", activeFlags: [] },
          turns: upsertTurn(thread.turns, event.turn),
          updatedAt: nowSeconds,
        }
      : thread;
  }
  if (method === "item/started" || method === "item/completed") {
    const event = params as
      | ServerNotificationParams["item/started"]
      | ServerNotificationParams["item/completed"];
    if (event.threadId !== thread.id) return thread;
    return updateTurnItems(thread, event.turnId, (items) =>
      upsertItem(items, event.item),
    );
  }
  if (method === "item/agentMessage/delta") {
    const event = params as ServerNotificationParams["item/agentMessage/delta"];
    if (event.threadId !== thread.id) return thread;
    return updateTurnItems(thread, event.turnId, (items) =>
      items.map((item) =>
        item.id === event.itemId && item.type === "agentMessage"
          ? { ...item, text: item.text + event.delta }
          : item,
      ),
    );
  }
  if (method === "item/commandExecution/outputDelta") {
    const event =
      params as ServerNotificationParams["item/commandExecution/outputDelta"];
    if (event.threadId !== thread.id) return thread;
    return updateTurnItems(thread, event.turnId, (items) =>
      items.map((item) =>
        item.id === event.itemId && item.type === "commandExecution"
          ? {
              ...item,
              aggregatedOutput: (item.aggregatedOutput ?? "") + event.delta,
            }
          : item,
      ),
    );
  }
  if (method === "turn/completed") {
    const event = params as ServerNotificationParams["turn/completed"];
    if (event.threadId !== thread.id) return thread;
    const existing = thread.turns.find((turn) => turn.id === event.turn.id);
    const completed = {
      ...event.turn,
      items: existing?.items ?? event.turn.items,
    };
    return {
      ...thread,
      status: { type: "idle" },
      turns: upsertTurn(thread.turns, completed),
      updatedAt: nowSeconds,
    };
  }
  return thread;
}

export function activeTurn(thread: Thread): Turn | null {
  return (
    [...thread.turns].reverse().find((turn) => turn.status === "inProgress") ??
    null
  );
}

function upsertTurn(turns: readonly Turn[], next: Turn): Turn[] {
  const index = turns.findIndex((turn) => turn.id === next.id);
  if (index < 0) return [...turns, next];
  return turns.map((turn, turnIndex) => (turnIndex === index ? next : turn));
}

function upsertItem(
  items: readonly ThreadItem[],
  next: ThreadItem,
): ThreadItem[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next];
  return items.map((item, itemIndex) => (itemIndex === index ? next : item));
}

function updateTurnItems(
  thread: Thread,
  turnId: string,
  update: (items: ThreadItem[]) => ThreadItem[],
): Thread {
  return {
    ...thread,
    turns: thread.turns.map((turn) =>
      turn.id === turnId ? { ...turn, items: update(turn.items) } : turn,
    ),
  };
}
