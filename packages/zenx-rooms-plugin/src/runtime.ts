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
  id: string;
  roomId: string;
  author: string;
  text: string;
  createdAt: number;
  kind: string;
  originThreadId: string | null;
  originTurnId: string | null;
}

export interface Room {
  id: string;
  name: string;
  members: RoomMember[];
  messages: RoomMessage[];
  createdAt: number;
}

export interface ZenXRoomsTrustedService {
  snapshot(): { rooms: Room[] };
  createRoom(input: { name: string; members: RoomMember[] }): Promise<Room>;
  renameRoom(roomId: string, name: string): Promise<void>;
  deleteRoom(roomId: string): Promise<void>;
  addRoomMember(roomId: string, member: RoomMember): Promise<void>;
  removeRoomMember(roomId: string, threadId: string): Promise<void>;
  postAgentRoomMessage(roomId: string, text: string): Promise<void>;
  postRoomMessage?(roomId: string, author: string, text: string): Promise<void>;
  startPlugin?(pluginId: string, sdk: ZenXPluginHostSdkV1): Promise<void>;
  stopPlugin?(pluginId: string): Promise<void>;
}

export interface ZenXTrustedPluginInvocation {
  readonly callId: string;
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
  return {
    storage: { version: 1, initialValue: { rooms: [] } },
    start: async (sdk) => await service.startPlugin?.(PLUGIN_ID, sdk),
    invoke: async (toolName, invocation) => {
      invocation.signal.throwIfAborted();
      const uiInput = record(invocation.arguments["input"]);
      const args = uiInput ?? invocation.arguments;
      switch (toolName) {
        case "zenx_rooms_list":
          return { rooms: service.snapshot().rooms.map(readSafeRoom) };
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
          if (uiInput !== null && service.postRoomMessage !== undefined) {
            await service.postRoomMessage(roomId, "You", text);
          } else {
            await service.postAgentRoomMessage(roomId, text);
          }
          return { posted: true };
        }
        default:
          throw new Error(`Unsupported Rooms tool: ${toolName}`);
      }
    },
    close: async () => await service.stopPlugin?.(PLUGIN_ID),
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
    id: room.id,
    name: room.name,
    createdAt: room.createdAt,
    members: room.members.map((member) => ({
      name: member.name,
      threadId: member.threadId,
    })),
    messages: room.messages.slice(-50).map((message) => ({
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
