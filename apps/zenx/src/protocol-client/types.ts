import type {
  CodexCommandItem,
  CodexThread,
  CodexThreadItem,
  CodexTurn,
} from "../../../../src/protocol/codex/mapper.js";

export type Thread = CodexThread;
export type Turn = CodexTurn;
export type ThreadItem = CodexThreadItem;
export type CommandItem = CodexCommandItem;

export interface ClientInfo {
  name: string;
  title: string;
  version: string;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: null;
}

export interface InitializeResult {
  userAgent: string;
  codexHome: string;
  platformFamily: "unix" | "windows";
  platformOs: string;
}

export interface ThreadConfigurationParams {
  cwd?: string;
  model?: string;
  approvalPolicy?: "on-request" | "never";
  approvalsReviewer?: "user";
  sandbox?: "danger-full-access";
  sandboxPolicy?: { type: "dangerFullAccess" };
  collaborationMode?: {
    mode: "default";
    settings: {
      model: string;
      reasoning_effort: "medium";
      developer_instructions: string;
    };
  };
}

export interface ThreadSettingsSnapshot {
  model: string;
  modelProvider: string;
  serviceTier: null;
  cwd: string;
  instructionSources: unknown[];
  approvalPolicy: "on-request" | "never";
  approvalsReviewer: "user";
  sandbox: { type: "dangerFullAccess" };
  reasoningEffort: null;
}

export interface UpdatedThreadSettings {
  approvalPolicy: "on-request" | "never";
  approvalsReviewer: "user";
  collaborationMode: {
    mode: "default";
    settings: { model: string; reasoning_effort: "medium" };
  };
  cwd: string;
  effort: null;
  model: string;
  modelProvider: string;
  personality: null;
  sandboxPolicy: { type: "dangerFullAccess" };
  serviceTier: null;
  summary: null;
}

export interface ModelSummary {
  id: string;
  model: string;
  upgrade: null;
  upgradeInfo: null;
  availabilityNux: null;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: unknown[];
  defaultReasoningEffort: "medium";
  inputModalities: ["text"];
  supportsPersonality: false;
  additionalSpeedTiers: unknown[];
  serviceTiers: unknown[];
  defaultServiceTier: null;
  isDefault: boolean;
}

export interface ClientRequestParams {
  initialize: InitializeParams;
  "account/read": Record<string, never>;
  "skills/list": { cwds: string[] };
  "model/list": { cursor?: null };
  "thread/start": ThreadConfigurationParams;
  "thread/resume": { threadId: string } & ThreadConfigurationParams;
  "thread/read": { threadId: string; includeTurns?: boolean };
  "thread/list": { limit?: number; cursor?: string | null };
  "thread/name/set": { threadId: string; name: string };
  "thread/settings/update": { threadId: string; model: string };
  "thread/unsubscribe": { threadId: string };
  "turn/start": {
    threadId: string;
    input: Array<{ type: "text"; text: string }>;
    clientUserMessageId?: string;
  } & ThreadConfigurationParams;
  "turn/interrupt": { threadId: string; turnId: string };
}

export interface ClientRequestResults {
  initialize: InitializeResult;
  "account/read": { account: null; requiresOpenaiAuth: false };
  "skills/list": {
    data: Array<{ cwd: string; skills: unknown[]; errors: unknown[] }>;
  };
  "model/list": { data: ModelSummary[]; nextCursor: null };
  "thread/start": { thread: Thread } & ThreadSettingsSnapshot;
  "thread/resume": { thread: Thread } & ThreadSettingsSnapshot;
  "thread/read": { thread: Thread };
  "thread/list": {
    data: Thread[];
    nextCursor: null;
    backwardsCursor: null;
  };
  "thread/name/set": Record<string, never>;
  "thread/settings/update": Record<string, never>;
  "thread/unsubscribe": {
    status: "unsubscribed" | "notSubscribed";
  };
  "turn/start": { turn: Turn };
  "turn/interrupt": Record<string, never>;
}

export type ClientRequestMethod = keyof ClientRequestParams;

export interface ServerNotificationParams {
  "thread/started": { thread: Thread };
  "thread/name/updated": { threadId: string; threadName: string };
  "thread/settings/updated": {
    threadId: string;
    threadSettings: UpdatedThreadSettings;
  };
  "turn/started": { threadId: string; turn: Turn };
  "item/started": {
    threadId: string;
    turnId: string;
    item: ThreadItem;
    startedAtMs: number;
  };
  "item/agentMessage/delta": {
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
  };
  "item/commandExecution/outputDelta": {
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
  };
  "item/completed": {
    threadId: string;
    turnId: string;
    item: ThreadItem;
    completedAtMs: number;
  };
  "serverRequest/resolved": { threadId: string; requestId: string };
  "turn/completed": { threadId: string; turn: Turn };
  error: {
    error: {
      message: string;
      codexErrorInfo: null;
      additionalDetails: null;
    };
    willRetry: boolean;
    threadId: string;
    turnId: string;
  };
}

export type ServerNotificationMethod = keyof ServerNotificationParams;

export interface ServerRequestParams {
  "item/commandExecution/requestApproval": {
    threadId: string;
    turnId: string;
    itemId: string;
    startedAtMs: number;
    environmentId: null;
    reason: null;
    command: string;
    cwd: string;
    commandActions: unknown[];
    proposedExecpolicyAmendment: null;
    networkApprovalContext: null;
    proposedNetworkPolicyAmendments: null;
  };
}

export interface ServerRequestResults {
  "item/commandExecution/requestApproval": {
    decision: "accept" | "acceptForSession" | "decline" | "cancel";
  };
}

export type ServerRequestMethod = keyof ServerRequestParams;

export interface ServerRequestContext {
  requestId: string | number;
}

export type ConnectionStatus =
  | { type: "connecting" }
  | { type: "ready"; reconnected: boolean }
  | { type: "reconnecting"; attempt: number; delayMs: number }
  | { type: "resubscribed"; threadId: string; thread: Thread }
  | { type: "resubscribeFailed"; threadId: string; error: Error }
  | { type: "protocolError"; error: Error }
  | { type: "closed" };
