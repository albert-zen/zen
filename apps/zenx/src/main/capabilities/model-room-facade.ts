import type { ModelTool } from "../../../../../src/model.js";
import type { ModelReferenceScope } from "../../../../../src/model-references.js";
import {
  MODEL_REF,
  object,
  record,
  asJson,
  pick,
  renameField,
} from "./model-facade-fields.js";
const names = new Set([
  "zenx_rooms_list",
  "zenx_rooms_messages",
  "zenx_rooms_create",
  "zenx_rooms_rename",
  "zenx_rooms_delete",
  "zenx_rooms_add_member",
  "zenx_rooms_remove_member",
  "zenx_rooms_post_message",
  "zenx_rooms_react",
  "zenx_rooms_workspace",
  "zenx_rooms_update_workspace",
]);
export const isRoomModelTool = (name: string) => names.has(name);
export function roomModelDefinition<T extends ModelTool>(source: T): T {
  const tool = structuredClone(source),
    schema = tool.inputSchema,
    fields = object(schema.properties ?? {});
  for (const [from, to] of [
    ["roomId", "room"],
    ["threadId", "thread"],
    ["messageId", "message"],
    ["replyToMessageId", "replyTo"],
  ])
    renameField(schema, from!, to!);
  const member = record(record(fields.members)?.items);
  if (member) renameField(member, "threadId", "thread");
  delete fields.readCursors;
  delete fields.operationId;
  if (tool.name === "zenx_rooms_update_workspace") {
    delete fields.room;
    delete fields.expectedRevision;
    fields.snapshot = structuredClone(MODEL_REF);
    schema.required = ["snapshot", "matters", "memory"];
    const matter = record(record(fields.matters)?.items),
      references = record(
        record(record(matter?.properties)?.references)?.items,
      );
    if (Array.isArray(references?.anyOf))
      for (const value of references.anyOf) {
        const branch = object(value),
          properties = object(branch.properties);
        renameField(branch, "threadId", "thread");
        renameField(branch, "triggerId", "trigger");
        if (properties.device) {
          delete properties.device;
          if (Array.isArray(branch.required))
            branch.required = branch.required.filter(
              (field) => field !== "device",
            );
        }
      }
  }
  tool.description =
    tool.name === "zenx_rooms_update_workspace"
      ? "Replace Room planning annotations against the exact immutable workspace snapshot. Conflicts require a fresh read and deliberate merge, never automatic retry. Does not execute Threads or Triggers."
      : "Use scoped Room, Thread and message refs from reads. Literal message/planning text is preserved. Refs do not grant authority, delivery or completion; native Room membership and exact identity checks still apply.";
  return tool;
}
export function decodeRoomArguments(
  name: string,
  input: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  const args = structuredClone(input);
  for (const key of [
    "roomId",
    "threadId",
    "messageId",
    "replyToMessageId",
    "expectedRevision",
    "readCursors",
    "operationId",
  ])
    if (key in args) throw Error("Use exact scoped Room references");
  if (args.room !== undefined) {
    args.roomId = object(refs.resolve(args.room, "rooms", "room")).id;
    delete args.room;
  }
  if (args.thread !== undefined) {
    const bound = object(refs.resolve(args.thread, "threads", "thread"));
    if (bound.device !== "local")
      throw Error("Room members require local Threads");
    args.threadId = bound.id;
    delete args.thread;
  }
  if (Array.isArray(args.members))
    args.members = args.members.map((value) => {
      const member = object(value);
      if (member.threadId !== undefined) throw Error("Use member Thread ref");
      const bound = object(refs.resolve(member.thread, "threads", "thread"));
      if (bound.device !== "local")
        throw Error("Room members require local Threads");
      return { name: member.name, threadId: bound.id };
    });
  for (const [field, native] of [
    ["message", "messageId"],
    ["replyTo", "replyToMessageId"],
  ] as const) {
    if (args[field] === undefined) continue;
    const bound = object(refs.resolve(args[field], "rooms", "message"));
    if (bound.roomId !== args.roomId)
      throw Error("Message ref belongs to another Room");
    delete args[field];
    args[native] = bound.id;
  }
  if (name === "zenx_rooms_update_workspace") {
    const snapshot = object(
      refs.resolve(args.snapshot, "rooms", "workspace", epoch),
    );
    delete args.snapshot;
    if (args.roomId !== undefined)
      throw Error("Snapshot already binds its exact Room");
    args.roomId = snapshot.roomId;
    args.expectedRevision = snapshot.revision;
    if (Array.isArray(args.matters))
      args.matters = args.matters.map((value) => {
        const matter = object(value);
        return {
          ...matter,
          ...(Array.isArray(matter.references)
            ? {
                references: matter.references.map((value) => {
                  const reference = object(value);
                  if (
                    reference.threadId !== undefined ||
                    reference.triggerId !== undefined ||
                    reference.device !== undefined
                  )
                    throw Error("Use typed planning reference");
                  if (reference.kind === "trigger") {
                    const { trigger, ...rest } = reference;
                    return {
                      ...rest,
                      triggerId: object(
                        refs.resolve(trigger, "triggers", "trigger"),
                      ).id,
                    };
                  }
                  if (reference.kind === "thread") {
                    const { thread, ...rest } = reference,
                      bound = object(refs.resolve(thread, "threads", "thread"));
                    return {
                      ...rest,
                      threadId: bound.id,
                      device: bound.device,
                    };
                  }
                  return reference;
                }),
              }
            : {}),
        };
      });
  }
  return args;
}
export function projectRoomResult(
  name: string,
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  const room = (id: string) => refs.bind("rooms", "room", { id });
  const thread = (id: string, device = "local") =>
    refs.bind("threads", "thread", { id, device });
  const trigger = (id: string) => refs.bind("triggers", "trigger", { id });
  const message = (value: unknown, roomId: unknown): unknown => {
    const entry = record(value);
    if (!entry) return value;
    const owner = typeof entry.roomId === "string" ? entry.roomId : roomId;
    const { messageId, ...reply } = record(entry.replyTo) ?? {};
    return {
      ...(typeof entry.id === "string"
        ? {
            ref: refs.bind(
              "rooms",
              "message",
              asJson({ id: entry.id, roomId: owner }),
            ),
          }
        : {}),
      ...pick(entry, ["author", "text", "createdAt", "kind"]),
      ...(typeof messageId === "string"
        ? {
            replyTo: {
              ...reply,
              ref: refs.bind(
                "rooms",
                "message",
                asJson({ id: messageId, roomId: owner }),
              ),
            },
          }
        : {}),
      ...(Array.isArray(entry.reactions)
        ? {
            reactions: entry.reactions.map((value) =>
              pick(object(value), ["label", "emoji"]),
            ),
          }
        : {}),
    };
  };
  const projectRoom = (value: unknown): unknown => {
    const entry = object(value),
      assistant = record(entry.assistant);
    return {
      ...(typeof entry.id === "string" ? { ref: room(entry.id) } : {}),
      ...pick(entry, ["name", "createdAt", "messageCount", "unreadCount"]),
      ...(Array.isArray(entry.members)
        ? {
            members: entry.members.map((value) => {
              const member = object(value);
              return {
                name: member.name,
                thread: thread(String(member.threadId)),
              };
            }),
          }
        : {}),
      ...(Array.isArray(entry.messages)
        ? { messages: entry.messages.map((value) => message(value, entry.id)) }
        : {}),
      ...(assistant
        ? {
            assistant: {
              ...pick(assistant, ["deliveryMode"]),
              ...(typeof assistant.threadId === "string"
                ? { thread: thread(assistant.threadId) }
                : {}),
              ...(typeof assistant.triggerId === "string"
                ? { trigger: trigger(assistant.triggerId) }
                : {}),
              ...(typeof assistant.heartbeatTriggerId === "string"
                ? { heartbeat: trigger(assistant.heartbeatTriggerId) }
                : {}),
            },
          }
        : {}),
      ...(record(entry.lastMessage)
        ? { lastMessage: message(entry.lastMessage, entry.id) }
        : {}),
      ...(record(entry.lastAgentMessage)
        ? { lastAgentMessage: message(entry.lastAgentMessage, entry.id) }
        : {}),
    };
  };
  if (
    name === "zenx_rooms_workspace" ||
    name === "zenx_rooms_update_workspace"
  ) {
    const { revision, ...output } = result;
    if (typeof revision === "number")
      output.snapshot = refs.bind(
        "rooms",
        "workspace",
        asJson({ roomId: args.roomId, revision }),
        epoch,
      );
    if (Array.isArray(result.matters))
      output.matters = result.matters.map((value) => {
        const matter = object(value);
        return {
          ...matter,
          ...(Array.isArray(matter.references)
            ? {
                references: matter.references.map((value) => {
                  const reference = object(value);
                  if (reference.kind === "thread") {
                    const { threadId, device, ...rest } = reference;
                    return {
                      ...rest,
                      thread: thread(String(threadId), String(device)),
                    };
                  }
                  if (reference.kind === "trigger") {
                    const { triggerId, ...rest } = reference;
                    return { ...rest, trigger: trigger(String(triggerId)) };
                  }
                  return reference;
                }),
              }
            : {}),
        };
      });
    return output;
  }
  const { roomId, id, readCursorVersion: _version, ...output } = result;
  if (typeof roomId === "string") output.room = room(roomId);
  if (typeof id === "string")
    return projectRoom(result) as Record<string, unknown>;
  if (Array.isArray(result.rooms)) output.rooms = result.rooms.map(projectRoom);
  if (Array.isArray(result.messages))
    output.messages = result.messages.map((value) =>
      message(value, roomId ?? args.roomId),
    );
  if (record(result.message))
    output.message = message(result.message, roomId ?? args.roomId);
  return output;
}
