import type { ZenXPluginHostSdkV1 } from "@zenx/plugin-sdk";

const PLUGIN_ID = "zenx-rooms";
const MAX_ID_BYTES = 512;
const MAX_ROOM_NAME_BYTES = 256;
const MAX_MEMBER_NAME_BYTES = 128;
const MAX_MESSAGE_TEXT_BYTES = 8_000;
const MAX_ROOM_MEMBERS = 64;

export interface RoomMember {
  name: string;
  threadId: string;
}

export interface RoomMessage {
  replyTo?: { messageId: string; author: string; text: string };
  reactions?: Array<{ actorId: string; label: string; emoji: string }>;
  id: string;
  roomId: string;
  author: string;
  text: string;
  createdAt: number;
  kind: string;
  originThreadId: string | null;
  originTurnId: string | null;
}

export interface RoomOperation {
  id: string;
  text: string;
  messageId: string | null;
  createdAt: number;
  acknowledged: boolean;
  mentions: Array<{ name: string; threadId: string; triggerIds: string[] }>;
}

export interface Room {
  assistant?: { threadId: string; triggerId: string };
  id: string;
  name: string;
  members: RoomMember[];
  messages: RoomMessage[];
  operations?: RoomOperation[];
  operationEpoch?: string;
  createdAt: number;
}

// Plugin service JSON contract. The Host validates and commits annotations.
export type AssistantReference =
  | {
      kind: "thread";
      device: string;
      workspace: string;
      threadId: string;
      label: string;
    }
  | { kind: "trigger"; triggerId: string; label: string };
export interface AssistantMatter {
  id: string;
  title: string;
  plan: string;
  statusNote: string;
  notes: string;
  references: AssistantReference[];
}
export interface AssistantMemory {
  id: string;
  title: string;
  text: string;
}
export interface AssistantWorkspace {
  revision: number;
  updatedAt: number;
  matters: AssistantMatter[];
  memory: AssistantMemory[];
}
export interface UpdateAssistantWorkspaceInput {
  roomId: string;
  expectedRevision: number;
  matters: AssistantMatter[];
  memory: AssistantMemory[];
}

export interface ZenXRoomsTrustedService {
  assistantWorkspace?(roomId: string): AssistantWorkspace;
  updateAssistantWorkspace?(
    input: UpdateAssistantWorkspaceInput,
  ): Promise<AssistantWorkspace>;
  createAssistantRoom?(input: {
    name: string;
    members: RoomMember[];
  }): Promise<Room>;
  setAssistantReplies?(roomId: string, enabled: boolean): Promise<void>;
  createRoom(input: { name: string; members: RoomMember[] }): Promise<Room>;
  renameRoom(roomId: string, name: string): Promise<void>;
  deleteRoom(roomId: string): Promise<void>;
  addRoomMember(roomId: string, member: RoomMember): Promise<void>;
  removeRoomMember(roomId: string, threadId: string): Promise<void>;
  postAgentRoomMessage(
    roomId: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<void>;
  postRoomMessage?(roomId: string, author: string, text: string): Promise<void>;
  prepareRoomMessage?(
    roomId: string,
    operationId: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<RoomOperation>;
  postPreparedRoomMessage?(
    roomId: string,
    operationId: string,
    text: string,
  ): Promise<RoomOperation>;
  cancelPreparedRoomOperation?(
    roomId: string,
    operationId: string,
  ): Promise<unknown>;
  roomOperation?(roomId: string, operationId: string): unknown;
  roomDelivery?(roomId: string, messageId: string): unknown;
  reactRoomMessage?(
    roomId: string,
    messageId: string,
    emoji: string | null,
  ): Promise<RoomMessage>;
  wakeupsEnabled?(): boolean;
  acknowledgeRoomOperation?(roomId: string, operationId: string): Promise<void>;
  snapshot(): {
    rooms: Room[];
    triggers?: Array<{
      id?: string;
      active: boolean;
      kind: string;
      threadId: string;
      room?: { roomId: string; mention: string };
    }>;
  };
  startPlugin?(pluginId: string, sdk: ZenXPluginHostSdkV1): Promise<void>;
  stopPlugin?(
    pluginId: string,
    runtimeSdk?: ZenXPluginHostSdkV1,
  ): Promise<void>;
}

export interface ZenXTrustedPluginInvocation {
  readonly callId: string;
  readonly trustedPluginUi?: true;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly cwd: string;
  readonly signal: AbortSignal;
}

export interface ZenXTrustedPluginRuntime {
  readonly storage: {
    readonly version: 1;
    readonly initialValue: { readonly rooms: readonly never[] };
  };
  start(sdk: ZenXPluginHostSdkV1): Promise<void>;
  invoke(
    toolName: string,
    invocation: ZenXTrustedPluginInvocation,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export function createZenXTrustedPlugin(
  service: ZenXRoomsTrustedService,
): ZenXTrustedPluginRuntime {
  let runtimeSdk: ZenXPluginHostSdkV1 | undefined;
  return {
    storage: { version: 1, initialValue: { rooms: [] } },
    start: async (sdk) => {
      await service.startPlugin?.(PLUGIN_ID, sdk);
      runtimeSdk = sdk;
    },
    invoke: async (toolName, invocation) => {
      invocation.signal.throwIfAborted();
      // Only the Host's direct UI command route may mint trustedPluginUi.
      // Agent tool arguments (including nested input/source/trustedPluginUi)
      // are never authority, even when the model omits schema validation.
      const uiInput =
        invocation.trustedPluginUi === true
          ? (record(invocation.arguments["input"]) ?? {})
          : null;
      const args = uiInput ?? invocation.arguments;
      switch (toolName) {
        case "zenx_rooms_workspace":
          fields(args, ["roomId"]);
          if (!service.assistantWorkspace)
            throw Error("Companion workspace service unavailable");
          return service.assistantWorkspace(
            string(args, "roomId", MAX_ID_BYTES),
          );
        case "zenx_rooms_update_workspace": {
          fields(args, ["roomId", "expectedRevision", "matters", "memory"]);
          if (!service.updateAssistantWorkspace)
            throw Error("Companion workspace service unavailable");
          if (
            !Number.isSafeInteger(args["expectedRevision"]) ||
            Number(args["expectedRevision"]) < 0 ||
            !Array.isArray(args["matters"]) ||
            !Array.isArray(args["memory"])
          )
            throw Error(
              "Invalid Companion workspace update fields or revision",
            );
          return await service.updateAssistantWorkspace({
            roomId: string(args, "roomId", MAX_ID_BYTES),
            expectedRevision: Number(args["expectedRevision"]),
            matters: args["matters"] as AssistantMatter[],
            memory: args["memory"] as AssistantMemory[],
          });
        }
        case "zenx_rooms_list": {
          const state = service.snapshot();
          const cursor = Number(args["cursor"] ?? 0);
          if (!Number.isSafeInteger(cursor) || cursor < 0)
            throw new Error("Invalid Room list cursor");
          return {
            nextCursor: cursor + 1 < state.rooms.length ? cursor + 1 : null,
            rooms: state.rooms.slice(cursor, cursor + 1).map((room) => ({
              ...readSafeRoom(room),
              messageCount: room.messages.length,
              messages: room.messages
                .slice(-1)
                .map(
                  ({
                    replyTo: _replyTo,
                    reactions: _reactions,
                    ...message
                  }) => ({
                    ...message,
                    text: Array.from(message.text).slice(0, 120).join(""),
                  }),
                ),
              ...(uiInput === null
                ? {}
                : {
                    assistantRepliesEnabled: room.assistant
                      ? (service.wakeupsEnabled?.() ?? false) &&
                        state.triggers?.some(
                          (t) =>
                            t.active &&
                            t.kind === "roomMention" &&
                            t.threadId === room.assistant!.threadId &&
                            t.room?.roomId === room.id &&
                            t.id === room.assistant!.triggerId,
                        ) === true
                      : undefined,
                    operationEpoch: room.operationEpoch ?? "legacy",
                    pendingCount: (room.operations ?? []).filter(
                      (operation) => !operation.acknowledged,
                    ).length,
                    operations: [],
                    responders: room.members.map((member) => ({
                      name: member.name,
                      configured:
                        ((service.wakeupsEnabled?.() ?? false) &&
                          state.triggers?.some(
                            (trigger) =>
                              trigger.active &&
                              trigger.kind === "roomMention" &&
                              trigger.threadId === member.threadId &&
                              trigger.room?.roomId === room.id &&
                              trigger.room.mention.toLocaleLowerCase() ===
                                member.name.toLocaleLowerCase(),
                          )) ??
                        false,
                    })),
                  }),
            })),
          };
        }
        case "zenx_rooms_messages": {
          const roomId = string(args, "roomId", MAX_ID_BYTES);
          const cursor = Number(args["cursor"] ?? 0);
          if (!Number.isSafeInteger(cursor) || cursor < 0)
            throw new Error("Invalid Room message cursor");
          const room = service
            .snapshot()
            .rooms.find((entry) => entry.id === roomId);
          if (!room) throw new Error("Room was not found");
          const end = Math.max(0, room.messages.length - cursor);
          let start = end;
          while (start > 0 && end - start < 4) {
            const bytes = new TextEncoder().encode(
              JSON.stringify(room.messages.slice(start - 1, end)),
            ).byteLength;
            // Usually keep pages under 60 KiB. One reaction-heavy message may
            // exceed that target, but never split or truncate its body.
            if (start < end && bytes > 60 * 1024) break;
            start -= 1;
          }
          return {
            roomId,
            messages: room.messages.slice(start, end),
            nextCursor: start > 0 ? cursor + (end - start) : null,
          };
        }
        case "zenx_rooms_operations": {
          if (uiInput === null) throw new Error("Trusted Room UI required");
          const roomId = string(args, "roomId", MAX_ID_BYTES);
          const cursor = Number(args["cursor"] ?? 0);
          if (!Number.isSafeInteger(cursor) || cursor < 0)
            throw new Error("Invalid Room operation cursor");
          const room = service
            .snapshot()
            .rooms.find((entry) => entry.id === roomId);
          if (!room) throw new Error("Room was not found");
          const pending = (room.operations ?? []).filter(
            (operation) => !operation.acknowledged,
          );
          const page = pending.slice(cursor, cursor + 8).map((operation) => ({
            id: operation.id,
            text: Array.from(operation.text).slice(0, 120).join(""),
            messageId: operation.messageId,
            createdAt: operation.createdAt,
          }));
          return {
            operations: page,
            nextCursor:
              cursor + page.length < pending.length
                ? cursor + page.length
                : null,
          };
        }
        case "zenx_rooms_prepare_message":
          if (uiInput === null || !service.prepareRoomMessage)
            throw new Error("Trusted Room UI required");
          return await service.prepareRoomMessage(
            string(args, "roomId", MAX_ID_BYTES),
            string(args, "operationId", MAX_ID_BYTES),
            string(args, "text", MAX_MESSAGE_TEXT_BYTES),
            args["replyToMessageId"] === undefined
              ? undefined
              : string(args, "replyToMessageId", MAX_ID_BYTES),
          );
        case "zenx_rooms_react":
          if (!service.reactRoomMessage)
            throw new Error("Room reactions unavailable");
          const updatedMessage = await service.reactRoomMessage(
            string(args, "roomId", MAX_ID_BYTES),
            string(args, "messageId", MAX_ID_BYTES),
            args["emoji"] === null ? null : string(args, "emoji", 32),
          );
          return { updated: true, message: updatedMessage };
        case "zenx_rooms_cancel_prepared":
          if (uiInput === null || !service.cancelPreparedRoomOperation)
            throw new Error("Trusted Room UI required");
          return await service.cancelPreparedRoomOperation(
            string(args, "roomId", MAX_ID_BYTES),
            string(args, "operationId", MAX_ID_BYTES),
          );
        case "zenx_rooms_operation":
          if (uiInput === null || !service.roomOperation)
            throw new Error("Trusted Room UI required");
          return service.roomOperation(
            string(args, "roomId", MAX_ID_BYTES),
            string(args, "operationId", MAX_ID_BYTES),
          );
        case "zenx_rooms_delivery":
          if (uiInput === null || !service.roomDelivery)
            throw new Error("Trusted Room UI required");
          return service.roomDelivery(
            string(args, "roomId", MAX_ID_BYTES),
            string(args, "messageId", MAX_ID_BYTES),
          );
        case "zenx_rooms_ack_operation":
          if (uiInput === null || !service.acknowledgeRoomOperation)
            throw new Error("Trusted Room UI required");
          await service.acknowledgeRoomOperation(
            string(args, "roomId", MAX_ID_BYTES),
            string(args, "operationId", MAX_ID_BYTES),
          );
          return { acknowledged: true };
        case "zenx_rooms_create_assistant":
          if (uiInput === null || !service.createAssistantRoom)
            throw new Error("Trusted Room UI required");
          return await service.createAssistantRoom({
            name: string(args, "name", MAX_ROOM_NAME_BYTES),
            members: members(args["members"]),
          });
        case "zenx_rooms_assistant_replies":
          if (uiInput === null || !service.setAssistantReplies)
            throw new Error("Trusted Room UI required");
          if (typeof args["enabled"] !== "boolean")
            throw new Error("enabled must be boolean");
          await service.setAssistantReplies(
            string(args, "roomId", MAX_ID_BYTES),
            args["enabled"],
          );
          return { updated: true };
        case "zenx_rooms_create":
          return await service.createRoom({
            name: string(args, "name", MAX_ROOM_NAME_BYTES),
            members: members(args["members"]),
          });
        case "zenx_rooms_rename":
          await service.renameRoom(
            string(args, "roomId", MAX_ID_BYTES),
            string(args, "name", MAX_ROOM_NAME_BYTES),
          );
          return { renamed: true };
        case "zenx_rooms_delete":
          await service.deleteRoom(string(args, "roomId", MAX_ID_BYTES));
          return { deleted: true };
        case "zenx_rooms_add_member":
          await service.addRoomMember(string(args, "roomId", MAX_ID_BYTES), {
            name: string(args, "name", MAX_MEMBER_NAME_BYTES),
            threadId: string(args, "threadId", MAX_ID_BYTES),
          });
          return { added: true };
        case "zenx_rooms_remove_member":
          await service.removeRoomMember(
            string(args, "roomId", MAX_ID_BYTES),
            string(args, "threadId", MAX_ID_BYTES),
          );
          return { removed: true };
        case "zenx_rooms_post_message": {
          const roomId = string(args, "roomId", MAX_ID_BYTES);
          const text = string(args, "text", MAX_MESSAGE_TEXT_BYTES);
          if (uiInput !== null) {
            if (!service.postPreparedRoomMessage)
              throw new Error("Trusted Room operation service unavailable");
            const operation = await service.postPreparedRoomMessage(
              roomId,
              string(args, "operationId", MAX_ID_BYTES),
              text,
            );
            return {
              posted: true,
              roomId,
              operationId: operation.id,
              messageId: operation.messageId,
            };
          }
          await service.postAgentRoomMessage(
            roomId,
            text,
            args["replyToMessageId"] === undefined
              ? undefined
              : string(args, "replyToMessageId", MAX_ID_BYTES),
          );
          return { posted: true };
        }
        default:
          throw new Error(`Unsupported Rooms tool: ${toolName}`);
      }
    },
    close: async () => {
      await service.stopPlugin?.(PLUGIN_ID, runtimeSdk);
      runtimeSdk = undefined;
    },
  };
}

function members(value: unknown): RoomMember[] {
  if (!Array.isArray(value)) throw new Error("members must be an array");
  if (value.length === 0 || value.length > MAX_ROOM_MEMBERS) {
    throw new Error(
      `members must contain 1-${String(MAX_ROOM_MEMBERS)} entries`,
    );
  }
  return value.map((entry) => {
    const member = record(entry);
    if (member === null) throw new Error("member must be an object");
    return {
      name: string(member, "name", MAX_MEMBER_NAME_BYTES),
      threadId: string(member, "threadId", MAX_ID_BYTES),
    };
  });
}

function readSafeRoom(room: Room) {
  return {
    ...(room.assistant ? { assistant: { ...room.assistant } } : {}),
    id: room.id,
    name: room.name,
    createdAt: room.createdAt,
    members: room.members.map((member) => ({
      name: member.name,
      threadId: member.threadId,
    })),
    messages: room.messages.slice(-50).map((message) => ({
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
      ...(message.reactions === undefined
        ? {}
        : { reactions: message.reactions }),
      id: message.id,
      roomId: message.roomId,
      author: message.author,
      text: message.text,
      createdAt: message.createdAt,
      kind: message.kind,
      originThreadId: message.originThreadId,
      originTurnId: message.originTurnId,
    })),
  };
}

function string(
  args: Readonly<Record<string, unknown>>,
  key: string,
  maximum: number,
): string {
  const value = args[key];
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value.trim(), "utf8") > maximum
  ) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
function fields(args: Readonly<Record<string, unknown>>, allowed: string[]) {
  if (Object.keys(args).some((key) => !allowed.includes(key)))
    throw Error("Unknown Companion workspace input field");
}
