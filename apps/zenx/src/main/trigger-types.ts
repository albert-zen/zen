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
  threadId: string;
  kind: TriggerKind;
  label: string;
  prompt: string;
  createdAt: number;
  active: boolean;
  timer?: { nextRunAt: number; intervalMinutes: number | null };
  watch?: { threadId: string; event: "turn_completed" };
  room?: { roomId: string; mention: string };
  signal?: { name: string };
  program?: TriggerProgramConfig;
}

export interface TriggerHistoryEntry {
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
export interface ZenXRoom {
  id: string;
  name: string;
  members: RoomMember[];
  messages: RoomMessage[];
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
