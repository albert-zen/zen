import type {
  ServerNotificationMethod,
  ServerNotificationParams,
  Thread,
  ThreadItem,
  Turn,
} from "../../protocol-client/index.js";
import type { AppServerEvent } from "../../../../../src/app-server.js";
import type { NativeThreadRecoverySnapshot } from "../../../../../src/protocol/native/recovery.js";
import {
  projectCommandStarted,
  projectCompletedItem,
  projectThread,
} from "../../../../../src/protocol/codex/mapper.js";

export function projectNativeRecovery(
  recovery: NativeThreadRecoverySnapshot,
): Thread {
  let thread = projectThread(recovery.thread, { includeTurns: true });
  const canonicalItemIds = new Set(
    recovery.thread.items.map((item) => item.id),
  );
  const canonicalToolResults = new Set(
    recovery.thread.items.flatMap((item) =>
      item.type === "tool_result" ? [item.callId] : [],
    ),
  );
  for (const projected of recovery.events) {
    if (
      projected.processEpoch === recovery.processEpoch &&
      projected.watermark <= recovery.watermark
    ) {
      if (
        !eventCoveredByCanonical(
          projected.event,
          canonicalItemIds,
          canonicalToolResults,
        )
      )
        thread = applyNativeThreadEvent(thread, projected.event);
    }
  }
  return thread;
}

export function markThreadViewAwaitingRecovery(thread: Thread): Thread {
  return {
    ...thread,
    status: { type: "idle" },
    turns: thread.turns.map((turn) =>
      turn.status === "inProgress"
        ? {
            ...turn,
            status: "interrupted",
            completedAt: null,
            durationMs: null,
            items: turn.items.map((item) =>
              item.type === "reasoning" && item.status === "inProgress"
                ? { ...item, status: "interrupted" as const }
                : item,
            ),
          }
        : turn,
    ),
  };
}

export function applyNativeThreadEvent(
  thread: Thread,
  event: AppServerEvent,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Thread {
  if (event.type === "model_catalog_updated") return thread;
  if (event.type === "thread_started") {
    return event.threadId === thread.id
      ? projectThread(event.thread, { includeTurns: true })
      : thread;
  }
  if (event.type === "thread_name_updated") {
    return event.threadId === thread.id
      ? { ...thread, name: event.name, updatedAt: nowSeconds }
      : thread;
  }
  if (event.type === "thread_archived_updated") return thread;
  if (event.type === "thread_settings_updated") {
    return event.threadId === thread.id
      ? {
          ...thread,
          modelProvider: event.settings.providerProfileId,
          updatedAt: nowSeconds,
        }
      : thread;
  }
  const threadId =
    event.type === "item_completed" ? event.item.threadId : event.threadId;
  if (threadId !== thread.id || event.type === "token_usage") return thread;
  if (event.type === "turn_started") {
    return applyThreadViewNotification(
      thread,
      "turn/started",
      {
        threadId,
        turn: {
          id: event.turnId,
          items: [],
          itemsView: "full",
          status: "inProgress",
          error: null,
          startedAt: nowSeconds,
          completedAt: null,
          durationMs: null,
        },
      },
      nowSeconds,
    );
  }
  if (event.type === "item_started") {
    const existing = itemById(thread, event.itemId);
    if (existing !== undefined) return thread;
    if (event.itemType !== "agent_message" && event.itemType !== "reasoning")
      return thread;
    return applyThreadViewNotification(
      thread,
      "item/started",
      {
        threadId,
        turnId: event.turnId,
        item:
          event.itemType === "agent_message"
            ? {
                type: "agentMessage",
                id: event.itemId,
                text: "",
                phase: "final_answer",
                memoryCitation: null,
              }
            : { type: "reasoning", id: event.itemId, summary: [], content: [] },
        startedAtMs: nowSeconds * 1_000,
      },
      nowSeconds,
    );
  }
  if (event.type === "item_delta") {
    return applyThreadViewNotification(
      thread,
      "item/agentMessage/delta",
      {
        threadId,
        turnId: event.turnId,
        itemId: event.itemId,
        delta: event.delta,
      },
      nowSeconds,
    );
  }
  if (
    event.type === "reasoning_summary_delta" ||
    event.type === "reasoning_content_delta"
  ) {
    return applyThreadViewNotification(
      thread,
      event.type === "reasoning_summary_delta"
        ? "item/reasoning/summaryTextDelta"
        : "item/reasoning/textDelta",
      event.type === "reasoning_summary_delta"
        ? {
            threadId,
            turnId: event.turnId,
            itemId: event.itemId,
            delta: event.delta,
            summaryIndex: 0,
          }
        : {
            threadId,
            turnId: event.turnId,
            itemId: event.itemId,
            delta: event.delta,
            contentIndex: 0,
          },
      nowSeconds,
    );
  }
  if (event.type === "item_completed") {
    if (event.item.type === "tool_result") {
      return updateCommandResult(
        thread,
        event.item.callId,
        event.item.output,
        event.item.exitCode,
        event.item.executionStatus,
      );
    }
    const item =
      event.item.type === "tool_call"
        ? projectCommandStarted(event.item, thread.cwd)
        : projectCompletedItem(event.item);
    if (item === null || itemById(thread, item.id) !== undefined) return thread;
    const turnId = "turnId" in event.item ? event.item.turnId : undefined;
    if (turnId === undefined) return thread;
    return applyThreadViewNotification(
      thread,
      "item/completed",
      {
        threadId,
        turnId,
        item,
        completedAtMs: nowSeconds * 1_000,
      },
      nowSeconds,
    );
  }
  const existing = thread.turns.find((turn) => turn.id === event.turnId);
  return applyThreadViewNotification(
    thread,
    "turn/completed",
    {
      threadId,
      turn: {
        id: event.turnId,
        items: existing?.items ?? [],
        itemsView: "full",
        status: event.status,
        error: existing?.error ?? null,
        startedAt: existing?.startedAt ?? null,
        completedAt: nowSeconds,
        durationMs:
          existing?.startedAt === null || existing?.startedAt === undefined
            ? null
            : Math.max(0, (nowSeconds - existing.startedAt) * 1_000),
      },
    },
    nowSeconds,
  );
}

export function applyThreadViewNotification(
  thread: Thread,
  method: ServerNotificationMethod,
  params: ServerNotificationParams[ServerNotificationMethod],
  nowSeconds = Math.floor(Date.now() / 1_000),
): Thread {
  if (method === "thread/queue/updated") {
    const event = params as ServerNotificationParams["thread/queue/updated"];
    return event.threadId === thread.id
      ? { ...thread, queuedMessages: event.queuedMessages }
      : thread;
  }
  if (method === "thread/name/updated") {
    const event = params as ServerNotificationParams["thread/name/updated"];
    return event.threadId === thread.id
      ? { ...thread, name: event.threadName, updatedAt: nowSeconds }
      : thread;
  }
  if (method === "thread/settings/updated") {
    const event = params as ServerNotificationParams["thread/settings/updated"];
    return event.threadId === thread.id
      ? {
          ...thread,
          modelProvider: event.threadSettings.modelProvider,
          updatedAt: nowSeconds,
        }
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
      upsertItem(
        items,
        event.item.type === "reasoning" && method === "item/started"
          ? { ...event.item, status: "inProgress" }
          : event.item,
      ),
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
  if (method === "item/reasoning/summaryPartAdded") {
    const event =
      params as ServerNotificationParams["item/reasoning/summaryPartAdded"];
    if (event.threadId !== thread.id) return thread;
    return updateTurnItems(thread, event.turnId, (items) =>
      items.map((item) => {
        if (item.id !== event.itemId || item.type !== "reasoning") return item;
        const summary = [...item.summary];
        while (summary.length <= event.summaryIndex) summary.push("");
        return { ...item, summary };
      }),
    );
  }
  if (method === "item/reasoning/summaryTextDelta") {
    const event =
      params as ServerNotificationParams["item/reasoning/summaryTextDelta"];
    if (event.threadId !== thread.id) return thread;
    return updateTurnItems(thread, event.turnId, (items) =>
      items.map((item) => {
        if (item.id !== event.itemId || item.type !== "reasoning") return item;
        const summary = [...item.summary];
        while (summary.length <= event.summaryIndex) summary.push("");
        summary[event.summaryIndex] =
          (summary[event.summaryIndex] ?? "") + event.delta;
        return { ...item, summary };
      }),
    );
  }
  if (method === "item/reasoning/textDelta") {
    const event =
      params as ServerNotificationParams["item/reasoning/textDelta"];
    if (event.threadId !== thread.id) return thread;
    return updateTurnItems(thread, event.turnId, (items) =>
      items.map((item) => {
        if (item.id !== event.itemId || item.type !== "reasoning") return item;
        const content = [...item.content];
        while (content.length <= event.contentIndex) content.push("");
        content[event.contentIndex] =
          (content[event.contentIndex] ?? "") + event.delta;
        return { ...item, content };
      }),
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
      items: (existing?.items ?? event.turn.items).map((item) =>
        item.type === "reasoning" && item.status === "inProgress"
          ? { ...item, status: "interrupted" as const }
          : item,
      ),
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

function itemById(thread: Thread, itemId: string): ThreadItem | undefined {
  for (const turn of thread.turns) {
    const item = turn.items.find((candidate) => candidate.id === itemId);
    if (item !== undefined) return item;
  }
  return undefined;
}

function eventCoveredByCanonical(
  event: AppServerEvent,
  itemIds: ReadonlySet<string>,
  toolResultCallIds: ReadonlySet<string>,
): boolean {
  if (
    event.type === "item_started" ||
    event.type === "item_delta" ||
    event.type === "reasoning_summary_delta" ||
    event.type === "reasoning_content_delta"
  )
    return itemIds.has(event.itemId);
  if (event.type === "item_completed") {
    return event.item.type === "tool_result"
      ? toolResultCallIds.has(event.item.callId)
      : itemIds.has(event.item.id);
  }
  return false;
}

function updateCommandResult(
  thread: Thread,
  callId: string,
  output: string,
  exitCode: number,
  executionStatus: "completed" | "failed" | "declined" | undefined,
): Thread {
  return {
    ...thread,
    turns: thread.turns.map((turn) => ({
      ...turn,
      items: turn.items.map((item) =>
        item.type === "commandExecution" && item.callId === callId
          ? {
              ...item,
              status:
                executionStatus ?? (exitCode === 0 ? "completed" : "failed"),
              aggregatedOutput: output,
              exitCode,
            }
          : item,
      ),
    })),
  };
}
