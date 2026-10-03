/** Pure native ZAS mobile wire types: safe to import as types in React Native. */
export const REMOTE_HOST_VERSION = 1;
export const REMOTE_METHODS = {
  hello: "zen/remote/hello",
  models: "zen/remote/models",
  rooms: "zen/remote/rooms",
  roomsRead: "zen/remote/rooms/read",
  roomsPost: "zen/remote/rooms/post",
  roomEvent: "zen/remote/room/event",
  workspaces: "zen/remote/workspaces",
  threads: "zen/remote/threads",
  create: "zen/remote/create",
  resume: "zen/remote/resume",
  resumePage: "zen/remote/resume/page",
  send: "zen/remote/send",
  interrupt: "zen/remote/interrupt",
  event: "zen/remote/thread/event",
  reset: "zen/remote/thread/reset",
} as const;
export interface RemoteWorkspaceView {
  id: string;
  label: string;
}
export interface RemotePairRequest {
  hostId: string;
  deviceId: string;
  code: string;
  /** May only narrow the Host-granted access; omission preserves Host policy. */
  access?: "read" | "control";
}
export interface RemotePairResult {
  hostId: string;
  deviceId: string;
  token: string;
}
export type RemoteTurnStatus =
  "inProgress" | "completed" | "failed" | "interrupted";
export interface RemoteSend {
  workspaceId: string;
  threadId: string;
  clientId: string;
  text: string;
  messageType?: "guidance" | "follow_up" | "replacement";
}
export interface RemoteItemView {
  id: string;
  threadId: string;
  turnId?: string;
  createdAt: string;
  type:
    | "user_message"
    | "agent_message"
    | "turn_started"
    | "turn_completed"
    | "turn_aborted";
  text?: string;
}
export interface RemoteThreadView {
  id: string;
  name?: string;
  archived: boolean;
  items: RemoteItemView[];
  turns: { id: string; status: RemoteTurnStatus }[];
}
export interface RemoteThreadSummary {
  threadId: string;
  name?: string;
  status: "idle" | "active";
}
export interface RemoteEventView {
  processEpoch: string;
  threadId: string;
  watermark: number;
  event:
    | { type: "item_completed"; item: RemoteItemView }
    | { type: "turn_started"; turnId: string }
    | { type: "turn_completed"; turnId: string; status: RemoteTurnStatus }
    | { type: "redacted" };
}
export type RemoteRecoveryEntry =
  | {
      kind: "item";
      item: RemoteItemView;
      turn?: { id: string; status: RemoteTurnStatus };
    }
  | {
      kind: "text_fragment";
      item: Omit<RemoteItemView, "text">;
      offset: number;
      text: string;
      complete: boolean;
    };
/** A page is incomplete until nextCursor is null; fragments are not Items. */
export interface RemoteRecoveryPage {
  processEpoch: string;
  threadId: string;
  watermark: number;
  thread: Pick<RemoteThreadView, "id" | "name" | "archived">;
  entries: RemoteRecoveryEntry[];
  nextCursor: string | null;
}
export interface RemoteResetParams {
  threadId: string;
  reason: "resync_required";
}
export type RemoteErrorCode =
  | "unauthorized"
  | "revoked"
  | "wrong_host"
  | "wrong_workspace"
  | "scope_refreshing"
  | "thread_not_found"
  | "thread_busy"
  | "stale_turn"
  | "idempotency_conflict"
  | "operation_forbidden"
  | "unsupported_version"
  | "invalid_request"
  | "stale_cursor"
  | "resync_required"
  | "entry_too_large"
  | "operation_unknown";

/** Only known pre-admission rejections permit clearing an uncertain-send fence. */
export function isConfirmedRemoteRejection(code: unknown): boolean {
  return (
    typeof code === "string" &&
    [
      "unauthorized",
      "revoked",
      "wrong_host",
      "wrong_workspace",
      "scope_refreshing",
      "thread_not_found",
      "thread_busy",
      "stale_turn",
      "idempotency_conflict",
      "operation_forbidden",
      "unsupported_version",
      "invalid_request",
      "stale_cursor",
      "resync_required",
      "entry_too_large",
    ].includes(code)
  );
}

export interface RemoteModelView {
  id: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  supportedReasoningEfforts: readonly {
    reasoningEffort: string;
    description: string;
  }[];
  defaultReasoningEffort: string | null;
}
export interface RemoteRoomSummary {
  id: string;
  name: string;
  threadId: string;
}
export interface RemoteRoomView {
  room: RemoteRoomSummary & { operationEpoch: string };
  messages: Array<{
    id: string;
    kind: "human" | "agent" | "system";
    author: string;
    text: string;
    createdAt: number;
    originThreadId?: string | null;
    originTurnId?: string | null;
  }>;
}
export interface RemoteRoomPostResult {
  messageId: string;
  threadId: string;
  turnId?: string;
}
export interface RemoteRequestParams {
  [REMOTE_METHODS.models]: Record<string, never>;
  [REMOTE_METHODS.rooms]: { workspaceId: string };
  [REMOTE_METHODS.roomsRead]: { workspaceId: string; roomId: string };
  [REMOTE_METHODS.roomsPost]: {
    workspaceId: string;
    roomId: string;
    text: string;
    clientId: string;
  };
  [REMOTE_METHODS.hello]: { version: number; hostId: string };
  [REMOTE_METHODS.workspaces]: Record<string, never>;
  [REMOTE_METHODS.threads]: { workspaceId: string };
  [REMOTE_METHODS.create]: {
    workspaceId: string;
    model?: string;
    effort?: string;
  };
  [REMOTE_METHODS.resume]: { workspaceId: string; threadId: string };
  [REMOTE_METHODS.resumePage]: { cursor: string };
  [REMOTE_METHODS.send]: RemoteSend;
  [REMOTE_METHODS.interrupt]: {
    workspaceId: string;
    threadId: string;
    expectedTurnId: string;
  };
}
export interface RemoteResponseResults {
  [REMOTE_METHODS.models]: { models: readonly RemoteModelView[] };
  [REMOTE_METHODS.rooms]: { rooms: RemoteRoomSummary[] };
  [REMOTE_METHODS.roomsRead]: RemoteRoomView;
  [REMOTE_METHODS.roomsPost]: RemoteRoomPostResult;
  [REMOTE_METHODS.hello]: {
    version: number;
    hostId: string;
    processEpoch: string;
    capabilities: string[];
  };
  [REMOTE_METHODS.workspaces]: { workspaces: RemoteWorkspaceView[] };
  [REMOTE_METHODS.threads]: { threads: RemoteThreadSummary[] };
  [REMOTE_METHODS.create]: RemoteThreadView;
  [REMOTE_METHODS.resume]: RemoteRecoveryPage;
  [REMOTE_METHODS.resumePage]: RemoteRecoveryPage;
  [REMOTE_METHODS.send]: { turnId?: string; queued?: boolean };
  [REMOTE_METHODS.interrupt]: Record<string, never>;
}
