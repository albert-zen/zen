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
import {
  MAX_ID_BYTES,
  MAX_MEMBER_NAME_BYTES,
  MAX_MESSAGE_TEXT_BYTES,
  MAX_PROGRAM_ARGUMENT_BYTES,
  MAX_PROGRAM_ARGUMENTS,
  MAX_PROGRAM_COMMAND_BYTES,
  MAX_PROGRAM_CWD_BYTES,
  MAX_PROGRAM_ENV_BYTES,
  MAX_PROGRAM_ENV_ENTRIES,
  MAX_PROGRAM_ENV_KEY_BYTES,
  MAX_PROGRAM_ENV_VALUE_BYTES,
  MAX_PROGRAM_FLAGS_BYTES,
  MAX_PROGRAM_MATCH_REGEX_BYTES,
  MAX_PROGRAM_TIMEOUT_MS,
  MAX_ROOM_MEMBERS,
  MAX_ROOM_NAME_BYTES,
  MAX_TRIGGER_LABEL_BYTES,
  MAX_TRIGGER_PROMPT_BYTES,
  utf8Bytes,
  withinBytes,
} from "../trigger-limits.js";
import type {
  ZenXCapabilityManifest,
  ZenXCapabilityPackage,
  ZenXPluginPageContribution,
  ZenXPluginSidebarContribution,
  ZenXPluginManifestV2,
} from "./types.js";

export const ZENX_AUTOMATION_CONTROL_CAPABILITY_ID = "zenx-automation-control";
export const ZENX_TRIGGERS_CAPABILITY_ID = "zenx-triggers";
export const ZENX_ROOMS_CAPABILITY_ID = "zenx-rooms";
export const ZENX_TRIGGERS_READ_PERMISSION = "zenx-triggers.read";
export const ZENX_TRIGGERS_WRITE_PERMISSION = "zenx-triggers.write";
export const ZENX_ROOMS_READ_PERMISSION = "zenx-rooms.read";
export const ZENX_ROOMS_WRITE_PERMISSION = "zenx-rooms.write";
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
    command: { type: "string", maxLength: MAX_PROGRAM_COMMAND_BYTES },
    args: {
      type: "array",
      items: { type: "string", maxLength: MAX_PROGRAM_ARGUMENT_BYTES },
      maxItems: MAX_PROGRAM_ARGUMENTS,
    },
    cwd: { type: "string", maxLength: MAX_PROGRAM_CWD_BYTES },
    env: {
      type: "object",
      maxProperties: MAX_PROGRAM_ENV_ENTRIES,
      additionalProperties: { type: "string" },
    },
    timeoutMs: { type: "number", minimum: 1, maximum: MAX_PROGRAM_TIMEOUT_MS },
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
        regex: { type: "string", maxLength: MAX_PROGRAM_MATCH_REGEX_BYTES },
        flags: { type: "string", maxLength: MAX_PROGRAM_FLAGS_BYTES },
      },
      required: ["field", "regex"],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const triggerProperties = {
  threadId: { type: "string", maxLength: MAX_ID_BYTES },
  kind: { type: "string", enum: ["timer", "thread", "roomMention", "signal"] },
  label: { type: "string", maxLength: MAX_TRIGGER_LABEL_BYTES },
  prompt: { type: "string", maxLength: MAX_TRIGGER_PROMPT_BYTES },
  runAt: { type: "number" },
  intervalMinutes: { type: "number" },
  watchedThreadId: { type: "string", maxLength: MAX_ID_BYTES },
  roomId: { type: "string", maxLength: MAX_ID_BYTES },
  mention: { type: "string", maxLength: MAX_MEMBER_NAME_BYTES },
  signalName: { type: "string", maxLength: MAX_ID_BYTES },
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
      { id: { type: "string", maxLength: MAX_ID_BYTES }, ...triggerProperties },
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
      {
        name: { type: "string", maxLength: MAX_ROOM_NAME_BYTES },
        members: membersSchema(),
      },
      ["name", "members"],
    ),
    tool(
      "zenx_rooms_rename",
      "Rename an existing Room.",
      {
        roomId: { type: "string", maxLength: MAX_ID_BYTES },
        name: { type: "string", maxLength: MAX_ROOM_NAME_BYTES },
      },
      ["roomId", "name"],
    ),
    tool(
      "zenx_rooms_delete",
      "Delete a Room when no nonterminal wakeup owns its reply route.",
      { roomId: { type: "string", maxLength: MAX_ID_BYTES } },
      ["roomId"],
    ),
    tool(
      "zenx_rooms_add_member",
      "Add a named Thread member to a Room.",
      {
        roomId: { type: "string", maxLength: MAX_ID_BYTES },
        name: { type: "string", maxLength: MAX_MEMBER_NAME_BYTES },
        threadId: { type: "string", maxLength: MAX_ID_BYTES },
      },
      ["roomId", "name", "threadId"],
    ),
    tool(
      "zenx_rooms_remove_member",
      "Remove a Thread member from a Room.",
      {
        roomId: { type: "string", maxLength: MAX_ID_BYTES },
        threadId: { type: "string", maxLength: MAX_ID_BYTES },
      },
      ["roomId", "threadId"],
    ),
    tool(
      "zenx_rooms_post_message",
      "Post an Agent-attributed Room message; explicit mentions may wake registered members.",
      {
        roomId: { type: "string", maxLength: MAX_ID_BYTES },
        text: { type: "string", maxLength: MAX_MESSAGE_TEXT_BYTES },
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
          triggers: snapshot.triggers.map(readSafeTrigger),
          history: snapshot.history.slice(0, 50).map(readSafeHistory),
        };
      }
      case "zenx_triggers_create":
        return await this.#port.create(triggerInput(args));
      case "zenx_triggers_update":
        return await this.#port.update({
          id: string(args, "id", MAX_ID_BYTES),
          ...triggerInput(args),
        });
      case "zenx_triggers_cancel":
        await this.#port.cancel(string(args, "triggerId", MAX_ID_BYTES));
        return { cancelled: true };
      case "zenx_triggers_delete":
        await this.#port.delete(string(args, "triggerId", MAX_ID_BYTES));
        return { deleted: true };
      case "zenx_rooms_list":
        return {
          rooms: this.#port.snapshot().rooms.map(readSafeRoom),
        };
      case "zenx_rooms_create":
        return await this.#port.createRoom({
          name: string(args, "name", MAX_ROOM_NAME_BYTES),
          members: members(args.members),
        });
      case "zenx_rooms_rename":
        await this.#port.renameRoom(
          string(args, "roomId", MAX_ID_BYTES),
          string(args, "name", MAX_ROOM_NAME_BYTES),
        );
        return { renamed: true };
      case "zenx_rooms_delete":
        await this.#port.deleteRoom(string(args, "roomId", MAX_ID_BYTES));
        return { deleted: true };
      case "zenx_rooms_add_member":
        await this.#port.addRoomMember(string(args, "roomId", MAX_ID_BYTES), {
          name: string(args, "name", MAX_MEMBER_NAME_BYTES),
          threadId: string(args, "threadId", MAX_ID_BYTES),
        });
        return { added: true };
      case "zenx_rooms_remove_member":
        await this.#port.removeRoomMember(
          string(args, "roomId", MAX_ID_BYTES),
          string(args, "threadId", MAX_ID_BYTES),
        );
        return { removed: true };
      case "zenx_rooms_post_message":
        await this.#port.postAgentRoomMessage(
          string(args, "roomId", MAX_ID_BYTES),
          string(args, "text", MAX_MESSAGE_TEXT_BYTES),
        );
        return { posted: true };
      default:
        throw new Error(`Unsupported ZenX automation tool: ${name}`);
    }
  }
}

export class ZenXTriggersCapabilityPackage implements ZenXCapabilityPackage {
  readonly #delegate: ZenXAutomationControlCapabilityPackage;
  readonly manifest: ZenXCapabilityManifest;

  constructor(port: ZenXAutomationControlPort) {
    this.#delegate = new ZenXAutomationControlCapabilityPackage(port);
    this.manifest = automationPluginManifest(this.#delegate.manifest, {
      id: ZENX_TRIGGERS_CAPABILITY_ID,
      displayName: "Triggers",
      description: "Schedule and inspect ZenX Trigger wakeups.",
      toolPrefix: "zenx_triggers_",
      providerCapability: "zenx.triggers.manage",
      readPermission: ZENX_TRIGGERS_READ_PERMISSION,
      writePermission: ZENX_TRIGGERS_WRITE_PERMISSION,
      page: {
        id: "triggers",
        title: "Triggers",
        route: "/plugins/zenx-triggers/triggers",
      },
      sidebar: {
        id: "triggers",
        label: "Triggers",
        icon: "clock",
        pageId: "triggers",
        order: 10,
      },
    });
  }

  async invoke(name: string, invocation: ToolInvocation): Promise<unknown> {
    if (!name.startsWith("zenx_triggers_")) {
      throw new Error(`Unsupported Triggers tool: ${name}`);
    }
    return await this.#delegate.invoke(name, invocation);
  }
}

export class ZenXRoomsCapabilityPackage implements ZenXCapabilityPackage {
  readonly #delegate: ZenXAutomationControlCapabilityPackage;
  readonly manifest: ZenXCapabilityManifest;

  constructor(port: ZenXAutomationControlPort) {
    this.#delegate = new ZenXAutomationControlCapabilityPackage(port);
    this.manifest = automationPluginManifest(this.#delegate.manifest, {
      id: ZENX_ROOMS_CAPABILITY_ID,
      displayName: "Rooms",
      description: "Manage shared ZenX Room collaboration.",
      toolPrefix: "zenx_rooms_",
      providerCapability: "zenx.rooms.manage",
      readPermission: ZENX_ROOMS_READ_PERMISSION,
      writePermission: ZENX_ROOMS_WRITE_PERMISSION,
      page: {
        id: "rooms",
        title: "Rooms",
        route: "/plugins/zenx-rooms/rooms",
      },
      sidebar: {
        id: "rooms",
        label: "Rooms",
        icon: "users",
        pageId: "rooms",
        order: 20,
      },
    });
  }

  async invoke(name: string, invocation: ToolInvocation): Promise<unknown> {
    if (!name.startsWith("zenx_rooms_")) {
      throw new Error(`Unsupported Rooms tool: ${name}`);
    }
    return await this.#delegate.invoke(name, invocation);
  }
}

export function zenXBundledAutomationPackages(
  port: ZenXAutomationControlPort,
): readonly ZenXCapabilityPackage[] {
  return [
    new ZenXTriggersCapabilityPackage(port),
    new ZenXRoomsCapabilityPackage(port),
  ];
}

function automationPluginManifest(
  source: ZenXCapabilityManifest,
  plugin: {
    id: string;
    displayName: string;
    description: string;
    toolPrefix: string;
    providerCapability: string;
    readPermission: string;
    writePermission: string;
    page: ZenXPluginPageContribution;
    sidebar: ZenXPluginSidebarContribution;
  },
): ZenXPluginManifestV2 {
  const {
    schemaVersion: _schemaVersion,
    displayName: _displayName,
    ui: _legacyUi,
    ...capability
  } = source.schemaVersion === 1
    ? source
    : { ...source, displayName: source.name };
  return {
    ...structuredClone(capability),
    schemaVersion: 2,
    id: plugin.id,
    name: plugin.displayName,
    compatibility: { zenx: ">=0.1.0 <0.2.0" },
    runtime: {
      type: "bundled",
      entry: `zenx/automation/${plugin.id}`,
    },
    mainDocument:
      plugin.displayName === "Triggers"
        ? "Use Triggers to schedule and inspect auditable ZenX wakeups."
        : "Use Rooms to manage shared collaboration and explicit member routing.",
    description: plugin.description,
    provider: {
      ...structuredClone(source.provider),
      capabilities: [plugin.providerCapability],
    },
    permissions: source.permissions.map((permission) => ({
      ...structuredClone(permission),
      id:
        permission.id === ZENX_AUTOMATION_READ_PERMISSION
          ? plugin.readPermission
          : plugin.writePermission,
      title: permission.title.replace("Triggers and Rooms", plugin.displayName),
      description: permission.description.replace(
        "Trigger definitions, bounded wakeup history, Rooms, and messages",
        plugin.displayName === "Triggers"
          ? "Trigger definitions and bounded wakeup history"
          : "Rooms and bounded recent messages",
      ),
    })),
    tools: source.tools
      .filter((tool) => tool.name.startsWith(plugin.toolPrefix))
      .map((tool) => ({
        ...structuredClone(tool),
        permissions: tool.permissions.map((permission) =>
          permission === ZENX_AUTOMATION_READ_PERMISSION
            ? plugin.readPermission
            : plugin.writePermission,
        ),
      })),
    contributions: {
      pages: [plugin.page],
      sidebar: [plugin.sidebar],
    },
  };
}

function readSafeTrigger(trigger: ZenXTrigger): unknown {
  const common = {
    id: trigger.id,
    threadId: trigger.threadId,
    label: trigger.label,
    prompt: trigger.prompt,
    createdAt: trigger.createdAt,
    active: trigger.active,
    ...(trigger.program === undefined
      ? {}
      : { program: readSafeProgram(trigger.program) }),
  };
  if (trigger.kind === "timer")
    return {
      ...common,
      kind: "timer",
      timer: {
        nextRunAt: trigger.timer?.nextRunAt,
        intervalMinutes: trigger.timer?.intervalMinutes,
      },
    };
  if (trigger.kind === "thread")
    return {
      ...common,
      kind: "thread",
      watch: {
        threadId: trigger.watch?.threadId,
        event: trigger.watch?.event,
      },
    };
  if (trigger.kind === "roomMention")
    return {
      ...common,
      kind: "roomMention",
      room: {
        roomId: trigger.room?.roomId,
        mention: trigger.room?.mention,
      },
    };
  return {
    ...common,
    kind: "signal",
    signal: { name: trigger.signal?.name },
  };
}

function readSafeProgram(program: TriggerProgramConfig): TriggerProgramConfig {
  return {
    ...(program.predicate === undefined
      ? {}
      : { predicate: readSafeProgramSpec(program.predicate) }),
    ...(program.action === undefined
      ? {}
      : { action: readSafeProgramSpec(program.action) }),
    ...(program.match === undefined
      ? {}
      : {
          match: {
            field: program.match.field,
            regex: program.match.regex,
            ...(program.match.flags === undefined
              ? {}
              : { flags: program.match.flags }),
          },
        }),
  };
}

function readSafeProgramSpec(spec: TriggerProgramSpec): TriggerProgramSpec {
  return {
    command: spec.command,
    ...(spec.args === undefined ? {} : { args: [...spec.args] }),
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    ...(spec.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: spec.maxOutputBytes }),
  };
}

function readSafeHistory(entry: TriggerSnapshot["history"][number]): unknown {
  return {
    id: entry.id,
    triggerId: entry.triggerId,
    threadId: entry.threadId,
    kind: entry.kind,
    reason: entry.reason,
    prompt: entry.prompt,
    clientUserMessageId: entry.clientUserMessageId,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    status: entry.status,
    turnId: entry.turnId,
    sourceThreadId: entry.sourceThreadId,
    sourceTurnId: entry.sourceTurnId,
    sourceRoomId: entry.sourceRoomId,
    sourceRoomMessageId: entry.sourceRoomMessageId,
    replyRoomId: entry.replyRoomId,
    replyAuthor: entry.replyAuthor,
    error: entry.programOutcome === null ? entry.error : null,
    programInvocationId: entry.programInvocationId,
    programOutcome:
      entry.programOutcome === null
        ? null
        : readSafeOutcome(entry.programOutcome),
    programOutcomes: entry.programOutcomes.map(readSafeOutcome),
  };
}

function readSafeRoom(room: ZenXRoom): unknown {
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

function readSafeOutcome(
  outcome: NonNullable<TriggerSnapshot["history"][number]["programOutcome"]>,
) {
  return {
    stage: outcome.stage,
    invocationId: outcome.invocationId,
    status: outcome.status,
    output: null,
    exitCode: outcome.exitCode,
    error: null,
  };
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
    threadId: string(args, "threadId", MAX_ID_BYTES),
    label: string(args, "label", MAX_TRIGGER_LABEL_BYTES),
    prompt: string(args, "prompt", MAX_TRIGGER_PROMPT_BYTES),
    ...programInput(args),
  };
  const kind = string(args, "kind", MAX_ID_BYTES);
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
      watchedThreadId: string(args, "watchedThreadId", MAX_ID_BYTES),
    };
  if (kind === "roomMention")
    return {
      ...common,
      kind,
      roomId: string(args, "roomId", MAX_ID_BYTES),
      mention: string(args, "mention", MAX_MEMBER_NAME_BYTES),
    };
  if (kind === "signal")
    return {
      ...common,
      kind,
      signalName: string(args, "signalName", MAX_ID_BYTES),
    };
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
    const field = string(match, "field", MAX_ID_BYTES);
    if (field !== "completedItemText")
      throw new Error("match field must be completedItemText");
    program.match = {
      field,
      regex: string(match, "regex", MAX_PROGRAM_MATCH_REGEX_BYTES),
      ...(match.flags === undefined
        ? {}
        : { flags: string(match, "flags", MAX_PROGRAM_FLAGS_BYTES) }),
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
    command: string(spec, "command", MAX_PROGRAM_COMMAND_BYTES),
    ...(args === undefined ? {} : { args }),
    ...(spec.cwd === undefined
      ? {}
      : { cwd: string(spec, "cwd", MAX_PROGRAM_CWD_BYTES) }),
    ...(env === undefined ? {} : { env }),
    ...(spec.timeoutMs === undefined
      ? {}
      : {
          timeoutMs: boundedNumber(
            spec,
            "timeoutMs",
            1,
            MAX_PROGRAM_TIMEOUT_MS,
          ),
        }),
    ...(spec.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: integer(spec, "maxOutputBytes") }),
  };
}

function members(value: unknown): RoomMember[] {
  if (!Array.isArray(value)) throw new Error("members must be an array");
  if (value.length === 0 || value.length > MAX_ROOM_MEMBERS)
    throw new Error(
      `members must contain 1-${String(MAX_ROOM_MEMBERS)} entries`,
    );
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new Error("member must be an object");
    const member = entry as Record<string, unknown>;
    return {
      name: string(member, "name", MAX_MEMBER_NAME_BYTES),
      threadId: string(member, "threadId", MAX_ID_BYTES),
    };
  });
}

function membersSchema() {
  return {
    type: "array",
    minItems: 1,
    maxItems: MAX_ROOM_MEMBERS,
    items: {
      type: "object",
      properties: {
        name: { type: "string", maxLength: MAX_MEMBER_NAME_BYTES },
        threadId: { type: "string", maxLength: MAX_ID_BYTES },
      },
      required: ["name", "threadId"],
      additionalProperties: false,
    },
  };
}

function environment(value: unknown, label: string): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const result: Record<string, string> = {};
  if (Object.keys(value as object).length > MAX_PROGRAM_ENV_ENTRIES)
    throw new Error(`${label} has too many entries`);
  let bytes = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (
      !withinBytes(key, MAX_PROGRAM_ENV_KEY_BYTES) ||
      typeof entry !== "string" ||
      !withinBytes(entry, MAX_PROGRAM_ENV_VALUE_BYTES)
    )
      throw new Error(`${label}.${key} must be a string`);
    bytes += utf8Bytes(key) + utf8Bytes(entry);
    if (bytes > MAX_PROGRAM_ENV_BYTES)
      throw new Error(`${label} exceeds its byte bound`);
    result[key] = entry;
  }
  return result;
}

function arrayOfStrings(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_PROGRAM_ARGUMENTS ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        !withinBytes(entry, MAX_PROGRAM_ARGUMENT_BYTES),
    )
  )
    throw new Error(`${label} must be an array of strings`);
  return value;
}

function string(
  args: Record<string, unknown>,
  key: string,
  maximum = MAX_ID_BYTES,
): string {
  const value = args[key];
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    !withinBytes(value.trim(), maximum)
  )
    throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

function number(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${key} must be a finite number`);
  return value;
}

function boundedNumber(
  args: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = number(args, key);
  if (value < minimum || value > maximum)
    throw new Error(
      `${key} must be between ${String(minimum)} and ${String(maximum)}`,
    );
  return value;
}

function integer(args: Record<string, unknown>, key: string): number {
  const value = number(args, key);
  if (!Number.isSafeInteger(value))
    throw new Error(`${key} must be an integer`);
  return value;
}
