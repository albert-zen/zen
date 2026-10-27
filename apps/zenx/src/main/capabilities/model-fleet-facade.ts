import type { ModelTool } from "../../../../../src/model.js";
import type {
  ToolExecutionResult,
  ToolInvocation,
} from "../../../../../src/tool.js";
import {
  ModelReferenceRegistry,
  CAPABILITY_REFERENCE_BUDGET,
  attachModelReferenceBindings,
  type ModelReferenceScope,
} from "../../../../../src/model-references.js";
import { TOOL_TASK_CONTENT_TYPE } from "../../../../../src/tool-task-content.js";
import { parseRemoteToolCatalogResult } from "../../../../../src/protocol/native/remote-tool-wire.js";
import {
  FLEET_CATALOG_CONTENT_TYPE,
  isFleetToolHandle,
} from "../fleet-tool-router.js";
import {
  MODEL_REF,
  asJson,
  object,
  record,
  only,
  pick,
  renameField,
} from "./model-facade-fields.js";
import {
  isThreadModelTool,
  threadModelDefinition,
  decodeThreadArguments,
  projectThreadToolResult,
} from "./model-thread-facade.js";

const mappings: Record<string, string> = {
  zenx_fleet_workspaces: "zenx_projects_list",
  zenx_fleet_models: "zenx_models_list",
  zenx_fleet_threads_list: "zenx_threads_list",
  zenx_fleet_threads_read: "zenx_threads_read",
  zenx_fleet_threads_create: "zenx_threads_create",
  zenx_fleet_threads_send: "zenx_threads_send",
  zenx_fleet_threads_status: "zenx_threads_status",
};
const names = new Set([
  ...Object.keys(mappings),
  "zenx_fleet_devices",
  "zenx_self_control_devices",
  "zenx_fleet_readiness",
  "zenx_fleet_probe",
  "zenx_fleet_shell",
  "zenx_fleet_tools",
  "zenx_fleet_execute",
  "zenx_fleet_tool_status",
  "zenx_fleet_source_read",
  "zenx_fleet_source_send",
  "zenx_fleet_trigger_read",
]);
export const isFleetModelTool = (name: string) => names.has(name);
export function isFleetModelInvocation(invocation: ToolInvocation): boolean {
  return (
    names.has(invocation.name) ||
    (isThreadModelTool(invocation.name) &&
      invocation.arguments.device !== undefined &&
      invocation.arguments.device !== "local") ||
    (invocation.name === "wait" &&
      invocation.modelReferences?.some(
        (b) =>
          b.ownerThreadId === invocation.threadId &&
          b.ref === invocation.arguments.task_id &&
          b.namespace === "fleet" &&
          b.kind === "task",
      ) === true)
  );
}
export const fleetModelDocument =
  "Choose the explicitly requested machine by semantic label and exact device ref from devices; names/descriptions are guidance, not permission. Discover its workspaces and Threads, then tools with device/workspace/thread refs. Execute a catalog tool ref with unchanged foreign arguments, or use its semantic Fleet proxy; ordinary projected tools may use remoteTool. Source read/send uses the exact received message source ref, never sender labels or rediscovered routes. Task refs identify one target admission: wait/status only observe that operation. Accepted is not completed; offline, changed configuration or stale epochs fail closed, never fallback locally or replay unknown effects. Ref provenance is scoped to this receiving Thread; refresh retired catalogs. Literal text, code and paths remain unchanged; remote paths are not local files.";
export function fleetDeviceModelDefinition<T extends ModelTool>(source: T): T {
  const tool = structuredClone(source),
    fields = record(tool.inputSchema.properties);
  if (fields?.device)
    fields.device = {
      type: "string",
      pattern: "^(local|r[1-9][0-9]*)$",
      description:
        "Exact device ref from devices, or local. Never infer a route from a label.",
    };
  return tool;
}
export function fleetModelDefinition<T extends ModelTool>(source: T): T {
  let tool = structuredClone(source);
  const name = source.name;
  if (mappings[name])
    tool = {
      ...threadModelDefinition({ ...tool, name: mappings[name]! }),
      name,
    };
  tool = fleetDeviceModelDefinition(tool);
  const schema = tool.inputSchema,
    fields = object(schema.properties ?? (schema.properties = {}));
  if (fields.workspace) fields.workspace = structuredClone(MODEL_REF);
  renameField(schema, "targetThreadId", "thread");
  if (name === "zenx_fleet_execute") {
    schema.properties = {
      tool: structuredClone(MODEL_REF),
      arguments: fields.arguments,
      ...pick(fields, ["yield_time_ms", "timeout_ms", "max_output_bytes"]),
    };
    schema.required = ["tool", "arguments"];
  }
  if (name === "zenx_fleet_tool_status")
    fields.task_id = structuredClone(MODEL_REF);
  if (
    name === "zenx_fleet_source_read" ||
    name === "zenx_fleet_source_send" ||
    name === "zenx_fleet_trigger_read"
  ) {
    schema.properties = {
      source: { ...MODEL_REF, pattern: "^[rs][1-9][0-9]*$" },
      ...pick(fields, ["text", "messageType"]),
    };
    schema.required = name.endsWith("_send") ? ["source", "text"] : ["source"];
  }
  tool.description = `Fleet ${name.replace(/^zenx_(fleet_|self_control_)/u, "")}: use exact scoped refs and semantic names. Native grants and freshness checks remain authoritative. No local fallback or automatic retry of unknown effects.`;
  return tool;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw Error("Exact Fleet identity unavailable");
  return value;
}
function sameRoute(
  bound: Record<string, unknown>,
  args: Record<string, unknown>,
): void {
  if (
    bound.device !== (args.device ?? "local") ||
    bound.deviceKey !== args.deviceKey
  )
    throw Error("Fleet reference belongs to a different captured device route");
  if (
    args.workspace !== undefined &&
    bound.workspace !== undefined &&
    bound.workspace !== args.workspace
  )
    throw Error("Fleet reference belongs to another workspace");
}
function decode(
  name: string,
  input: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  let args = structuredClone(input);
  if (name === "zenx_fleet_execute") {
    only(args, [
      "tool",
      "arguments",
      "yield_time_ms",
      "timeout_ms",
      "max_output_bytes",
      "name",
    ]);
    const route = object(refs.resolve(args.tool, "fleet", "tool", epoch));
    if (args.name !== undefined && args.name !== route.name)
      throw Error("Remote tool ref does not match this tool");
    return {
      ...route,
      ...pick(args, [
        "arguments",
        "yield_time_ms",
        "timeout_ms",
        "max_output_bytes",
      ]),
    };
  }
  if (name === "wait" || name === "zenx_fleet_tool_status") {
    only(
      args,
      name === "wait" ? ["task_id", "yield_time_ms", "terminate"] : ["task_id"],
    );
    args.task_id = object(refs.resolve(args.task_id, "fleet", "task")).handle;
    return args;
  }
  if (name === "zenx_fleet_source_read" || name === "zenx_fleet_source_send") {
    only(args, ["source", "text", "messageType"]);
    const binding = refs.lookup(args.source);
    if (
      !binding ||
      !(
        (binding.namespace === "selected-reference" &&
          binding.kind === "message") ||
        (binding.namespace === "threads" && binding.kind === "item") ||
        (binding.namespace === "fleet" && binding.kind === "message-source")
      )
    )
      throw Error("Use the exact received message ref");
    if (
      name === "zenx_fleet_source_send" &&
      binding.namespace === "selected-reference"
    )
      throw Error(
        "Selected sources are read-only; read the received source first and use its returned exact source ref",
      );
    const source = object(
      refs.resolve(args.source, binding.namespace, binding.kind),
    );
    if (source.device !== undefined && source.device !== "local")
      throw Error(
        "Source routing requires a local received message, not rediscovery data",
      );
    return {
      threadId: string(source.threadId),
      itemId: string(source.id),
      ...pick(args, ["text", "messageType"]),
    };
  }
  if (name === "zenx_fleet_trigger_read") {
    only(args, ["source"]);
    return object(refs.resolve(args.source, "fleet", "trigger-source"));
  }
  if (args.deviceKey !== undefined || args.targetThreadId !== undefined)
    throw Error("Use exact Fleet refs, not native routing fields");
  if (args.device !== undefined && args.device !== "local") {
    const bound = object(refs.resolve(args.device, "fleet", "device"));
    args.device = string(bound.id);
    args.deviceKey = string(bound.key);
  }
  for (const field of ["workspace", "project"]) {
    if (
      args[field] === undefined ||
      args.device === undefined ||
      args.device === "local"
    )
      continue;
    const bound = object(refs.resolve(args[field], "fleet", "workspace"));
    sameRoute(bound, args);
    args[field] = bound.id;
  }
  if (args.thread !== undefined) {
    const bound = object(refs.resolve(args.thread, "threads", "thread"));
    sameRoute(bound, args);
    args.targetThreadId = bound.id;
    if (args.workspace === undefined && bound.workspace !== undefined)
      args.workspace = bound.workspace;
    delete args.thread;
  }
  const mapped = mappings[name] ?? name;
  if (isThreadModelTool(mapped))
    args = decodeThreadArguments(mapped, args, refs, epoch);
  return args;
}
function device(
  value: unknown,
  refs: ModelReferenceScope,
): Record<string, unknown> {
  const entry = object(value),
    id = string(entry.id);
  return {
    ref:
      id === "local"
        ? "local"
        : refs.bind("fleet", "device", asJson({ id, key: string(entry.key) })),
    ...pick(entry, [
      "label",
      "description",
      "access",
      "transport",
      "status",
      "shellEnabled",
      "toolsEnabled",
      "check",
    ]),
  };
}
function workspace(
  id: unknown,
  args: Record<string, unknown>,
  refs: ModelReferenceScope,
): string {
  return refs.bind(
    "fleet",
    "workspace",
    asJson({
      id: string(id),
      device: args.device ?? "local",
      ...(args.deviceKey === undefined ? {} : { deviceKey: args.deviceKey }),
    }),
  );
}
function project(
  name: string,
  raw: ToolExecutionResult,
  data: Record<string, unknown>,
  args: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  if (name === "zenx_fleet_tools") {
    if (
      raw.contentType !== FLEET_CATALOG_CONTENT_TYPE ||
      !record(raw.structuredContent)
    )
      throw Error("Fleet catalog lacks native structured authority");
    const disclosure = object(raw.structuredContent);
    if (
      disclosure.source !== "zenx.fleet.tools" ||
      disclosure.sourceThreadId !== refs.ownerThreadId ||
      disclosure.device !== args.device ||
      disclosure.deviceKey !== args.deviceKey ||
      disclosure.workspaceId !== args.workspace ||
      disclosure.targetThreadId !== args.targetThreadId
    )
      throw Error("Fleet catalog does not match the selected exact route");
    const catalog = parseRemoteToolCatalogResult(disclosure.catalog);
    return {
      tools: catalog.tools.map((entry) => ({
        name: entry.definition.name,
        description: entry.definition.description,
        inputSchema: entry.definition.inputSchema,
        eligible: entry.eligible,
        ...(entry.reason ? { reason: entry.reason } : {}),
        ...(entry.eligible
          ? {
              ref: refs.bind(
                "fleet",
                "tool",
                asJson({
                  device: args.device,
                  deviceKey: args.deviceKey,
                  workspace: args.workspace,
                  targetThreadId: args.targetThreadId,
                  processEpoch: catalog.processEpoch,
                  toolGeneration: entry.generation,
                  name: entry.definition.name,
                }),
                epoch,
              ),
            }
          : {}),
      })),
    };
  }
  if (
    name === "zenx_fleet_execute" ||
    name === "zenx_fleet_tool_status" ||
    name === "wait"
  ) {
    const value =
      raw.contentType === TOOL_TASK_CONTENT_TYPE
        ? object(raw.structuredContent)
        : data;
    if (!isFleetToolHandle(value.task_id))
      throw Error("Fleet task receipt has no exact recovery handle");
    const output: Record<string, unknown> = {
      ...pick(value, [
        "status",
        "admission",
        "observation",
        "error",
        "safeNextStep",
        "exit_code",
        "paths",
        "result",
        "result_content_type",
        "tool_name",
      ]),
      task_id: refs.bind("fleet", "task", { handle: value.task_id }),
    };
    if (raw.contentType === TOOL_TASK_CONTENT_TYPE) {
      const footer = raw.output.lastIndexOf("\n[remote tool task ");
      if (footer < 0)
        throw Error("Fleet task receipt has no typed output boundary");
      output.output = raw.output.slice(0, footer);
    }
    return output;
  }
  if (
    name === "zenx_fleet_devices" ||
    name === "zenx_self_control_devices" ||
    name === "zenx_fleet_readiness"
  ) {
    return {
      ...(Array.isArray(data.devices)
        ? { devices: data.devices.map((value) => device(value, refs)) }
        : {}),
      ...(name === "zenx_fleet_readiness"
        ? {
            ...pick(data, ["prerequisites", "network", "limitations", "steps"]),
            host: pick(record(data.host) ?? {}, [
              "configured",
              "enabled",
              "access",
              "shellEnabled",
              "toolsEnabled",
              "relayConnected",
              "relayConfigured",
              "error",
            ]),
          }
        : {}),
    };
  }
  if (name === "zenx_fleet_probe") return { device: device(data.device, refs) };
  if (name === "zenx_fleet_source_read") {
    const received = object(data.receipt);
    if (received.threadId !== args.threadId || received.itemId !== args.itemId)
      throw Error(
        "Received source receipt does not match the selected message",
      );
    const locator = object(data.locator);
    const scoped = {
      device: string(locator.deviceId),
      deviceKey: string(locator.deviceKey),
      workspace: string(locator.workspace),
      threadId: string(locator.threadId),
    };
    return {
      source: refs.bind(
        "fleet",
        "message-source",
        asJson({ threadId: args.threadId, id: args.itemId, device: "local" }),
      ),
      history: projectRemoteThread(
        "zenx_threads_read",
        object(data.history),
        scoped,
        refs,
        epoch,
      ),
    };
  }
  const result = record(data.result) ?? data;
  if (name === "zenx_fleet_source_send")
    return pick(result, [
      "status",
      "accepted",
      "queued",
      "timedOut",
      "error",
      "messageType",
    ]);
  if (name === "zenx_fleet_trigger_read")
    return {
      ...pick(record(result.trigger) ?? result, [
        "status",
        "enabled",
        "name",
        "description",
        "settings",
        "error",
      ]),
      source: refs.bind("fleet", "trigger-source", asJson(args)),
    };
  if (name === "zenx_fleet_shell")
    return {
      ...pick(result, [
        "output",
        "exitCode",
        "sourceTruncated",
        "status",
        "error",
      ]),
      paths: "remote-host",
    };
  return projectRemoteThread(mappings[name] ?? name, result, args, refs, epoch);
}
function projectRemoteThread(
  name: string,
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  refs: ModelReferenceScope,
  epoch: string,
): Record<string, unknown> {
  if (
    name === "zenx_projects_list" &&
    args.device !== undefined &&
    args.device !== "local"
  )
    return {
      workspaces: (Array.isArray(result.projects) ? result.projects : []).map(
        (value) => {
          const item = object(value);
          return {
            ref: workspace(item.id ?? item.project ?? item.cwd, args, refs),
            ...pick(item, ["name", "configured", "isDefault"]),
            ...(result.source === "zenx.remote-host"
              ? {}
              : pick(item, ["cwd"])),
          };
        },
      ),
      ...pick(result, ["truncated"]),
    };
  if (result.source === "zenx.remote-host" && args.workspace === undefined) {
    const first = Array.isArray(result.threads)
      ? record(result.threads[0])
      : undefined;
    const capturedWorkspace =
      result.workspace ?? result.cwd ?? first?.workspace ?? first?.cwd;
    if (typeof capturedWorkspace === "string")
      args = { ...args, workspace: capturedWorkspace };
  }
  const projected = projectThreadToolResult(name, result, args, refs, epoch);
  // Only known native workspace-envelope fields; literal history/tool payload stays untouched.
  if (result.source === "zenx.remote-host") {
    const compactWorkspace = (
      source: Record<string, unknown>,
      target: Record<string, unknown>,
    ) => {
      for (const key of ["cwd", "workspace"])
        if (typeof source[key] === "string")
          target[key] = workspace(source[key], args, refs);
    };
    compactWorkspace(result, projected);
    for (const key of ["threads", "candidates"])
      if (Array.isArray(result[key]) && Array.isArray(projected[key]))
        result[key].forEach((value, index) =>
          compactWorkspace(
            object(value),
            object((projected[key] as unknown[])[index]),
          ),
        );
  }
  return projected;
}
function facts(data: Record<string, unknown>): Record<string, unknown> {
  const result = record(data.result) ?? data;
  const picked = Object.fromEntries(
    Object.entries(
      pick(result, [
        "status",
        "admission",
        "observation",
        "created",
        "accepted",
        "queued",
        "updated",
        "deleted",
        "timedOut",
        "exit_code",
        "error",
      ]),
    ).filter(
      ([, value]) =>
        value === null ||
        ["boolean", "string", "number"].includes(typeof value),
    ),
  );
  return {
    classification: Object.keys(picked).length ? "known" : "unclassified",
    ...picked,
  };
}
/** Typed projection runs before any model publication, including target-router dispatch. */
export async function invokeFleetModelToolFacade(options: {
  invocation: ToolInvocation;
  epoch: string;
  references: ModelReferenceRegistry;
  dispatch(invocation: ToolInvocation): Promise<ToolExecutionResult>;
}): Promise<ToolExecutionResult> {
  const { invocation, epoch, references, dispatch } = options;
  const refs = references.scope(
    string(invocation.threadId),
    invocation.modelReferences,
    CAPABILITY_REFERENCE_BUDGET,
  );
  const args = decode(invocation.name, invocation.arguments, refs, epoch),
    inputs = refs.newBindings;
  await invocation.traceOutput?.recordInvocation?.({
    captureLayer: "fleet-model-reference-resolved-dispatch",
    tool: invocation.name,
    modelArguments: invocation.arguments,
    backendArguments: args,
  });
  await invocation.traceOutput?.recordReferenceBindings?.(inputs);
  invocation.signal.throwIfAborted();
  const raw = await dispatch({ ...invocation, arguments: args });
  const capture = record(
    await invocation.traceOutput?.recordResult(
      raw,
      "fleet-result-before-model-projection",
    ),
  );
  let data: Record<string, unknown> = {};
  try {
    data = record(JSON.parse(raw.output)) ?? {};
  } catch {
    /* Task text has a typed structured envelope. */
  }
  let output: Record<string, unknown>,
    bindings = inputs;
  try {
    output = project(invocation.name, raw, data, args, refs, epoch);
    bindings = refs.newBindings;
  } catch {
    let trace: Record<string, unknown> = { status: "unavailable" };
    if (
      invocation.modelTraceInspectionTool === "trace_read" &&
      capture?.durability === "durable" &&
      record(capture.locator)
    ) {
      try {
        const essential = references.scope(
          string(invocation.threadId),
          invocation.modelReferences,
          { maxBindings: 1, maxBytes: 4096 },
        );
        trace = {
          ref: essential.bind(
            "trace",
            "tool-result",
            asJson({ locator: capture.locator, tool: "trace_read" }),
          ),
          tool: "trace_read",
        };
        bindings = [
          ...inputs,
          ...essential.newBindings.filter(
            (b) => !inputs.some((input) => input.ref === b.ref),
          ),
        ];
      } catch {
        /* Unavailable evidence is not proof of non-dispatch. */
      }
    }
    output = {
      projection: "projection_unavailable",
      toolReturn: { exitCode: raw.exitCode },
      outcome: facts(record(raw.structuredContent) ?? data),
      trace,
      safeNextStep:
        "Inspect this exact evidence or read current state with a smaller scope. Do not replay a mutation because its compact projection is unavailable.",
    };
  }
  const result: ToolExecutionResult = {
    ...raw,
    output: JSON.stringify(output),
  };
  delete result.modelContent;
  if (
    raw.contentType !== FLEET_CATALOG_CONTENT_TYPE ||
    output.projection === "projection_unavailable"
  ) {
    delete result.contentType;
    delete result.structuredContent;
  }
  await invocation.traceOutput?.recordReferenceBindings?.(bindings);
  return attachModelReferenceBindings(result, bindings);
}
