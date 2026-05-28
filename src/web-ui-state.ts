import type {
  AppServerNotification,
  ApprovalDecision,
  ProtocolItem,
  ThreadSnapshot
} from "./app-server-protocol.js";

export type WebUiState = {
  readonly currentThread?: {
    readonly id: string;
    readonly status: ThreadSnapshot["status"];
    readonly turns: ThreadSnapshot["turns"];
  };
  readonly items: readonly ProtocolItem[];
  readonly timelineRows: readonly TimelineRow[];
};

export type TimelineRow =
  | UserTimelineRow
  | AssistantTimelineRow
  | AssistantProgressTimelineRow
  | ToolCallTimelineRow
  | ToolResultTimelineRow
  | ToolErrorTimelineRow
  | ApprovalPendingTimelineRow
  | ApprovalResolvedTimelineRow
  | TraceTimelineRow;

export type UserTimelineRow = {
  readonly type: "user";
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly content?: unknown;
};

export type AssistantTimelineRow = {
  readonly type: "assistant";
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly content?: unknown;
};

export type AssistantProgressTimelineRow = {
  readonly type: "assistant-progress";
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly content: string;
};

export type TraceTimelineRow = {
  readonly type: "trace";
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly event: string;
};

export type ToolCallTimelineRow = {
  readonly type: "tool-call";
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly input?: unknown;
};

export type ToolResultTimelineRow = {
  readonly type: "tool-result";
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly content?: unknown;
};

export type ToolErrorTimelineRow = {
  readonly type: "tool-error";
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly message?: string;
};

export type ApprovalPendingTimelineRow = {
  readonly type: "approval-pending";
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly approvalId?: string;
  readonly toolCallId?: string;
  readonly reason?: string;
};

export type ApprovalResolvedTimelineRow = {
  readonly type: "approval-resolved";
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly approvalId?: string;
  readonly decision?: ApprovalDecision;
};

export function createWebUiState(snapshot?: ThreadSnapshot): WebUiState {
  if (!snapshot) {
    return {
      items: [],
      timelineRows: []
    };
  }

  return {
    currentThread: {
      id: snapshot.id,
      status: snapshot.status,
      turns: snapshot.turns.map((turn) => ({
        ...turn,
        itemIds: [...turn.itemIds]
      }))
    },
    items: [...snapshot.items].sort(compareItems),
    timelineRows: buildTimelineRows(snapshot.items)
  };
}

export function applyAppServerNotification(
  state: WebUiState,
  notification: AppServerNotification
): WebUiState {
  if (notification.type === "thread/started") {
    return createWebUiState(notification.thread);
  }

  if (notification.type === "item/appended") {
    if (!isForCurrentThread(state, notification.threadId)) {
      return state;
    }

    return rebuildFromItems(state, appendOrReplaceItem(state.items, notification.item));
  }

  if (notification.type === "approval/requested") {
    if (!isForCurrentThread(state, notification.threadId)) {
      return state;
    }

    return rebuildFromItems(state, appendOrReplaceItem(state.items, notification.item));
  }

  if (notification.type === "approval/resolved" && notification.item) {
    if (!isForCurrentThread(state, notification.threadId)) {
      return state;
    }

    return rebuildFromItems(state, appendOrReplaceItem(state.items, notification.item));
  }

  if (
    notification.type === "turn/started" ||
    notification.type === "turn/completed" ||
    notification.type === "turn/failed"
  ) {
    if (!isForCurrentThread(state, notification.threadId)) {
      return state;
    }

    return updateCurrentThreadTurn(state, notification.threadId, notification.turn);
  }

  return state;
}

function isForCurrentThread(state: WebUiState, threadId: string): boolean {
  return !state.currentThread || state.currentThread.id === threadId;
}

function updateCurrentThreadTurn(
  state: WebUiState,
  threadId: string,
  turn: ThreadSnapshot["turns"][number]
): WebUiState {
  const currentThread = state.currentThread ?? {
    id: threadId,
    status: "idle" as const,
    turns: []
  };
  const turns = [
    ...currentThread.turns.filter((existingTurn) => existingTurn.id !== turn.id),
    cloneTurn(turn)
  ];

  return {
    ...state,
    currentThread: {
      id: currentThread.id,
      status: deriveThreadStatus(turns),
      turns
    }
  };
}

function cloneTurn(
  turn: ThreadSnapshot["turns"][number]
): ThreadSnapshot["turns"][number] {
  return {
    ...turn,
    itemIds: [...turn.itemIds]
  };
}

function deriveThreadStatus(
  turns: readonly ThreadSnapshot["turns"][number][]
): ThreadSnapshot["status"] {
  if (
    turns.some(
      (turn) => turn.status === "queued" || turn.status === "inProgress"
    )
  ) {
    return "running";
  }

  if (turns.some((turn) => turn.status === "failed")) {
    return "failed";
  }

  return "idle";
}

function rebuildFromItems(
  state: WebUiState,
  items: readonly ProtocolItem[]
): WebUiState {
  const sortedItems = [...items].sort(compareItems);

  return {
    ...state,
    items: sortedItems,
    timelineRows: buildTimelineRows(sortedItems)
  };
}

function appendOrReplaceItem(
  items: readonly ProtocolItem[],
  nextItem: ProtocolItem
): readonly ProtocolItem[] {
  const withoutExisting = items.filter((item) => item.id !== nextItem.id);

  return [...withoutExisting, nextItem];
}

function compareItems(left: ProtocolItem, right: ProtocolItem): number {
  return left.seq - right.seq || left.createdAtMs - right.createdAtMs;
}

function buildTimelineRows(items: readonly ProtocolItem[]): readonly TimelineRow[] {
  const sortedItems = [...items].sort(compareItems);
  const assistantCompletedTargets = new Set(
    sortedItems
      .filter((item) => item.type === "assistant.message.completed")
      .map((item) => item.targetId)
      .filter((targetId): targetId is string => Boolean(targetId))
  );
  const assistantDeltaTextByTarget = new Map<string, string>();
  const resolvedApprovalIds = new Set(
    sortedItems
      .filter((item) => item.type === "approval.resolved")
      .map((item) => readStringPayloadField(item.payload, "approvalId"))
      .filter((approvalId) => approvalId.length > 0)
  );

  for (const item of sortedItems) {
    if (item.type !== "assistant.message.delta" || !item.targetId) {
      continue;
    }

    assistantDeltaTextByTarget.set(
      item.targetId,
      `${assistantDeltaTextByTarget.get(item.targetId) ?? ""}${readStringPayloadField(
        item.payload,
        "delta"
      )}`
    );
  }

  return sortedItems.flatMap((item): TimelineRow[] => {
    if (
      item.type === "assistant.message.started" &&
      !assistantCompletedTargets.has(item.id)
    ) {
      const progress = assistantDeltaTextByTarget.get(item.id);

      if (progress) {
        return [
          {
            type: "assistant-progress",
            itemId: item.id,
            seq: item.seq,
            turnId: item.turnId,
            content: progress
          }
        ];
      }
    }

    if (item.type === "assistant.message.delta") {
      return [];
    }

    if (
      item.type === "approval.requested" &&
      resolvedApprovalIds.has(readStringPayloadField(item.payload, "approvalId"))
    ) {
      return [];
    }

    return [toTimelineRow(item)];
  });
}

function toTimelineRow(item: ProtocolItem): TimelineRow {
  if (item.type === "user.message.completed") {
    return {
      type: "user",
      itemId: item.id,
      seq: item.seq,
      turnId: item.turnId,
      content: readPayloadField(item.payload, "content")
    };
  }

  if (item.type === "assistant.message.completed") {
    return {
      type: "assistant",
      itemId: item.id,
      seq: item.seq,
      turnId: item.turnId,
      content: readPayloadField(item.payload, "content")
    };
  }

  if (item.type === "tool.call.started") {
    return {
      type: "tool-call",
      itemId: item.id,
      seq: item.seq,
      turnId: item.turnId,
      toolCallId: readOptionalStringPayloadField(item.payload, "toolCallId"),
      toolName: readOptionalStringPayloadField(item.payload, "toolName"),
      input: readPayloadField(item.payload, "input")
    };
  }

  if (item.type === "tool.result.completed") {
    return {
      type: "tool-result",
      itemId: item.id,
      seq: item.seq,
      turnId: item.turnId,
      toolCallId: readOptionalStringPayloadField(item.payload, "toolCallId"),
      toolName: readOptionalStringPayloadField(item.payload, "toolName"),
      content: readPayloadField(item.payload, "content")
    };
  }

  if (item.type === "tool.error") {
    return {
      type: "tool-error",
      itemId: item.id,
      seq: item.seq,
      turnId: item.turnId,
      toolCallId: readOptionalStringPayloadField(item.payload, "toolCallId"),
      toolName: readOptionalStringPayloadField(item.payload, "toolName"),
      message: readOptionalStringPayloadField(item.payload, "message")
    };
  }

  if (item.type === "approval.requested") {
    return {
      type: "approval-pending",
      itemId: item.id,
      seq: item.seq,
      turnId: item.turnId,
      approvalId: readOptionalStringPayloadField(item.payload, "approvalId"),
      toolCallId: readOptionalStringPayloadField(item.payload, "toolCallId"),
      reason: readOptionalStringPayloadField(item.payload, "reason")
    };
  }

  if (item.type === "approval.resolved") {
    return {
      type: "approval-resolved",
      itemId: item.id,
      seq: item.seq,
      turnId: item.turnId,
      approvalId: readOptionalStringPayloadField(item.payload, "approvalId"),
      decision: readApprovalDecision(item.payload)
    };
  }

  return {
    type: "trace",
    itemId: item.id,
    seq: item.seq,
    turnId: item.turnId,
    event: item.type
  };
}

function readPayloadField(payload: ProtocolItem["payload"], key: string): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }

  return payload[key];
}

function readStringPayloadField(
  payload: ProtocolItem["payload"],
  key: string
): string {
  const value = readPayloadField(payload, key);

  return typeof value === "string" ? value : "";
}

function readOptionalStringPayloadField(
  payload: ProtocolItem["payload"],
  key: string
): string | undefined {
  const value = readStringPayloadField(payload, key);

  return value.length > 0 ? value : undefined;
}

function readApprovalDecision(
  payload: ProtocolItem["payload"]
): ApprovalDecision | undefined {
  const value = readStringPayloadField(payload, "decision");

  if (
    value === "approve" ||
    value === "approveForSession" ||
    value === "decline" ||
    value === "cancel"
  ) {
    return value;
  }

  return undefined;
}
