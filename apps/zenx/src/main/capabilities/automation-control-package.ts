import type { ToolInvocation } from "../../../../../src/tool.js";
import type {
  CreateRoomInput,
  CreateTriggerInput,
  RoomMember,
  TriggerProgramConfig,
  TriggerProgramSpec,
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

const programSpecSchema = {
  type: "object",
  properties: {
    command: { type: "string" },
    args: { type: "array", items: { type: "string" }, maxItems: 64 },
    cwd: { type: "string" },
    env: { type: "object", additionalProperties: { type: "string" } },
    timeoutMs: { type: "number", minimum: 1, maximum: 120000 },
    maxOutputBytes: { type: "integer", minimum: 256, maximum: 1048576 },
  },
  required: ["command"],
  additionalProperties: false,
};

const programSchema = {
  type: "object",
  properties: {
    predicate: programSpecSchema,
    action: programSpecSchema,
    match: {
      type: "object",
      properties: {
        field: { type: "string", enum: ["completedItemText"] },
        regex: { type: "string" },
        flags: { type: "string" },
      },
      required: ["field", "regex"],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

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
  program: programSchema,
};

const manifest: ZenXCapabilityManifest = {
  schemaVersion: 1,
  id: ZENX_AUTOMATION_CONTROL_CAPABILITY_ID,
  displayName: "ZenX Triggers and Rooms",
  version: "1.0.0",
  description:
    "Inspect and manage Trigger wakeups and collaborative Rooms through the existing ZenX service.",
  provider: {
    id: "zenx-automation-service",
    platforms: ["*"],
    interactionModes: ["background_safe"],
    capabilities: ["zenx.triggers.manage", "zenx.rooms.manage"],
  },
  permissions: [
    {
      id: ZENX_AUTOMATION_READ_PERMISSION,
      title: "Read Triggers and Rooms",
      description:
        "List Trigger definitions, bounded wakeup history, Rooms, and messages.",
      scope: "workspace",
    },
    {
      id: ZENX_AUTOMATION_WRITE_PERMISSION,
      title: "Manage Triggers and Rooms",
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
      "Create a timer, Thread watcher, Room mention, or signal Trigger, optionally with a local predicate/action.",
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
      "Delete a Trigger definition while preserving audit history.",
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
      "Create a Room with named Thread members.",
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
      "Delete a Room when no nonterminal wakeup owns its reply route.",
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
      "Post an Agent-attributed Room message; explicit mentions may wake registered members.",
      { roomId: { type: "string" }, text: { type: "string" } },
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
          history: snapshot.history.slice(0, 50),
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
    ...programInput(args),
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

function programInput(args: Record<string, unknown>): {
  program?: TriggerProgramConfig;
} {
  if (args.program === undefined) return {};
  if (
    typeof args.program !== "object" ||
    args.program === null ||
    Array.isArray(args.program)
  )
    throw new Error("program must be an object");
  const value = args.program as Record<string, unknown>;
  const program: TriggerProgramConfig = {};
  if (value.predicate !== undefined)
    program.predicate = programSpec(value.predicate, "predicate");
  if (value.action !== undefined)
    program.action = programSpec(value.action, "action");
  if (value.match !== undefined) {
    if (
      typeof value.match !== "object" ||
      value.match === null ||
      Array.isArray(value.match)
    )
      throw new Error("match must be an object");
    const match = value.match as Record<string, unknown>;
    const field = string(match, "field");
    if (field !== "completedItemText")
      throw new Error("match field must be completedItemText");
    program.match = {
      field,
      regex: string(match, "regex"),
      ...(match.flags === undefined ? {} : { flags: string(match, "flags") }),
    };
  }
  return { program };
}

function programSpec(value: unknown, label: string): TriggerProgramSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const spec = value as Record<string, unknown>;
  const args =
    spec.args === undefined
      ? undefined
      : arrayOfStrings(spec.args, `${label}.args`);
  const env =
    spec.env === undefined ? undefined : environment(spec.env, `${label}.env`);
  return {
    command: string(spec, "command"),
    ...(args === undefined ? {} : { args }),
    ...(spec.cwd === undefined ? {} : { cwd: string(spec, "cwd") }),
    ...(env === undefined ? {} : { env }),
    ...(spec.timeoutMs === undefined
      ? {}
      : { timeoutMs: number(spec, "timeoutMs") }),
    ...(spec.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: integer(spec, "maxOutputBytes") }),
  };
}

function members(value: unknown): RoomMember[] {
  if (!Array.isArray(value)) throw new Error("members must be an array");
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new Error("member must be an object");
    const member = entry as Record<string, unknown>;
    return {
      name: string(member, "name"),
      threadId: string(member, "threadId"),
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

function environment(value: unknown, label: string): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string")
      throw new Error(`${label}.${key} must be a string`);
    result[key] = entry;
  }
  return result;
}

function arrayOfStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new Error(`${label} must be an array of strings`);
  return value;
}

function string(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

function number(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${key} must be a finite number`);
  return value;
}

function integer(args: Record<string, unknown>, key: string): number {
  const value = number(args, key);
  if (!Number.isSafeInteger(value))
    throw new Error(`${key} must be an integer`);
  return value;
}
