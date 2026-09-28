/** Pure native ZAS mobile wire types: safe to import as types in React Native. */
export const REMOTE_HOST_VERSION = 0;
export const REMOTE_METHODS = {
  hello: "zen/remote/hello",
  workspaces: "zen/remote/workspaces",
  threads: "zen/remote/threads",
  create: "zen/remote/create",
  resume: "zen/remote/resume",
  send: "zen/remote/send",
  interrupt: "zen/remote/interrupt",
  event: "zen/remote/thread/event",
} as const;
export interface RemoteWorkspaceView {
  id: string;
  label: string;
}
export interface RemotePairRequest {
  hostId: string;
  deviceId: string;
  code: string;
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
    | { type: "redacted" };
}
export interface RemoteRecoverySnapshot {
  processEpoch: string;
  threadId: string;
  watermark: number;
  thread: RemoteThreadView;
  events: RemoteEventView[];
}
export type RemoteErrorCode =
  | "unauthorized"
  | "revoked"
  | "wrong_host"
  | "wrong_workspace"
  | "thread_not_found"
  | "thread_busy"
  | "stale_turn"
  | "idempotency_conflict"
  | "operation_forbidden"
  | "unsupported_version"
  | "invalid_request";

export interface RemoteRequestParams {
  [REMOTE_METHODS.hello]: { version: number; hostId: string };
  [REMOTE_METHODS.workspaces]: Record<string, never>;
  [REMOTE_METHODS.threads]: { workspaceId: string };
  [REMOTE_METHODS.create]: { workspaceId: string };
  [REMOTE_METHODS.resume]: { workspaceId: string; threadId: string };
  [REMOTE_METHODS.send]: RemoteSend;
  [REMOTE_METHODS.interrupt]: {
    workspaceId: string;
    threadId: string;
    expectedTurnId: string;
  };
}
export interface RemoteResponseResults {
  [REMOTE_METHODS.hello]: {
    version: number;
    hostId: string;
    processEpoch: string;
    capabilities: string[];
  };
  [REMOTE_METHODS.workspaces]: { workspaces: RemoteWorkspaceView[] };
  [REMOTE_METHODS.threads]: { threads: RemoteThreadSummary[] };
  [REMOTE_METHODS.create]: RemoteThreadView;
  [REMOTE_METHODS.resume]: RemoteRecoverySnapshot;
  [REMOTE_METHODS.send]: { turnId: string };
  [REMOTE_METHODS.interrupt]: Record<string, never>;
}
