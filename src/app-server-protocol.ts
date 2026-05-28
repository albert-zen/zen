import type { Item } from "./item-list.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type ThreadStatus = "idle" | "running" | "failed";
export type TurnStatus = "queued" | "inProgress" | "completed" | "failed" | "canceled";
export type ApprovalDecision = "approve" | "approveForSession" | "decline" | "cancel";

export type ProtocolItem = {
  readonly id: string;
  readonly type: string;
  readonly createdAtMs: number;
  readonly seq: number;
  readonly runId: string;
  readonly turnId: string;
  readonly parentId?: string;
  readonly causeId?: string;
  readonly targetId?: string;
  readonly visibility?: Item["visibility"];
  readonly payload: JsonValue;
  readonly meta?: JsonObject;
};

export type TurnSnapshot = {
  readonly id: string;
  readonly runId: string;
  readonly status: TurnStatus;
  readonly itemIds: readonly string[];
  readonly error?: JsonValue;
};

export type ThreadSnapshot = {
  readonly id: string;
  readonly status: ThreadStatus;
  readonly turns: readonly TurnSnapshot[];
  readonly items: readonly ProtocolItem[];
};

export type ThreadStartRequest = {
  readonly method: "thread/start";
  readonly params?: {
    readonly metadata?: JsonObject;
  };
};

export type ThreadReadRequest = {
  readonly method: "thread/read";
  readonly params: {
    readonly threadId: string;
    readonly includeInternal?: boolean;
  };
};

export type TurnStartRequest = {
  readonly method: "turn/start";
  readonly params: {
    readonly threadId: string;
    readonly input: JsonValue;
    readonly modelOptions?: JsonObject;
  };
};

export type ApprovalResolveRequest = {
  readonly method: "approval/resolve";
  readonly params: {
    readonly threadId: string;
    readonly turnId: string;
    readonly approvalId: string;
    readonly decision: ApprovalDecision;
  };
};

export type AppServerRequest =
  | ThreadStartRequest
  | ThreadReadRequest
  | TurnStartRequest
  | ApprovalResolveRequest;

export type AppServerError = {
  readonly code: string;
  readonly message: string;
  readonly details?: JsonValue;
};

export type AppServerResponse =
  | {
      readonly method: "thread/start";
      readonly ok: true;
      readonly result: { readonly thread: ThreadSnapshot };
    }
  | {
      readonly method: "thread/read";
      readonly ok: true;
      readonly result: { readonly thread: ThreadSnapshot };
    }
  | {
      readonly method: "turn/start";
      readonly ok: true;
      readonly result: { readonly turn: TurnSnapshot };
    }
  | {
      readonly method: "approval/resolve";
      readonly ok: true;
      readonly result: { readonly approvalId: string; readonly decision: ApprovalDecision };
    }
  | {
      readonly method: string;
      readonly ok: false;
      readonly error: AppServerError;
    };

export type AppServerNotification =
  | {
      readonly type: "thread/started";
      readonly thread: ThreadSnapshot;
    }
  | {
      readonly type: "turn/started";
      readonly threadId: string;
      readonly turn: TurnSnapshot;
    }
  | {
      readonly type: "item/appended";
      readonly threadId: string;
      readonly turnId: string;
      readonly item: ProtocolItem;
    }
  | {
      readonly type: "turn/completed";
      readonly threadId: string;
      readonly turn: TurnSnapshot;
    }
  | {
      readonly type: "turn/failed";
      readonly threadId: string;
      readonly turn: TurnSnapshot;
      readonly error: AppServerError;
    }
  | {
      readonly type: "approval/requested";
      readonly threadId: string;
      readonly turnId: string;
      readonly approvalId: string;
      readonly item: ProtocolItem;
    }
  | {
      readonly type: "approval/resolved";
      readonly threadId: string;
      readonly turnId: string;
      readonly approvalId: string;
      readonly decision: ApprovalDecision;
      readonly item?: ProtocolItem;
    };

export type ProtocolItemOptions = {
  readonly includeInternal?: boolean;
};

export type ThreadSnapshotInput = {
  readonly threadId: string;
  readonly status: ThreadStatus;
  readonly turns: readonly TurnSnapshot[];
  readonly items: readonly Item[];
};

export function toProtocolItem(item: Item): ProtocolItem {
  const projected: ProtocolItem = {
    id: item.id,
    type: item.type,
    createdAtMs: item.createdAtMs,
    seq: item.seq,
    runId: item.runId,
    turnId: item.turnId,
    parentId: item.parentId,
    causeId: item.causeId,
    targetId: item.targetId,
    visibility: item.visibility,
    payload: toJsonValue(item.payload),
    meta: item.meta ? toJsonObject(item.meta) : undefined
  };

  return omitUndefined(projected) as ProtocolItem;
}

export function filterProtocolItems(
  items: readonly Item[],
  options: ProtocolItemOptions = {}
): readonly ProtocolItem[] {
  return items
    .filter((item) => options.includeInternal || item.visibility !== "internal")
    .map(toProtocolItem);
}

export function toThreadSnapshot(
  input: ThreadSnapshotInput,
  options: ProtocolItemOptions = {}
): ThreadSnapshot {
  return {
    id: input.threadId,
    status: input.status,
    turns: input.turns.map(cloneTurnSnapshot),
    items: filterProtocolItems(input.items, options)
  };
}

function cloneTurnSnapshot(turn: TurnSnapshot): TurnSnapshot {
  return {
    id: turn.id,
    runId: turn.runId,
    status: turn.status,
    itemIds: [...turn.itemIds],
    error: turn.error === undefined ? undefined : toJsonValue(turn.error)
  };
}

function toJsonObject(value: Readonly<Record<string, unknown>>): JsonObject {
  return omitUndefined(
    Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => !isUnsupportedObjectEntry(entryValue))
        .map(([key, entryValue]) => [key, toJsonValue(entryValue)])
    )
  ) as JsonObject;
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message
    };
  }

  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }

  if (typeof value === "object") {
    return toJsonObject(value as Readonly<Record<string, unknown>>);
  }

  return null;
}

function isUnsupportedObjectEntry(value: unknown): boolean {
  return (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  );
}

function omitUndefined<T extends Readonly<Record<string, unknown>>>(
  value: T
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  );
}
