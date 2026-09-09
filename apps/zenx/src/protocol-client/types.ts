import type {
  CodexCommandItem,
  CodexThread,
  CodexThreadItem,
  CodexTurn,
} from "../../../../src/protocol/codex/mapper.js";
import type { AttachmentRef } from "../../../../src/attachment.js";
import type {
  NativeProjectedThreadEvent,
  NativeThreadRecoverySnapshot,
} from "../../../../src/protocol/native/recovery.js";

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
  effort?: string;
  approvalPolicy?: "on-request" | "never";
  approvalsReviewer?: "user";
  sandbox?: FilePermissionMode;
  sandboxPolicy?: FileSandboxPolicy;
  collaborationMode?: {
    mode: "default";
    settings: {
      model: string;
      reasoning_effort: string | null;
      developer_instructions: string;
    };
  };
}

export type FilePermissionMode =
  "read-only" | "workspace-write" | "danger-full-access";
export type FileSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly" }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

export interface ThreadSettingsSnapshot {
  model: string;
  modelProvider: string;
  serviceTier: null;
  cwd: string;
  instructionSources: unknown[];
  approvalPolicy: "on-request" | "never";
  approvalsReviewer: "user";
  sandbox: FileSandboxPolicy;
  reasoningEffort: string | null;
}

export interface UpdatedThreadSettings {
  approvalPolicy: "on-request" | "never";
  approvalsReviewer: "user";
  collaborationMode: {
    mode: "default";
    settings: { model: string; reasoning_effort: string | null };
  };
  cwd: string;
  effort: string | null;
  model: string;
  modelProvider: string;
  personality: null;
  sandboxPolicy: FileSandboxPolicy;
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
  supportedReasoningEfforts: Array<{
    reasoningEffort: string;
    description: string;
  }>;
  defaultReasoningEffort: string | null;
  inputModalities: Array<"text" | "image">;
  supportsPersonality: false;
  additionalSpeedTiers: unknown[];
  serviceTiers: unknown[];
  defaultServiceTier: null;
  isDefault: boolean;
}

export type UserInputPart =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string }
  | { type: "image"; url: string }
  | { type: "attachment"; attachment: AttachmentRef };

export interface ClientRequestParams {
  initialize: InitializeParams;
  "zen/initialize": Record<string, never>;
  "account/read": Record<string, never>;
  "skills/list": { cwds: string[] };
  "model/list": { cursor?: null };
  "thread/start": ThreadConfigurationParams;
  "thread/resume": { threadId: string } & ThreadConfigurationParams;
  "zen/thread/resume": { threadId: string };
  "thread/read": { threadId: string; includeTurns?: boolean };
  "thread/list": {
    limit?: number;
    cursor?: string | null;
    archived?: boolean | null;
  };
  "thread/name/set": { threadId: string; name: string };
  "thread/archive": { threadId: string };
  "thread/unarchive": { threadId: string };
  "thread/permissions/update": {
    threadId: string;
    sandbox: FilePermissionMode;
  };
  "thread/settings/update": {
    threadId: string;
    model: string;
    effort?: string;
  };
  "thread/unsubscribe": { threadId: string };
  "turn/start": {
    threadId: string;
    input: UserInputPart[];
    clientUserMessageId?: string;
    effort?: string | null;
  } & ThreadConfigurationParams;
  "turn/steer": {
    threadId: string;
    expectedTurnId: string;
    input: UserInputPart[];
    clientUserMessageId?: string;
  };
  "turn/queue": {
    threadId: string;
    input: UserInputPart[];
    clientUserMessageId: string;
  };
  "turn/queue/resume": { threadId: string };
  "turn/replace": {
    threadId: string;
    expectedTurnId: string;
    input: UserInputPart[];
    clientUserMessageId: string;
  };
  "turn/interrupt": { threadId: string; turnId: string };
}

export interface ClientRequestResults {
  initialize: InitializeResult;
  "zen/initialize": { processEpoch: string };
  "account/read": { account: null; requiresOpenaiAuth: false };
  "skills/list": {
    data: Array<{ cwd: string; skills: unknown[]; errors: unknown[] }>;
  };
  "model/list": { data: ModelSummary[]; nextCursor: null };
  "thread/start": { thread: Thread } & ThreadSettingsSnapshot;
  "thread/resume": { thread: Thread } & ThreadSettingsSnapshot;
  "zen/thread/resume": NativeThreadRecoverySnapshot;
  "thread/read": { thread: Thread };
  "thread/list": {
    data: Thread[];
    nextCursor: string | null;
    backwardsCursor: null;
  };
  "thread/name/set": Record<string, never>;
  "thread/archive": Record<string, never>;
  "thread/unarchive": { thread: Thread };
  "thread/permissions/update": Record<string, never>;
  "thread/settings/update": Record<string, never>;
  "thread/unsubscribe": {
    status: "unsubscribed" | "notSubscribed";
  };
  "turn/start": { turn: Turn };
  "turn/steer": { turnId: string };
  "turn/queue": Record<string, never>;
  "turn/queue/resume": Record<string, never>;
  "turn/replace": { interruptedTurnId: string; turnId: string };
  "turn/interrupt": Record<string, never>;
}

export type ClientRequestMethod = keyof ClientRequestParams;

export interface ServerNotificationParams {
  "zen/thread/event": NativeProjectedThreadEvent;
  "model/catalog/updated": { processEpoch: string; revision: number };
  "thread/started": { thread: Thread };
  "thread/name/updated": { threadId: string; threadName: string };
  "thread/archived": { threadId: string };
  "thread/unarchived": { threadId: string };
  "thread/settings/updated": {
    threadId: string;
    threadSettings: UpdatedThreadSettings;
  };
  "thread/queue/updated": {
    threadId: string;
    queuedMessages: NonNullable<Thread["queuedMessages"]>;
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
  "item/reasoning/summaryPartAdded": {
    threadId: string;
    turnId: string;
    itemId: string;
    summaryIndex: number;
  };
  "item/reasoning/summaryTextDelta": {
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
    summaryIndex: number;
  };
  "item/reasoning/textDelta": {
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
    contentIndex: number;
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
    approvalScope?: "once";
    toolName?: string;
    toolArguments?: Readonly<Record<string, unknown>>;
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
  connectionGeneration: number;
}

export type ConnectionStatus =
  | { type: "connecting" }
  | { type: "ready"; reconnected: boolean }
  | { type: "reconnecting"; attempt: number; delayMs: number }
  | {
      type: "resubscribed";
      threadId: string;
      recovery: NativeThreadRecoverySnapshot;
    }
  | { type: "resubscribeFailed"; threadId: string; error: Error }
  | { type: "protocolError"; error: Error }
  | { type: "closed" };
