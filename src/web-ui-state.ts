import type {
  AppServerNotification,
  ApprovalDecision,
  JsonObject,
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
  | ShellTimelineRow
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

export type ShellTimelineRow = {
  readonly type: "shell";
  readonly itemId: string;
  readonly seq: number;
  readonly turnId: string;
  readonly toolCallId?: string;
  readonly command: string;
  readonly status: "running" | "completed" | "failed" | "interrupted";
  readonly exitCode?: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
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

  if (turns.at(-1)?.status === "failed") {
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
  const shellRows = buildShellRows(sortedItems);
  const assistantCompletedTargets = new Set(
    sortedItems
      .filter((item) => item.type === "assistant.message.completed")
      .map((item) => item.targetId)
      .filter((targetId): targetId is string => Boolean(targetId))
  );
  const assistantDeltaTextByTarget = new Map<string, string>();
  const resolvedApprovalIds = new Set(
    sortedItems
      .filter((item) => readApprovalEventType(item) === "approval.resolved")
      .map((item) => readStringPayloadField(readApprovalPayload(item), "approvalId"))
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
    const shellRow = shellRows.get(item.id);

    if (shellRow) {
      return [shellRow];
    }

    if (isShellChildItem(item, shellRows)) {
      return [];
    }

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
      readApprovalEventType(item) === "approval.requested" &&
      resolvedApprovalIds.has(
        readStringPayloadField(readApprovalPayload(item), "approvalId")
      )
    ) {
      return [];
    }

    return [toTimelineRow(item)];
  });
}

function buildShellRows(
  sortedItems: readonly ProtocolItem[]
): ReadonlyMap<string, ShellTimelineRow> {
  const rows = new Map<string, ShellTimelineRow>();

  for (const item of sortedItems) {
    if (item.type !== "tool.call.started" || readStringPayloadField(item.payload, "toolName") !== "shell") {
      continue;
    }

    rows.set(item.id, {
      type: "shell",
      itemId: item.id,
      seq: item.seq,
      turnId: item.turnId,
      toolCallId: readOptionalStringPayloadField(item.payload, "toolCallId"),
      command: readCommand(readPayloadField(item.payload, "input")),
      status: "running",
      stdout: "",
      stderr: ""
    });
  }

  for (const item of sortedItems) {
    const targetId = item.targetId;

    if (!targetId) {
      continue;
    }

    const existing = rows.get(targetId);

    if (!existing) {
      continue;
    }

    if (item.type === "tool.output.delta") {
      const delta = readShellOutputDelta(item.payload);

      if (!delta) {
        continue;
      }

      rows.set(targetId, {
        ...existing,
        stdout: delta.stream === "stdout" ? `${existing.stdout}${delta.chunk}` : existing.stdout,
        stderr: delta.stream === "stderr" ? `${existing.stderr}${delta.chunk}` : existing.stderr
      });
    }

    if (item.type === "tool.result.completed") {
      const result = parseShellResult(readPayloadField(item.payload, "content"));

      rows.set(targetId, {
        ...existing,
        status: result.exitCode !== undefined && result.exitCode !== 0 ? "failed" : "completed",
        exitCode: result.exitCode,
        stdout: result.stdout ?? existing.stdout,
        stderr: result.stderr ?? existing.stderr
      });
    }

    if (item.type === "tool.error") {
      const message = readOptionalStringPayloadField(item.payload, "message") ?? "failed";

      rows.set(targetId, {
        ...existing,
        status: isInterruptedShellMessage(message) ? "interrupted" : "failed",
        error: message
      });
    }
  }

  return rows;
}

function isShellChildItem(
  item: ProtocolItem,
  shellRows: ReadonlyMap<string, ShellTimelineRow>
): boolean {
  if (readApprovalEventType(item)) {
    return false;
  }

  return (
    Boolean(item.targetId && shellRows.has(item.targetId)) &&
    (item.type === "tool.output.delta" ||
      item.type === "tool.result.completed" ||
      item.type === "tool.error")
  );
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

  if (readApprovalEventType(item) === "approval.requested") {
    const approvalPayload = readApprovalPayload(item);

    return {
      type: "approval-pending",
      itemId: item.id,
      seq: item.seq,
      turnId: item.turnId,
      approvalId: readOptionalStringPayloadField(approvalPayload, "approvalId"),
      toolCallId: readOptionalStringPayloadField(approvalPayload, "toolCallId"),
      reason: readOptionalStringPayloadField(approvalPayload, "reason")
    };
  }

  if (readApprovalEventType(item) === "approval.resolved") {
    const approvalPayload = readApprovalPayload(item);

    return {
      type: "approval-resolved",
      itemId: item.id,
      seq: item.seq,
      turnId: item.turnId,
      approvalId: readOptionalStringPayloadField(approvalPayload, "approvalId"),
      decision: readApprovalDecision(approvalPayload)
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

function readCommand(input: unknown): string {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const command = readPayloadField(input as JsonObject, "command");

    if (typeof command === "string") {
      return command;
    }
  }

  return stringify(input);
}

function readShellOutputDelta(
  payload: ProtocolItem["payload"]
): { readonly stream: "stdout" | "stderr"; readonly chunk: string } | undefined {
  const delta = readPayloadField(payload, "delta");

  if (typeof delta !== "object" || delta === null || Array.isArray(delta)) {
    return undefined;
  }

  const stream = readPayloadField(delta as JsonObject, "stream");
  const chunk = readPayloadField(delta as JsonObject, "chunk");

  if ((stream !== "stdout" && stream !== "stderr") || typeof chunk !== "string") {
    return undefined;
  }

  return { stream, chunk };
}

function parseShellResult(content: unknown): {
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
} {
  if (typeof content !== "string") {
    return {};
  }

  const exitCodeText = content.match(/^exitCode:\s*([^\r\n]+)/m)?.[1]?.trim();
  const exitCode =
    exitCodeText === undefined
      ? undefined
      : exitCodeText === "null"
        ? null
        : Number(exitCodeText);

  return {
    exitCode: Number.isNaN(exitCode) ? undefined : exitCode,
    stdout: readShellSection(content, "stdout"),
    stderr: readShellSection(content, "stderr")
  };
}

function readShellSection(content: string, section: "stdout" | "stderr"): string | undefined {
  const nextSection = section === "stdout" ? "stderr" : undefined;
  const pattern =
    nextSection === undefined
      ? new RegExp(`^${section}:\\n([\\s\\S]*)`, "m")
      : new RegExp(`^${section}:\\n([\\s\\S]*?)(?=^${nextSection}:\\n)`, "m");
  const value = content.match(pattern)?.[1];

  return value === undefined ? undefined : value.trimEnd();
}

function isInterruptedShellMessage(message: string): boolean {
  return /\b(abort|aborted|cancel|canceled|cancelled|interrupt|interrupted)\b/i.test(
    message
  );
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

function readApprovalEventType(
  item: ProtocolItem
): "approval.requested" | "approval.resolved" | undefined {
  if (item.type === "approval.requested" || item.type === "approval.resolved") {
    return item.type;
  }

  const delta = readPayloadField(item.payload, "delta");

  if (typeof delta !== "object" || delta === null || Array.isArray(delta)) {
    return undefined;
  }

  const type = readPayloadField(delta as JsonObject, "type");

  return type === "approval.requested" || type === "approval.resolved"
    ? type
    : undefined;
}

function readApprovalPayload(item: ProtocolItem): ProtocolItem["payload"] {
  const delta = readPayloadField(item.payload, "delta");

  if (typeof delta === "object" && delta !== null && !Array.isArray(delta)) {
    const type = readPayloadField(delta as JsonObject, "type");

    if (type === "approval.requested" || type === "approval.resolved") {
      return delta as JsonObject;
    }
  }

  return item.payload;
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "";
  }

  return JSON.stringify(value);
}
