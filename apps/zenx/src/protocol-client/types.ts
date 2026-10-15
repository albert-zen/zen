import type {
  CodexCommandItem,
  CodexThread,
  CodexThreadItem,
  CodexTurn,
} from "../../../../src/protocol/codex/mapper.js";
import type {
  NativeForkThreadParams,
  NativeForkThreadResult,
} from "../../../../src/protocol/native/wire.js";
import type { AttachmentRef } from "../../../../src/attachment.js";
import type { CanonicalItem } from "../../../../src/item.js";
import type { ThreadSnapshot } from "../../../../src/app-server.js";
import type { NativeCreateChildThreadParams } from "../../../../src/protocol/native/wire.js";
import type {
  NativeProjectedThreadEvent,
  NativeThreadRecoverySnapshot,
} from "../../../../src/protocol/native/recovery.js";

export type Thread = Omit<
  CodexThread,
  "parentThreadId" | "turns" | "queuedMessages"
> & {
  /** Native-only creation relation; CAS continues to project null. */
  parentThreadId: string | null;
  /** Native product projection input; absent on CAS-only compatibility data. */
  canonicalItems?: readonly CanonicalItem[];
  turns: Turn[];
  queuedMessages?: Array<
    NonNullable<CodexThread["queuedMessages"]>[number] & {
      sender?: import("../../../../src/item.js").ThreadMessageSender;
      hostSource?: Pick<
        import("../../../../src/item.js").HostWakeupInput,
        "source" | "sourceId"
      >;
    }
  >;
};
export type Turn = Omit<CodexTurn, "items"> & { items: ThreadItem[] };
export type ThreadItem =
  | CodexThreadItem
  | {
      type: "hostMessage";
      id: string;
      clientId: string;
      source: import("../../../../src/item.js").HostWakeupInput["source"];
      sourceId?: string;
      text: string;
      mode: "start" | "steer";
      deliveryAfter?: string;
    }
  | {
      type: "threadMessage";
      id: string;
      clientId: string;
      sender: import("../../../../src/item.js").ThreadMessageSender;
      content: Array<{ type: "text"; text: string; text_elements: [] }>;
      deliveryAfter?: string;
    };
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
  "zen/thread/import/preview": import("../../../../src/protocol/session-import.js").SessionImportParams;
  "zen/thread/import": import("../../../../src/protocol/session-import.js").SessionImportCommitParams;
  "zen/turn/wake": import("../../../../src/protocol/native/wire.js").NativeHostWakeupParams;
  "zen/thread/queue/edit": import("../../../../src/protocol/native/wire.js").NativeQueueEditParams;
  "zen/thread/message": import("../../../../src/protocol/native/wire.js").NativeThreadMessageParams;
  "zen/turn/send": import("../../../../src/protocol/native/wire.js").NativeTurnSendParams;
  "zen/turn/send-unarchived": import("../../../../src/protocol/native/wire.js").NativeTurnSendParams;
  "zen/thread/queue/cancel": {
    threadId: string;
    items: readonly { queuedItemId: string; clientId: string }[];
  };
  initialize: InitializeParams;
  "zen/initialize": Record<string, never>;
  "account/read": Record<string, never>;
  "skills/list": { cwds: string[] };
  "model/list": { cursor?: null };
  "thread/start": ThreadConfigurationParams;
  "zen/thread/fork": NativeForkThreadParams;
  "thread/fork": {
    sourceThreadId: string;
    through: { type: "latest-complete" };
    workspace: { type: "same-directory" };
  };
  "thread/resume": { threadId: string } & ThreadConfigurationParams;
  "zen/thread/resume": { threadId: string };
  "zen/thread/read": { threadId: string };
  "zen/thread/delete": { threadId: string; expectedLastItemId: string };
  "zen/thread/deleted/list": Record<string, never>;
  "zen/thread/restore": { threadId: string; deletionItemId: string };
  "zen/thread/create-child": NativeCreateChildThreadParams;
  "zen/thread/create-child-configured": NativeCreateChildThreadParams;
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
  "thread/original/read": {
    threadId: string;
    throughItemId: string;
    beforeItemId?: string;
    limit?: number;
  };
  "thread/compact": {
    threadId: string;
    includeOriginalReference?: boolean;
    retention?: {
      mode?: "budget" | "recent-items" | "selected-items";
      recentItemCount?: number;
      recentTurnCount?: number;
      itemIds?: string[];
      itemRanges?: { fromItemId: string; toItemId: string }[];
      preserveUserMessages?: boolean;
      finalMessages?: "none" | "all" | "recent";
      finalMessageCount?: number;
    };
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
  "zen/thread/import/preview": import("../../../../src/protocol/session-import.js").SessionImportPreview;
  "zen/thread/import": {
    thread: ThreadSnapshot;
    status: "imported" | "already_imported";
  };
  "zen/turn/wake": import("../../../../src/protocol/native/wire.js").NativeHostWakeupResult;
  "zen/thread/queue/edit": import("../../../../src/protocol/native/wire.js").NativeQueueEditResult;
  "zen/thread/message": import("../../../../src/protocol/native/wire.js").NativeThreadMessageResult;
  "zen/turn/send": import("../../../../src/protocol/native/wire.js").NativeTurnSendResult;
  "zen/turn/send-unarchived": import("../../../../src/protocol/native/wire.js").NativeTurnSendResult;
  "zen/thread/queue/cancel": {
    results: import("../../../../src/app-server.js").QueuedCancellationResult[];
  };
  initialize: InitializeResult;
  "zen/initialize": { processEpoch: string };
  "account/read": { account: null; requiresOpenaiAuth: false };
  "skills/list": {
    data: Array<{ cwd: string; skills: unknown[]; errors: unknown[] }>;
  };
  "model/list": { data: ModelSummary[]; nextCursor: null };
  "thread/start": { thread: Thread } & ThreadSettingsSnapshot;
  "zen/thread/fork": NativeForkThreadResult;
  "thread/fork": { thread: Thread } & ThreadSettingsSnapshot;
  "thread/resume": { thread: Thread } & ThreadSettingsSnapshot;
  "zen/thread/resume": NativeThreadRecoverySnapshot;
  "zen/thread/read": { thread: ThreadSnapshot };
  "zen/thread/delete": { threadId: string; deletionItemId: string };
  "zen/thread/deleted/list": {
    data: import("../../../../src/protocol/native/wire.js").DeletedThreadSummary[];
  };
  "zen/thread/restore": { thread: ThreadSnapshot };
  "zen/thread/create-child": { thread: ThreadSnapshot };
  "zen/thread/create-child-configured": { thread: ThreadSnapshot };
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
  "thread/original/read": {
    items: Thread["turns"][number]["items"];
    nextBeforeItemId: string | null;
  };
  "thread/compact": { compactionItemId: string };
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
    reason: string | null;
    command: string;
    approvalScope?: "once";
    approvalTarget?: Readonly<{ key: string; label: string }>;
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

export type {
  NativeHostWakeupParams,
  NativeHostWakeupResult,
} from "../../../../src/protocol/native/wire.js";
