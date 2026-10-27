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
import { projectThreadResult } from "./model-thread-facade.js";
import { projectRoomResult } from "./model-room-facade.js";
const names = new Set([
  "zenx_triggers_threads",
  "zenx_triggers_workspaces",
  "zenx_triggers_preview_target",
  "zenx_triggers_create_target",
  "zenx_triggers_result",
  "zenx_triggers_list",
  "zenx_triggers_sidebar_facts",
  "zenx_triggers_create",
  "zenx_triggers_update",
  "zenx_triggers_cancel",
  "zenx_triggers_resume",
  "zenx_triggers_delete",
  "zenx_triggers_signal",
]);
export const isTriggerModelTool = (name: string) => names.has(name);
export function triggerModelDefinition<T extends ModelTool>(source: T): T {
  const tool = structuredClone(source),
    schema = tool.inputSchema,
    fields = object(schema.properties ?? {});
  for (const [from, to] of [
    ["threadId", "thread"],
    ["watchedThreadId", "watchedThread"],
    ["roomId", "room"],
    ["triggerId", "trigger"],
    ["historyId", "history"],
  ])
    renameField(schema, from!, to!);
  if (tool.name === "zenx_triggers_update")
    renameField(schema, "id", "trigger");
  delete fields.sourceDevice;
  if (tool.name === "zenx_triggers_resume") {
    delete fields.trigger;
    delete fields.expectedRevision;
    fields.snapshot = structuredClone(MODEL_REF);
    schema.required = ["snapshot"];
  }
  if (tool.name === "zenx_triggers_create_target") {
    delete fields.workspace;
    delete fields.preview;
    fields.snapshot = structuredClone(MODEL_REF);
    schema.required = ["snapshot"];
  }
  tool.description +=
    " Use exact typed refs; watchedThread retains its source device. Resume/create-target use immutable snapshots, not visible revisions. Native permissions and configuration fences still run. Programs, prompts and signals remain literal. Notification dispatch is not completed work; retain failures/unknown outcomes and never retry uncertain mutations automatically.";
  return tool;
}
export function decodeTriggerArguments(
  name: string,
  input: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  const args = structuredClone(input);
  for (const key of [
    "id",
    "threadId",
    "watchedThreadId",
    "roomId",
    "triggerId",
    "historyId",
    "expectedRevision",
    "preview",
    "sourceDevice",
  ])
    if (key in args)
      throw Error("Use typed Trigger references, not internal identifiers");
  if (args.thread !== undefined) {
    const bound = object(refs.resolve(args.thread, "threads", "thread"));
    if (bound.device !== "local")
      throw Error("Trigger notification Thread must be local");
    delete args.thread;
    args.threadId = bound.id;
  }
  if (args.watchedThread !== undefined) {
    const bound = object(refs.resolve(args.watchedThread, "threads", "thread"));
    delete args.watchedThread;
    args.watchedThreadId = bound.id;
    if (bound.device !== "local") args.sourceDevice = bound.device;
  }
  for (const [field, native, namespace, kind] of [
    ["room", "roomId", "rooms", "room"],
    [
      "trigger",
      name === "zenx_triggers_update" ? "id" : "triggerId",
      "triggers",
      "trigger",
    ],
    ["history", "historyId", "triggers", "history"],
  ] as const) {
    if (args[field] !== undefined) {
      args[native] = object(refs.resolve(args[field], namespace, kind)).id;
      delete args[field];
    }
  }
  if (name === "zenx_triggers_resume") {
    const bound = object(
      refs.resolve(args.snapshot, "triggers", "definition", epoch),
    );
    delete args.snapshot;
    args.triggerId = bound.id;
    args.expectedRevision = bound.revision;
  }
  if (name === "zenx_triggers_create_target") {
    const bound = object(
      refs.resolve(args.snapshot, "triggers", "target-preview", epoch),
    );
    if (args.workspace !== undefined)
      throw Error("Snapshot already binds the exact target workspace");
    delete args.snapshot;
    args.workspace = bound.workspace;
    args.preview = bound.preview;
  }
  return args;
}
export function projectTriggerResult(
  name: string,
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  const thread = (id: string, device = "local") =>
    refs.bind("threads", "thread", { id, device });
  const trigger = (id: string) => refs.bind("triggers", "trigger", { id });
  const room = (id: string) => refs.bind("rooms", "room", { id });
  const turn = (id: string, threadId: unknown, device = "local") =>
    refs.bind("threads", "turn", asJson({ id, threadId, device }));
  const programOutcome = (value: unknown): unknown => {
    const entry = record(value);
    return entry
      ? pick(entry, ["stage", "status", "exitCode", "output", "error"])
      : value;
  };
  const definition = (value: unknown): unknown => {
    const entry = object(value),
      watch = record(entry.watch),
      memberRoom = record(entry.room);
    return {
      ...(typeof entry.id === "string"
        ? {
            ref: trigger(entry.id),
            snapshot: refs.bind(
              "triggers",
              "definition",
              asJson({ id: entry.id, revision: entry.definitionRevision ?? 0 }),
              epoch,
            ),
          }
        : {}),
      ...(typeof entry.threadId === "string"
        ? { thread: thread(entry.threadId) }
        : {}),
      ...pick(entry, [
        "kind",
        "label",
        "prompt",
        "createdAt",
        "active",
        "sourceError",
        "deliveryMode",
        "timer",
        "signal",
        "program",
      ]),
      ...(watch
        ? {
            watch: {
              ...pick(watch, ["event", "once", "sourceWorkspace"]),
              ...(typeof watch.threadId === "string"
                ? {
                    thread: thread(
                      watch.threadId,
                      typeof watch.sourceDevice === "string"
                        ? watch.sourceDevice
                        : "local",
                    ),
                  }
                : {}),
            },
          }
        : {}),
      ...(memberRoom
        ? {
            room: {
              ...pick(memberRoom, ["mention"]),
              ...(typeof memberRoom.roomId === "string"
                ? { ref: room(memberRoom.roomId) }
                : {}),
            },
          }
        : {}),
    };
  };
  const history = (value: unknown): unknown => {
    const entry = object(value),
      device =
        typeof entry.sourceDevice === "string" ? entry.sourceDevice : "local";
    return {
      ...(typeof entry.id === "string"
        ? { ref: refs.bind("triggers", "history", { id: entry.id }) }
        : {}),
      ...(typeof entry.triggerId === "string"
        ? { trigger: trigger(entry.triggerId) }
        : {}),
      ...(typeof entry.threadId === "string"
        ? { thread: thread(entry.threadId) }
        : {}),
      ...pick(entry, [
        "kind",
        "reason",
        "prompt",
        "startedAt",
        "completedAt",
        "status",
        "delivery",
        "error",
        "replyAuthor",
        "sourceWorkspace",
      ]),
      ...(typeof entry.turnId === "string"
        ? { turn: turn(entry.turnId, entry.threadId) }
        : {}),
      ...(typeof entry.sourceThreadId === "string"
        ? { sourceThread: thread(entry.sourceThreadId, device) }
        : {}),
      ...(typeof entry.sourceTurnId === "string"
        ? { sourceTurn: turn(entry.sourceTurnId, entry.sourceThreadId, device) }
        : {}),
      ...(typeof entry.sourceRoomId === "string"
        ? { sourceRoom: room(entry.sourceRoomId) }
        : {}),
      ...(typeof entry.sourceRoomMessageId === "string"
        ? {
            sourceMessage: refs.bind(
              "rooms",
              "message",
              asJson({
                id: entry.sourceRoomMessageId,
                roomId: entry.sourceRoomId,
              }),
            ),
          }
        : {}),
      ...(typeof entry.replyRoomId === "string"
        ? { replyRoom: room(entry.replyRoomId) }
        : {}),
      ...(entry.programOutcome === undefined
        ? {}
        : { programOutcome: programOutcome(entry.programOutcome) }),
      ...(Array.isArray(entry.programOutcomes)
        ? { programOutcomes: entry.programOutcomes.map(programOutcome) }
        : {}),
    };
  };
  const preview = (value: Record<string, unknown>) => ({
    ...pick(value, [
      "workspace",
      "resolvedWorkspace",
      "modelId",
      "reasoningEffort",
      "sandbox",
      "approvalPolicy",
    ]),
    snapshot: refs.bind(
      "triggers",
      "target-preview",
      asJson({ workspace: value.workspace, preview: value }),
      epoch,
    ),
  });
  if (name === "zenx_triggers_threads")
    return projectThreadResult(result, args, refs);
  if (name === "zenx_triggers_result") {
    const { sourceDevice, sourceWorkspace, ...rest } = result;
    return {
      ...projectThreadResult(
        rest,
        {
          ...args,
          device: typeof sourceDevice === "string" ? sourceDevice : "local",
        },
        refs,
      ),
      ...(sourceWorkspace === undefined ? {} : { workspace: sourceWorkspace }),
    };
  }
  if (name === "zenx_triggers_preview_target") return preview(result);
  if (name === "zenx_triggers_create_target")
    return {
      ...(typeof result.threadId === "string"
        ? { thread: thread(result.threadId) }
        : {}),
      ...(record(result.effective)
        ? { effective: preview(object(result.effective)) }
        : {}),
      ...pick(result, ["created", "error", "status"]),
    };
  if (typeof result.id === "string")
    return definition(result) as Record<string, unknown>;
  const output = { ...result };
  if (Array.isArray(result.triggers))
    output.triggers = result.triggers.map(definition);
  if (Array.isArray(result.history))
    output.history = result.history.map(history);
  if (Array.isArray(result.rooms))
    output.rooms = projectRoomResult(
      "zenx_rooms_list",
      { rooms: result.rooms },
      args,
      refs,
      epoch,
    ).rooms;
  return output;
}
