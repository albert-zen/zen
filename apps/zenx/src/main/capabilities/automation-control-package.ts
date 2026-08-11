import type { ToolInvocation } from "../../../../../src/tool.js";
import type {
  CreateRoomInput,
  CreateTriggerInput,
  RoomMember,
  TriggerSnapshot,
  UpdateTriggerInput,
  ZenXRoom,
  ZenXTrigger,
} from "../trigger-types.js";
import type { ZenXCapabilityManifest, ZenXCapabilityPackage } from "./types.js";

export const ZENX_AUTOMATION_CONTROL_CAPABILITY_ID = "zenx-automation-control";
export const ZENX_AUTOMATION_READ_PERMISSION = "zenx-automation-control.read";
export const ZENX_AUTOMATION_WRITE_PERMISSION = "zenx-automation-control.write";

export interface ZenXAutomationControlPort {
  snapshot(): TriggerSnapshot;
  create(input: CreateTriggerInput): Promise<ZenXTrigger>;
  update(input: UpdateTriggerInput): Promise<ZenXTrigger>;
  cancel(triggerId: string): Promise<void>;
  delete(triggerId: string): Promise<void>;
  createRoom(input: CreateRoomInput): Promise<ZenXRoom>;
  renameRoom(roomId: string, name: string): Promise<void>;
  deleteRoom(roomId: string): Promise<void>;
  addRoomMember(roomId: string, member: RoomMember): Promise<void>;
  removeRoomMember(roomId: string, threadId: string): Promise<void>;
  postAgentRoomMessage(roomId: string, text: string): Promise<void>;
}

const triggerProperties = {
  threadId: { type: "string" },
  kind: { type: "string", enum: ["timer", "thread", "roomMention", "signal"] },
  label: { type: "string" },
  prompt: { type: "string" },
  runAt: { type: "number" },
  intervalMinutes: { type: "number" },
  watchedThreadId: { type: "string" },
  roomId: { type: "string" },
  mention: { type: "string" },
  signalName: { type: "string" },
} as const;

const manifest: ZenXCapabilityManifest = {
  schemaVersion: 1,
  id: ZENX_AUTOMATION_CONTROL_CAPABILITY_ID,
  displayName: "ZenX automations and Rooms",
  version: "1.0.0",
  description:
    "Inspect and manage ZenX Trigger wakeups and collaborative Rooms without creating another Agent runtime or transcript.",
  provider: {
    id: "zenx-automation-service",
    platforms: ["*"],
    interactionModes: ["background_safe"],
    capabilities: ["zenx.triggers.manage", "zenx.rooms.manage"],
  },
  permissions: [
    {
      id: ZENX_AUTOMATION_READ_PERMISSION,
      title: "Read automations and Rooms",
      description:
        "List Trigger definitions, bounded history, Rooms, and messages.",
      scope: "workspace",
    },
    {
      id: ZENX_AUTOMATION_WRITE_PERMISSION,
      title: "Manage automations and Rooms",
      description:
        "Create, update, cancel, and delete Triggers and manage Room collaboration.",
      scope: "local-device",
    },
  ],
  tools: [
    tool(
      "zenx_triggers_list",
      "List Trigger definitions and bounded wakeup history.",
      {},
      [],
      false,
    ),
    tool(
      "zenx_triggers_create",
      "Create a timer, Thread watcher, Room mention, or signal Trigger.",
      triggerProperties,
      ["threadId", "kind", "label", "prompt"],
    ),
    tool(
      "zenx_triggers_update",
      "Replace an existing Trigger definition while preserving its identity and active state.",
      { id: { type: "string" }, ...triggerProperties },
      ["id", "threadId", "kind", "label", "prompt"],
    ),
    tool(
      "zenx_triggers_cancel",
      "Deactivate a Trigger without deleting its definition or history.",
      { triggerId: { type: "string" } },
      ["triggerId"],
    ),
    tool(
      "zenx_triggers_delete",
      "Delete a Trigger definition; existing audit history remains available.",
      { triggerId: { type: "string" } },
      ["triggerId"],
    ),
    tool(
      "zenx_rooms_list",
      "List Rooms, members, and bounded recent messages.",
      {},
      [],
      false,
    ),
    tool(
      "zenx_rooms_create",
      "Create a Room with one or more named Thread members.",
      { name: { type: "string" }, members: membersSchema() },
      ["name", "members"],
    ),
    tool(
      "zenx_rooms_rename",
      "Rename an existing Room.",
      { roomId: { type: "string" }, name: { type: "string" } },
      ["roomId", "name"],
    ),
    tool(
      "zenx_rooms_delete",
      "Delete a Room after its active mention Triggers have been removed.",
      { roomId: { type: "string" } },
      ["roomId"],
    ),
    tool(
      "zenx_rooms_add_member",
      "Add a named Thread member to a Room.",
      {
        roomId: { type: "string" },
        name: { type: "string" },
        threadId: { type: "string" },
      },
      ["roomId", "name", "threadId"],
    ),
    tool(
      "zenx_rooms_remove_member",
      "Remove a Thread member from a Room.",
      { roomId: { type: "string" }, threadId: { type: "string" } },
      ["roomId", "threadId"],
    ),
    tool(
      "zenx_rooms_post_message",
      "Post an Agent-attributed message to a Room; explicit mentions may fire registered mention Triggers.",
      {
        roomId: { type: "string" },
        text: { type: "string" },
      },
      ["roomId", "text"],
    ),
  ],
  resources: [],
};

export class ZenXAutomationControlCapabilityPackage implements ZenXCapabilityPackage {
  readonly manifest = manifest;
  readonly #port: ZenXAutomationControlPort;

  constructor(port: ZenXAutomationControlPort) {
    this.#port = port;
  }

  async invoke(name: string, invocation: ToolInvocation): Promise<unknown> {
    if (name !== invocation.name)
      throw new Error("Automation tool name mismatch");
    invocation.signal.throwIfAborted();
    const args = invocation.arguments;
    switch (name) {
      case "zenx_triggers_list": {
        const snapshot = this.#port.snapshot();
        return {
          triggers: snapshot.triggers,
          history: snapshot.history.slice(-50),
        };
      }
      case "zenx_triggers_create":
        return await this.#port.create(triggerInput(args));
      case "zenx_triggers_update":
        return await this.#port.update({
          id: string(args, "id"),
          ...triggerInput(args),
        });
      case "zenx_triggers_cancel":
        await this.#port.cancel(string(args, "triggerId"));
        return { cancelled: true };
      case "zenx_triggers_delete":
        await this.#port.delete(string(args, "triggerId"));
        return { deleted: true };
      case "zenx_rooms_list":
        return {
          rooms: this.#port.snapshot().rooms.map((room) => ({
            ...room,
            messages: room.messages.slice(-50),
          })),
        };
      case "zenx_rooms_create":
        return await this.#port.createRoom({
          name: string(args, "name"),
          members: members(args.members),
        });
      case "zenx_rooms_rename":
        await this.#port.renameRoom(
          string(args, "roomId"),
          string(args, "name"),
        );
        return { renamed: true };
      case "zenx_rooms_delete":
        await this.#port.deleteRoom(string(args, "roomId"));
        return { deleted: true };
      case "zenx_rooms_add_member":
        await this.#port.addRoomMember(string(args, "roomId"), {
          name: string(args, "name"),
          threadId: string(args, "threadId"),
        });
        return { added: true };
      case "zenx_rooms_remove_member":
        await this.#port.removeRoomMember(
          string(args, "roomId"),
          string(args, "threadId"),
        );
        return { removed: true };
      case "zenx_rooms_post_message":
        await this.#port.postAgentRoomMessage(
          string(args, "roomId"),
          string(args, "text"),
        );
        return { posted: true };
      default:
        throw new Error(`Unsupported ZenX automation tool: ${name}`);
    }
  }
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
  write = true,
) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    permissions: write
      ? [ZENX_AUTOMATION_WRITE_PERMISSION]
      : [ZENX_AUTOMATION_READ_PERMISSION],
    interactionMode: "background_safe" as const,
    capabilities: [
      name.startsWith("zenx_rooms")
        ? "zenx.rooms.manage"
        : "zenx.triggers.manage",
    ],
    maxOutputBytes: 64 * 1024,
  };
}

function triggerInput(args: Record<string, unknown>): CreateTriggerInput {
  const common = {
    threadId: string(args, "threadId"),
    label: string(args, "label"),
    prompt: string(args, "prompt"),
  };
  const kind = string(args, "kind");
  if (kind === "timer")
    return {
      ...common,
      kind,
      runAt: number(args, "runAt"),
      ...(args.intervalMinutes === undefined
        ? {}
        : { intervalMinutes: number(args, "intervalMinutes") }),
    };
  if (kind === "thread")
    return {
      ...common,
      kind,
      watchedThreadId: string(args, "watchedThreadId"),
    };
  if (kind === "roomMention")
    return {
      ...common,
      kind,
      roomId: string(args, "roomId"),
      mention: string(args, "mention"),
    };
  if (kind === "signal")
    return { ...common, kind, signalName: string(args, "signalName") };
  throw new Error("kind must be timer, thread, roomMention, or signal");
}

function string(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${key} must be a non-empty string`);
  return value;
}
function number(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${key} must be a finite number`);
  return value;
}
function members(value: unknown): RoomMember[] {
  if (!Array.isArray(value)) throw new Error("members must be an array");
  return value.map((member) => {
    if (typeof member !== "object" || member === null)
      throw new Error("member must be an object");
    return {
      name: string(member as Record<string, unknown>, "name"),
      threadId: string(member as Record<string, unknown>, "threadId"),
    };
  });
}
function membersSchema() {
  return {
    type: "array",
    items: {
      type: "object",
      properties: { name: { type: "string" }, threadId: { type: "string" } },
      required: ["name", "threadId"],
      additionalProperties: false,
    },
  };
}
