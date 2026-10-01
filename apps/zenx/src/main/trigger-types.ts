export type TriggerKind = "timer" | "thread" | "roomMention" | "signal";

export type TriggerProgramStage = "predicate" | "action";

export interface TriggerProgramSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface TriggerMatchSpec {
  field: "completedItemText";
  regex: string;
  flags?: string;
}

export interface TriggerProgramConfig {
  predicate?: TriggerProgramSpec;
  action?: TriggerProgramSpec;
  match?: TriggerMatchSpec;
}

export interface TriggerProgramOutcome {
  stage: TriggerProgramStage;
  invocationId: string;
  status:
    | "matched"
    | "non_match"
    | "completed"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "nonzero_exit"
    | "malformed_output"
    | "oversized_output"
    | "uncertain";
  output: string | null;
  exitCode: number | null;
  error: string | null;
}

export interface TriggerProgramInput {
  program?: TriggerProgramConfig;
  predicate?: TriggerProgramSpec;
  action?: TriggerProgramSpec;
  match?: TriggerMatchSpec;
}

export interface ZenXTrigger {
  id: string;
  /** Monotonic definition mutation fence; legacy definitions start at zero. */
  definitionRevision?: number;
  threadId: string;
  kind: TriggerKind;
  label: string;
  prompt: string;
  createdAt: number;
  active: boolean;
  /** Transient source-observation error; never part of a stored definition. */
  sourceError?: string;
  timer?: { nextRunAt: number; intervalMinutes: number | null };
  watch?: {
    threadId: string;
    event: "turn_completed";
    once?: boolean;
    sourceDevice?: string;
    sourceWorkspace?: string;
  };
  room?: { roomId: string; mention: string };
  signal?: { name: string };
  program?: TriggerProgramConfig;
}

export interface TriggerHistoryEntry {
  delivery?: "pending" | "queued" | "failed" | "unknown";
  id: string;
  triggerId: string;
  threadId: string;
  kind: TriggerKind;
  reason: string;
  prompt: string;
  clientUserMessageId: string;
  startedAt: number;
  completedAt: number | null;
  status: "starting" | "running" | "completed" | "failed";
  turnId: string | null;
  error: string | null;
  sourceThreadId: string | null;
  sourceDevice?: string;
  sourceWorkspace?: string;
  sourceTurnId: string | null;
  sourceRoomId: string | null;
  sourceRoomMessageId: string | null;
  replyRoomId: string | null;
  replyAuthor: string | null;
  programInvocationId: string | null;
  programOutcome: TriggerProgramOutcome | null;
  programOutcomes: TriggerProgramOutcome[];
}

export interface RoomMember {
  name: string;
  threadId: string;
}
export interface RoomMessage {
  id: string;
  roomId: string;
  author: string;
  text: string;
  createdAt: number;
  kind: "human" | "agent" | "system";
  originThreadId: string | null;
  originTurnId: string | null;
}
export interface RoomSendOperation {
  id: string;
  text: string;
  messageId: string | null;
  createdAt: number;
  acknowledged: boolean;
  /** Persisted terminal fact: never permit a later post/prepare of this key. */
  cancelled?: true;
  mentions: Array<{ name: string; threadId: string; triggerIds: string[] }>;
}
export interface RoomDeliveryView {
  operationId: string;
  roomId: string;
  text: string;
  messageId: string | null;
  state: "prepared" | "saved" | "cancelled";
  createdAt: number;
  mentions: Array<{
    name: string;
    threadId: string;
    configuredNow: boolean;
    deliveries: Array<{
      triggerId: string;
      status:
        | "unconfigured"
        | "pending"
        | "queued"
        | "running"
        | "completed"
        | "failed"
        | "unknown";
      historyId: string | null;
    }>;
  }>;
}
export interface ZenXRoom {
  assistant?: { threadId: string; triggerId: string };
  id: string;
  name: string;
  operationEpoch?: string;
  members: RoomMember[];
  messages: RoomMessage[];
  operations?: RoomSendOperation[];
  createdAt: number;
}

export interface TriggerSnapshot {
  triggers: ZenXTrigger[];
  history: TriggerHistoryEntry[];
  rooms: ZenXRoom[];
}

export type CreateTriggerInput =
  | ({
      threadId: string;
      kind: "timer";
      label: string;
      prompt: string;
      runAt: number;
      intervalMinutes?: number;
    } & TriggerProgramInput)
  | ({
      threadId: string;
      kind: "thread";
      label: string;
      prompt: string;
      watchedThreadId: string;
      sourceDevice?: string;
      sourceWorkspace?: string;
      once?: boolean;
      includeLatest?: boolean;
    } & TriggerProgramInput)
  | ({
      threadId: string;
      kind: "roomMention";
      label: string;
      prompt: string;
      roomId: string;
      mention: string;
    } & TriggerProgramInput)
  | ({
      threadId: string;
      kind: "signal";
      label: string;
      prompt: string;
      signalName: string;
    } & TriggerProgramInput);

export type UpdateTriggerInput = CreateTriggerInput & { id: string };

export interface CreateRoomInput {
  name: string;
  members: RoomMember[];
}

export interface UpdateRoomMemberInput {
  roomId: string;
  member: RoomMember;
}
