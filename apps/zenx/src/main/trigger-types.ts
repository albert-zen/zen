export type TriggerKind = "timer" | "thread" | "roomMention" | "signal";

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
  | {
      threadId: string;
      kind: "timer";
      label: string;
      prompt: string;
      runAt: number;
      intervalMinutes?: number;
    }
  | {
      threadId: string;
      kind: "thread";
      label: string;
      prompt: string;
      watchedThreadId: string;
    }
  | {
      threadId: string;
      kind: "roomMention";
      label: string;
      prompt: string;
      roomId: string;
      mention: string;
    }
  | {
      threadId: string;
      kind: "signal";
      label: string;
      prompt: string;
      signalName: string;
    };

export interface CreateRoomInput {
  name: string;
  members: RoomMember[];
}
