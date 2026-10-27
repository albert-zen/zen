import type { ModelTool } from "../../../../../src/model.js";
import type { ModelReferenceScope } from "../../../../../src/model-references.js";
import { decodeModelKey } from "../../../../../src/protocol/model-key.js";
import {
  MODEL_REF,
  object,
  record,
  asJson,
  pick,
  renameField,
} from "./model-facade-fields.js";
const threads = new Set([
  "zenx_threads_list",
  "zenx_threads_create",
  "zenx_threads_read",
  "zenx_threads_status",
  "zenx_threads_configure",
  "zenx_threads_rename",
  "zenx_threads_archive",
  "zenx_threads_unarchive",
  "zenx_threads_send",
  "zenx_self_control_threads_wait",
]);
const subagents = new Set([
  "zenx_subagents_create",
  "zenx_subagents_list",
  "zenx_subagents_read",
  "zenx_subagents_send",
]);
const workflows = new Set([
  "zenx_self_control_workflows_get",
  "zenx_self_control_workflows_update",
]);
const mapped = (name: string) =>
  name === "zenx_subagents_read"
    ? "zenx_threads_read"
    : name === "zenx_subagents_send"
      ? "zenx_threads_send"
      : name;
export const isThreadModelTool = (name: string) =>
  threads.has(name) ||
  subagents.has(name) ||
  workflows.has(name) ||
  name === "zenx_models_list" ||
  name === "zenx_projects_list";
export function threadModelDefinition<T extends ModelTool>(source: T): T {
  const tool = structuredClone(source),
    schema = tool.inputSchema,
    fields = object(schema.properties ?? {}),
    name = mapped(tool.name);
  if (subagents.has(tool.name) && name !== tool.name) {
    fields.threadId = { type: "string" };
    schema.required = Array.isArray(schema.required)
      ? schema.required.filter((field) => field !== "target")
      : [];
    schema.oneOf = [{ required: ["target"] }, { required: ["threadId"] }];
  }
  if (threads.has(name)) {
    for (const [from, to] of [
      ["threadId", "ref"],
      ["turnId", "turn"],
      ["itemId", "item"],
      ["throughItemId", "through"],
    ])
      renameField(schema, from!, to!);
    if (fields.cursor) fields.cursor = structuredClone(MODEL_REF);
    if (fields.target)
      fields.target = {
        type: "string",
        description:
          "Exact semantic Thread name; ambiguous names return candidates. Use ref for exact identity.",
      };
    if (name === "zenx_threads_read")
      fields.ref = {
        ...MODEL_REF,
        pattern: "^[rs][1-9][0-9]*$",
        description:
          "Exact Thread ref or selected source ref; selected refs authorize reads only.",
      };
  }
  if (subagents.has(tool.name)) renameField(schema, "parentThreadId", "parent");
  if (workflows.has(name)) renameField(schema, "baseRevision", "snapshot");
  if (fields.model)
    fields.model = {
      type: "string",
      description:
        "Exact model ref from zenx_models_list or an unambiguous semantic model name.",
    };
  tool.description = workflows.has(name)
    ? "Read or replace workflow configuration against the exact immutable snapshot from workflows_get. Conflicts require a fresh read and deliberate merge, never automatic retry."
    : name === "zenx_models_list"
      ? "Discover semantic model names, exact selection refs, reasoning efforts and defaults. Same-name provider choices have distinct refs."
      : name === "zenx_projects_list"
        ? "List semantic project names, workspace paths and exact Thread refs; a project is not a runtime object."
        : "Use exact scoped Thread refs or semantic names; same-label candidates remain distinct. History preserves literal user/tool text and explicit public-item detail. Selected sources permit only exact history reads. Native Thread/provider/permission checks remain authoritative; created or accepted does not mean work completed. Preserve failed and unknown outcomes; never replay uncertain mutations.";
  return tool;
}
export function decodeThreadArguments(
  originalName: string,
  input: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  const name = mapped(originalName),
    args = structuredClone(input),
    device = typeof args.device === "string" ? args.device : "local";
  if (typeof args.model === "string" && /^r[1-9][0-9]*$/u.test(args.model)) {
    const bound = object(
      refs.resolve(args.model, "models", "selection", epoch),
    );
    if (bound.device !== device)
      throw Error("Model ref belongs to a different device");
    args.model = bound.id;
  }
  if (subagents.has(originalName) && name === originalName) {
    if (args.parentThreadId !== undefined)
      throw Error("Use the exact parent Thread ref");
    if (args.parent !== undefined) {
      const bound = object(refs.resolve(args.parent, "threads", "thread"));
      if (bound.device !== "local")
        throw Error("Subagent parent requires a local Thread");
      delete args.parent;
      args.parentThreadId = bound.id;
    }
    return args;
  }
  if (workflows.has(name)) {
    if (args.baseRevision !== undefined)
      throw Error("Use the immutable workflow snapshot");
    if (name.endsWith("_update")) {
      const bound = object(
        refs.resolve(args.snapshot, "workflows", "snapshot", epoch),
      );
      delete args.snapshot;
      args.baseRevision = bound.revision;
    }
    return args;
  }
  if (!threads.has(name)) return args;
  for (const key of ["threadId", "turnId", "itemId", "throughItemId"])
    if (key in args) throw Error("Use exact scoped Thread history refs");
  if (args.ref !== undefined) {
    const selected =
      name === "zenx_threads_read" ? refs.lookup(args.ref) : undefined;
    if (
      selected?.namespace === "selected-reference" &&
      ["thread", "message", "history"].includes(selected.kind)
    ) {
      const bound = object(
        refs.resolve(args.ref, "selected-reference", selected.kind),
      );
      if (
        device !== "local" ||
        args.target !== undefined ||
        args.through !== undefined ||
        (selected.kind === "message" && args.item !== undefined) ||
        (selected.kind !== "thread" && args.turn !== undefined)
      )
        throw Error(
          "Selected source ref identifies its exact local history read",
        );
      args.threadId = selected.kind === "thread" ? bound.id : bound.threadId;
      if (selected.kind === "message") {
        args.itemId = bound.id;
        args.granularity = "item";
      }
      if (selected.kind === "history") args.throughItemId = bound.throughItemId;
    } else {
      const bound = object(refs.resolve(args.ref, "threads", "thread"));
      if (bound.device !== device)
        throw Error("Thread ref belongs to a different device");
      args.threadId = bound.id;
    }
    delete args.ref;
  }
  for (const [field, native, kind] of [
    ["turn", "turnId", "turn"],
    ["item", "itemId", "item"],
    ["through", "throughItemId", "item"],
    ["cursor", "cursor", "cursor"],
  ] as const) {
    if (args[field] === undefined) continue;
    const bound = object(refs.resolve(args[field], "threads", kind));
    if (
      bound.device !== device ||
      (args.threadId !== undefined &&
        bound.threadId !== undefined &&
        args.threadId !== bound.threadId)
    )
      throw Error("Reference belongs to a different Thread or device");
    if (bound.threadId !== undefined) {
      if (args.target !== undefined)
        throw Error("Use exact Thread ref with history refs");
      args.threadId = bound.threadId;
    }
    delete args[field];
    args[native] = bound.id;
  }
  return args;
}
export function projectThreadResult(
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  refs: ModelReferenceScope,
): Record<string, unknown> {
  const device = typeof args.device === "string" ? args.device : "local",
    threadId =
      typeof result.threadId === "string"
        ? result.threadId
        : typeof args.threadId === "string"
          ? args.threadId
          : undefined;
  const thread = (id: string) => refs.bind("threads", "thread", { id, device });
  const scoped = (kind: string, id: unknown, owner = threadId) =>
    typeof id === "string"
      ? refs.bind(
          "threads",
          kind,
          asJson({ id, device, ...(owner ? { threadId: owner } : {}) }),
        )
      : id;
  const summary = (value: unknown): unknown => {
    const entry = record(value);
    if (!entry) return value;
    const id = typeof entry.threadId === "string" ? entry.threadId : entry.id;
    const metadata = record(entry.currentMetadata),
      last = record(entry.lastTurnEnd);
    return {
      ...(typeof id === "string" ? { ref: thread(id) } : {}),
      ...pick(entry, [
        "name",
        "cwd",
        "status",
        "archived",
        "createdAt",
        "updatedAt",
        "preview",
        "error",
        "modelId",
        "reasoningEffort",
        "sandbox",
        "approvalPolicy",
      ]),
      ...(metadata
        ? {
            settings: pick(metadata, [
              "cwd",
              "model",
              "modelId",
              "reasoningEffort",
              "sandbox",
              "approvalPolicy",
            ]),
          }
        : {}),
      ...(typeof entry.parentThreadId === "string"
        ? { parent: thread(entry.parentThreadId) }
        : {}),
      ...(typeof entry.forkedFromThreadId === "string"
        ? { source: thread(entry.forkedFromThreadId) }
        : {}),
      ...(last
        ? {
            lastTurn: {
              ...pick(last, ["status", "createdAt", "error"]),
              turn: scoped(
                "turn",
                last.turnId,
                typeof id === "string" ? id : undefined,
              ),
            },
          }
        : {}),
    };
  };
  const item = (value: unknown): unknown => {
    const entry = record(value);
    if (!entry) return value;
    const {
      itemId,
      turnId,
      item: _item,
      preview: _preview,
      read: _read,
      sourceId: _source,
      ...rest
    } = entry;
    return {
      ref: scoped("item", itemId),
      ...(turnId ? { turn: scoped("turn", turnId) } : {}),
      ...rest,
    };
  };
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (
      [
        "source",
        "clientUserMessageId",
        "clientId",
        "messageId",
        "sourceCallId",
        "sourceToolCallId",
        "sourceThreadId",
        "expectedTurnId",
        "modelProvider",
      ].includes(key)
    )
      continue;
    if (key === "threadId")
      output.ref = typeof value === "string" ? thread(value) : value;
    else if (key === "turnId" || key === "activeTurnId")
      output[key === "turnId" ? "turn" : "activeTurn"] = scoped("turn", value);
    else if (key === "itemId") output.item = scoped("item", value);
    else if (key === "snapshotThroughItemId") {
      if (args.throughItemId !== undefined)
        output.through = scoped("item", value);
    } else if (key === "nextCursor")
      output.nextCursor = scoped("cursor", value);
    else if (
      (key === "threads" || key === "candidates") &&
      Array.isArray(value)
    )
      output[key] = value.map(summary);
    else if (key === "thread") output.thread = summary(value);
    else if (key === "parentThreadId")
      output.parent = typeof value === "string" ? thread(value) : value;
    else if (key === "delivery" && record(value))
      output.delivery = projectThreadResult(object(value), args, refs);
    else if (key === "runtime" && record(value)) {
      const runtime = pick(object(value), [
        "cwd",
        "model",
        "reasoningEffort",
        "approvalPolicy",
        "sandbox",
      ]);
      // Native thread/start returns a typed encoded provider/model key here.
      if (
        typeof runtime.model === "string" &&
        runtime.model.startsWith("zen-model-v1:")
      )
        runtime.model = decodeModelKey(runtime.model).modelId;
      output.runtime = runtime;
    } else if (key === "items" && Array.isArray(value))
      output.items = value.map(item);
    else if (key === "turns" && Array.isArray(value))
      output.turns = value.map((value) => {
        const entry = object(value);
        return {
          turn: scoped("turn", entry.turnId),
          status: entry.status,
          items: Array.isArray(entry.items) ? entry.items.map(item) : [],
          itemsTruncated: entry.itemsTruncated,
        };
      });
    else output[key] = value;
  }
  return output;
}
export function projectThreadToolResult(
  name: string,
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  if (workflows.has(name)) {
    const { revision, ...rest } = result;
    return {
      ...rest,
      ...(typeof revision === "number"
        ? { snapshot: refs.bind("workflows", "snapshot", { revision }, epoch) }
        : {}),
    };
  }
  const device = typeof args.device === "string" ? args.device : "local";
  if (name === "zenx_models_list") {
    const { source: _source, ...output } = result;
    if (Array.isArray(result.models))
      output.models = result.models.map((value) => {
        const entry = object(value),
          id = typeof entry.model === "string" ? entry.model : entry.id;
        if (typeof id !== "string")
          throw Error("Model catalog identity unavailable");
        const { id: _id, model: _model, ...rest } = entry;
        return {
          ...rest,
          name: id.startsWith("zen-model-v1:")
            ? decodeModelKey(id).modelId
            : id,
          ref: refs.bind("models", "selection", { id, device }, epoch),
        };
      });
    return output;
  }
  if (name === "zenx_projects_list") {
    const { source: _source, ...output } = result;
    if (Array.isArray(result.projects))
      output.projects = result.projects.map((value) => {
        const { threadIds, ...rest } = object(value);
        return {
          ...rest,
          ...(Array.isArray(threadIds)
            ? {
                threads: threadIds.map((id) => ({
                  ref: refs.bind("threads", "thread", asJson({ id, device })),
                })),
              }
            : {}),
        };
      });
    return output;
  }
  return projectThreadResult(result, args, refs);
}
