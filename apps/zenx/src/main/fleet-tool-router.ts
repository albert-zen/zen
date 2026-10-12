import { createHash } from "node:crypto";
import { disclosureCallResults } from "./disclosure-history.js";
import type { CanonicalItem, JsonValue } from "../../../../src/item.js";
import type { ModelTool } from "../../../../src/model.js";
import type {
  ToolExecutionResult,
  ToolInvocation,
  ToolRemoteDefinitionEntry,
  ToolTargetRoute,
  ToolTargetRouter,
} from "../../../../src/tool.js";
import { utf8Prefix } from "../../../../src/tool-output-spool.js";
import { TOOL_TASK_CONTENT_TYPE } from "../../../../src/tool-task-content.js";
import {
  REMOTE_TOOL_MAX_OUTPUT_BYTES,
  REMOTE_TOOL_MAX_TIMEOUT_MS,
  REMOTE_TOOL_MAX_YIELD_MS,
  parseRemoteToolCatalogResult,
  type RemoteToolCatalogResult,
  type RemoteToolResult,
} from "../../../../src/protocol/native/remote-tool-wire.js";
import {
  fleetDeviceKey,
  readFleetConfig,
  type NativeFleetDevice,
} from "./fleet.js";
import {
  NativeFleetRejectedError,
  type NativeFleetClient,
} from "./fleet-native.js";

export const FLEET_TOOL_FACADES = new Set([
  "zenx_fleet_tools",
  "zenx_fleet_execute",
  "zenx_fleet_tool_status",
]);
const HANDLE_PREFIX = "fleet-tool:v1:";
/** External Host adapter data, consumed only by capability projection. */
export const FLEET_CATALOG_CONTENT_TYPE = "zen/fleet-tool-catalog-disclosure";
const MAX_CATALOG_DISCLOSURE_BYTES = 1024 * 1024;
interface TargetContext {
  workspace: string;
  deviceKey: string;
  targetThreadId: string;
  processEpoch: string;
  toolGeneration: string;
}
interface Handle {
  device: string;
  deviceKey: string;
  hostId: string;
  sourceThreadId: string;
  workspaceId: string;
  targetThreadId: string;
  processEpoch: string;
  admissionId: string;
  maxOutputBytes?: number;
  replayYieldTimeMs?: number;
  taskId?: string;
  cursor?: string;
}
interface CatalogDisclosure {
  source: "zenx.fleet.tools";
  device: string;
  deviceKey: string;
  sourceThreadId: string;
  workspaceId: string;
  targetThreadId: string;
  catalog: RemoteToolCatalogResult;
}
interface Proxy {
  definition: ModelTool;
  device: string;
  context: TargetContext;
  toolName: string;
}

/** Host-owned request projection and routing. Domain tool schemas stay untouched. */
export class FleetToolTargetRouter implements ToolTargetRouter {
  readonly #proxies = new Map<string, Map<string, Proxy>>();
  constructor(
    readonly send: (invocation: ToolInvocation) => Promise<ToolExecutionResult>,
  ) {}

  definitions(
    items: readonly CanonicalItem[],
    definitions: readonly ModelTool[],
    remote: readonly ToolRemoteDefinitionEntry[],
  ): ModelTool[] {
    const sourceThreadId = items.at(-1)?.threadId;
    const proxies = new Map<string, Proxy>();
    if (sourceThreadId) {
      this.#proxies.delete(sourceThreadId);
      if (this.#proxies.size >= 64)
        this.#proxies.delete(this.#proxies.keys().next().value!);
      this.#proxies.set(sourceThreadId, proxies);
    }
    if (!definitions.some((tool) => tool.name === "zenx_fleet_tools"))
      return [...definitions];
    const eligible = new Set(
      remote
        .filter((entry) => entry.eligible)
        .map((entry) => entry.definition.name),
    );
    const projected = definitions.map((definition) => {
      const schema = definition.inputSchema;
      const properties = schema.properties;
      if (
        !eligible.has(definition.name) ||
        schema.type !== "object" ||
        !record(properties) ||
        "device" in properties ||
        "target_context" in properties
      )
        return structuredClone(definition);
      return {
        ...structuredClone(definition),
        description: `${definition.description} Omit device for local execution. For an explicitly chosen remote machine, first discover its exact Fleet tool catalog and supply device plus target_context; no local fallback. Use the target-scoped proxy when its schema differs.`,
        inputSchema: {
          ...structuredClone(schema),
          properties: {
            ...structuredClone(properties),
            device: {
              type: "string",
              description:
                "Configured Fleet machine ID; omit or local for this Host",
            },
            target_context: targetContextSchema,
          },
        },
      };
    });
    const latest = new Map<string, CatalogDisclosure>();
    for (const { call, result: item } of disclosureCallResults(items)) {
      if (
        call.name !== "zenx_fleet_tools" ||
        item.exitCode !== 0 ||
        item.threadId !== sourceThreadId
      )
        continue;
      try {
        const value: unknown =
          item.contentType === FLEET_CATALOG_CONTENT_TYPE
            ? item.structuredContent
            : JSON.parse(item.output);
        if (!record(value) || value.source !== "zenx.fleet.tools") continue;
        const disclosure = parseDisclosure(value);
        if (disclosure.sourceThreadId !== item.threadId) continue;
        latest.set(
          `${disclosure.device}:${disclosure.workspaceId}:${disclosure.targetThreadId}`,
          disclosure,
        );
      } catch {
        /* Failed or invalid disclosure is not a capability. */
      }
    }
    for (const disclosure of latest.values()) {
      for (const entry of disclosure.catalog.tools) {
        if (!entry.eligible || proxies.size >= 128) continue;
        const name = `fleet_tool_${createHash("sha256")
          .update(
            JSON.stringify([
              disclosure.deviceKey,
              disclosure.catalog.hostId,
              disclosure.catalog.processEpoch,
              disclosure.workspaceId,
              disclosure.targetThreadId,
              entry.definition.name,
              entry.generation,
            ]),
          )
          .digest("hex")
          .slice(0, 24)}`;
        const context = {
          workspace: disclosure.workspaceId,
          deviceKey: disclosure.deviceKey,
          targetThreadId: disclosure.targetThreadId,
          processEpoch: disclosure.catalog.processEpoch,
          toolGeneration: entry.generation,
        };
        const definition = {
          name,
          description: `[${disclosure.device}, ${entry.definition.name}] ${entry.definition.description} Exact target schema; execution stays on that Host. Remote paths are not local files.`,
          inputSchema: {
            type: "object",
            properties: {
              arguments: structuredClone(entry.definition.inputSchema),
            },
            required: ["arguments"],
            additionalProperties: false,
          },
        };
        proxies.set(name, {
          definition,
          device: disclosure.device,
          context,
          toolName: entry.definition.name,
        });
        projected.push(definition);
      }
    }
    return projected;
  }

  prepare(
    invocation: ToolInvocation,
    local?: ToolRemoteDefinitionEntry,
  ): ToolTargetRoute | undefined {
    let forwarded = invocation;
    const proxy = this.#proxies
      .get(invocation.threadId ?? "")
      ?.get(invocation.name);
    if (proxy) {
      only(invocation.arguments, ["arguments"]);
      if (!record(invocation.arguments.arguments))
        throw new Error("Remote proxy arguments must be an object");
      forwarded = {
        ...invocation,
        name: "zenx_fleet_execute",
        arguments: {
          device: proxy.device,
          ...proxy.context,
          name: proxy.toolName,
          arguments: invocation.arguments.arguments,
        },
      };
    } else if (
      invocation.name === "wait" &&
      isFleetToolHandle(invocation.arguments.task_id)
    ) {
      // Wait stays the existing Core tool. Only the target owns its execution task.
    } else if (FLEET_TOOL_FACADES.has(invocation.name)) {
      if (!local) throw new Error("Fleet tool plugin is unavailable");
    } else {
      const device = invocation.arguments.device;
      if (device === undefined || device === "local") return undefined;
      if (!local?.eligible) return undefined;
      const props = local.definition.inputSchema.properties;
      if (record(props) && ("device" in props || "target_context" in props))
        return undefined;
      if (
        typeof device !== "string" ||
        !record(invocation.arguments.target_context)
      )
        throw new Error(
          "Remote tool execution requires device and exact target_context from Fleet discovery",
        );
      const context = parseContext(invocation.arguments.target_context);
      const {
        device: _device,
        target_context: _context,
        ...arguments_
      } = invocation.arguments;
      forwarded = {
        ...invocation,
        name: "zenx_fleet_execute",
        arguments: {
          device,
          ...context,
          name: invocation.name,
          arguments: arguments_,
        },
      };
    }
    if (!invocation.threadId)
      throw new Error("Fleet tool routing requires a source Thread");
    const definition = proxy?.definition ?? local?.definition;
    if (!definition) throw new Error("Remote tool definition is unavailable");
    return {
      owner: { kind: "external", id: "fleet-tool-target" },
      definition,
      executionMode: "parallel_safe",
      ...(invocation.name === "wait" ? { waitPolicyExempt: true } : {}),
      ...(forwarded.name === "zenx_fleet_execute" || invocation.name === "wait"
        ? { resultEnvelope: "tool-task" as const }
        : {}),
      execute: () => this.send(forwarded),
    };
  }
}

/** Authenticated remote observation with no second execution manager or journal. */
export class FleetToolTransportAdapter {
  #inFlight = 0;
  constructor(
    readonly fleet: {
      file: string;
      native: Pick<
        NativeFleetClient,
        "catalog" | "execute" | "wait" | "status"
      >;
    },
    readonly assertAvailable: () => void,
  ) {}

  async invoke(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    this.assertAvailable();
    invocation.signal.throwIfAborted();
    const sourceThreadId = string(invocation.threadId, "source Thread");
    if (this.#inFlight >= 32)
      throw new Error("Fleet transport request capacity is busy");
    this.#inFlight++;
    try {
      if (
        invocation.name === "wait" ||
        invocation.name === "zenx_fleet_tool_status"
      )
        return await this.#observe(invocation, sourceThreadId);
      if (invocation.name === "zenx_fleet_tools") {
        only(invocation.arguments, ["device", "workspace", "targetThreadId"]);
        const device = await this.#device(invocation.arguments.device);
        const workspaceId = string(invocation.arguments.workspace, "workspace");
        const targetThreadId = string(
          invocation.arguments.targetThreadId,
          "target Thread",
        );
        const catalog = await this.fleet.native.catalog(
          device,
          { sourceThreadId, workspaceId, targetThreadId },
          invocation.signal,
        );
        const disclosure: CatalogDisclosure = {
          source: "zenx.fleet.tools",
          device: device.id,
          deviceKey: fleetDeviceKey(device),
          sourceThreadId,
          workspaceId,
          targetThreadId,
          catalog,
        };
        const validated = parseDisclosure(
          disclosure as unknown as Record<string, unknown>,
        );
        return {
          output: JSON.stringify(validated),
          exitCode: 0,
          contentType: FLEET_CATALOG_CONTENT_TYPE,
          structuredContent: validated as unknown as JsonValue,
        };
      }
      if (invocation.name !== "zenx_fleet_execute")
        throw new Error("Unsupported Fleet tool route");
      const args = invocation.arguments;
      only(args, [
        "device",
        "workspace",
        "targetThreadId",
        "processEpoch",
        "toolGeneration",
        "deviceKey",
        "name",
        "arguments",
        "yield_time_ms",
        "timeout_ms",
        "max_output_bytes",
      ]);
      const device = await this.#device(args.device);
      const context = parseContext(args, true);
      if (context.deviceKey !== fleetDeviceKey(device))
        throw new Error(
          "Fleet target configuration changed since discovery; no operation was sent",
        );
      if (!record(args.arguments))
        throw new Error("Remote tool arguments must be an object");
      const name = string(args.name, "tool name");
      const admissionKey = createHash("sha256")
        .update(
          JSON.stringify([
            sourceThreadId,
            invocation.canonicalToolCallId ?? invocation.callId,
            device.hostId,
            context.processEpoch,
          ]),
        )
        .digest("hex");
      const createdAtMs = Date.now();
      const expiresAtMs = createdAtMs + 300000;
      const admissionId = `rt1:${createdAtMs}:${expiresAtMs}:${admissionKey}`;
      const maxOutputBytes = integer(
        args.max_output_bytes ?? invocation.task?.previewBytes,
        16384,
        REMOTE_TOOL_MAX_OUTPUT_BYTES,
      );
      const handle: Handle = {
        device: device.id,
        deviceKey: fleetDeviceKey(device),
        hostId: device.hostId,
        sourceThreadId,
        workspaceId: context.workspace,
        targetThreadId: context.targetThreadId,
        processEpoch: context.processEpoch,
        admissionId,
        maxOutputBytes,
      };
      let admitted = false;
      let observed: RemoteToolResult | undefined;
      let replayYieldTimeMs: number | undefined;
      try {
        let result = await this.fleet.native.execute(
          device,
          {
            processEpoch: context.processEpoch,
            sourceThreadId,
            workspaceId: context.workspace,
            targetThreadId: context.targetThreadId,
            admissionId,
            createdAtMs,
            expiresAtMs,
            name,
            toolGeneration: context.toolGeneration,
            arguments: args.arguments,
            yieldTimeMs: integer(
              args.yield_time_ms ?? invocation.task?.yieldTimeMs,
              10000,
              REMOTE_TOOL_MAX_YIELD_MS,
            ),
            timeoutMs: integer(
              args.timeout_ms ?? invocation.task?.timeoutMs,
              REMOTE_TOOL_MAX_TIMEOUT_MS,
              REMOTE_TOOL_MAX_TIMEOUT_MS,
            ),
            maxOutputBytes,
          },
          invocation.signal,
        );
        admitted = true;
        observed = result;
        if (invocation.task?.waitForCompletion === true) {
          const output: string[] = [result.output];
          let bytes = Buffer.byteLength(result.output);
          let truncated = result.sourceTruncated;
          while (["admitting", "queued", "running"].includes(result.status)) {
            replayYieldTimeMs = REMOTE_TOOL_MAX_YIELD_MS;
            result = await this.fleet.native.wait(
              device,
              {
                processEpoch: context.processEpoch,
                sourceThreadId,
                workspaceId: context.workspace,
                targetThreadId: context.targetThreadId,
                admissionId,
                taskId: result.taskId,
                ackCursor: result.cursor,
                yieldTimeMs: REMOTE_TOOL_MAX_YIELD_MS,
                maxOutputBytes,
              },
              invocation.signal,
            );
            observed = result;
            replayYieldTimeMs = undefined;
            const remaining = maxOutputBytes - bytes;
            const chunk = Buffer.from(result.output);
            const captured = utf8Prefix(chunk, Math.max(0, remaining));
            output.push(captured.toString("utf8"));
            bytes += captured.length;
            truncated ||=
              result.sourceTruncated || chunk.length > captured.length;
          }
          result = {
            ...result,
            output: output.join(""),
            sourceTruncated: truncated,
          };
        }
        return receipt(handle, result);
      } catch (error) {
        if (
          !admitted &&
          (error instanceof NativeFleetRejectedError ||
            (record(error) && error.confirmedRejection === true))
        )
          throw error;
        // A transport failure may follow admission. Supply the exact read-only
        // recovery address, never replay this mutation or guess cancellation.
        const taskId = encodeHandle({
          ...handle,
          ...(observed
            ? { taskId: observed.taskId, cursor: observed.cursor }
            : {}),
          ...(replayYieldTimeMs === undefined ? {} : { replayYieldTimeMs }),
        });
        throw new Error(
          `Fleet tool ${admitted ? "observation after admission" : "admission"} is unconfirmed: ${describe(error)}. Observe this same operation with zenx_fleet_tool_status or wait; do not rerun the mutation. task_id: ${taskId}`,
          { cause: error },
        );
      }
    } finally {
      this.#inFlight--;
    }
  }

  async #observe(
    invocation: ToolInvocation,
    sourceThreadId: string,
  ): Promise<ToolExecutionResult> {
    const isStatus = invocation.name === "zenx_fleet_tool_status";
    only(
      invocation.arguments,
      isStatus ? ["task_id"] : ["task_id", "yield_time_ms", "terminate"],
    );
    const handle = decodeHandle(invocation.arguments.task_id);
    if (handle.sourceThreadId !== sourceThreadId)
      throw new Error("Fleet task belongs to another source Thread");
    const device = await this.#device(handle.device);
    if (
      device.hostId !== handle.hostId ||
      fleetDeviceKey(device) !== handle.deviceKey
    )
      throw new Error(
        "Fleet task target configuration changed; no other Host was substituted",
      );
    const binding = {
      processEpoch: handle.processEpoch,
      sourceThreadId,
      workspaceId: handle.workspaceId,
      targetThreadId: handle.targetThreadId,
      admissionId: handle.admissionId,
    };
    if (isStatus) {
      const result = await this.fleet.native.status(
        device,
        { ...binding, ...(handle.taskId ? { taskId: handle.taskId } : {}) },
        invocation.signal,
      );
      return {
        output: JSON.stringify({
          ...result,
          task_id: encodeHandle({ ...handle, taskId: result.taskId }),
        }),
        exitCode: 0,
      };
    }
    let taskId = handle.taskId;
    if (!taskId) {
      const status = await this.fleet.native.status(
        device,
        binding,
        invocation.signal,
      );
      taskId = status.taskId;
    }
    const terminate = invocation.arguments.terminate ?? false;
    if (typeof terminate !== "boolean")
      throw new Error("wait.terminate must be a boolean");
    const yieldTimeMs =
      handle.replayYieldTimeMs ??
      integer(
        invocation.arguments.yield_time_ms,
        10000,
        REMOTE_TOOL_MAX_YIELD_MS,
      );
    try {
      const result = await this.fleet.native.wait(
        device,
        {
          ...binding,
          taskId,
          ...(handle.cursor ? { ackCursor: handle.cursor } : {}),
          yieldTimeMs,
          maxOutputBytes: handle.maxOutputBytes ?? REMOTE_TOOL_MAX_OUTPUT_BYTES,
          terminate,
        },
        invocation.signal,
      );
      return receipt(handle, result);
    } catch (error) {
      const taskId = encodeHandle({
        ...handle,
        replayYieldTimeMs: yieldTimeMs,
      });
      throw new Error(
        `Fleet task observation is unavailable: ${describe(error)}. Reobserve the same task; do not rerun its mutation. task_id: ${taskId}`,
        { cause: error },
      );
    }
  }

  async #device(id: unknown): Promise<NativeFleetDevice> {
    const value = string(id, "device");
    if (value === "local")
      throw new Error("Use the ordinary local tool for this Host");
    const device = (await readFleetConfig(this.fleet.file)).devices.find(
      (entry) => entry.id === value,
    );
    if (!device) throw new Error(`Unknown Fleet device: ${value}`);
    if (device.transport !== "https")
      throw new Error(
        "This SSH bridge does not expose generic target-owned tools; no SSH fallback is supported",
      );
    if (device.access !== "control" || device.toolsEnabled !== true)
      throw new Error(
        "Generic Fleet tools require a separate explicit tools grant; shell and control grants do not include it",
      );
    return device;
  }
}

function receipt(
  handle: Handle,
  result: RemoteToolResult,
): ToolExecutionResult {
  if (
    result.origin.hostId !== handle.hostId ||
    result.origin.processEpoch !== handle.processEpoch ||
    result.origin.workspaceId !== handle.workspaceId ||
    result.origin.threadId !== handle.targetThreadId ||
    result.admissionId !== handle.admissionId
  )
    throw new Error(
      "Remote tool result origin does not match its execution target",
    );
  const { replayYieldTimeMs: _replayedYield, ...observedHandle } = handle;
  const taskId = encodeHandle({
    ...observedHandle,
    taskId: result.taskId,
    cursor: result.cursor,
  });
  const terminal = ["completed", "failed", "timed_out", "cancelled"].includes(
    result.status,
  );
  return {
    output: `${result.output}\n[remote tool task ${result.status}]\nhost: ${handle.hostId}\npaths: remote-host\ntask_id: ${taskId}`,
    exitCode: result.exitCode,
    contentType: TOOL_TASK_CONTENT_TYPE,
    structuredContent: {
      status: result.status,
      task_id: taskId,
      tool_name: result.origin.toolName,
      lifetime: "host_instance",
      origin: result.origin as unknown as JsonValue,
      paths: result.paths,
      exit_code: terminal ? result.exitCode : null,
      ...(result.structuredContent === undefined
        ? {}
        : {
            result: result.structuredContent,
            result_content_type: result.contentType!,
          }),
    },
    sourceTruncated: result.sourceTruncated,
  };
}
export function isFleetToolHandle(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(HANDLE_PREFIX);
}
function encodeHandle(handle: Handle): string {
  return (
    HANDLE_PREFIX + Buffer.from(JSON.stringify(handle)).toString("base64url")
  );
}
function decodeHandle(value: unknown): Handle {
  if (!isFleetToolHandle(value) || value.length > 8192)
    throw new Error("Invalid Fleet tool task handle");
  let raw: unknown;
  try {
    raw = JSON.parse(
      Buffer.from(value.slice(HANDLE_PREFIX.length), "base64url").toString(
        "utf8",
      ),
    );
  } catch {
    throw new Error("Invalid Fleet tool task handle");
  }
  if (!record(raw)) throw new Error("Invalid Fleet tool task handle");
  only(raw, [
    "device",
    "deviceKey",
    "hostId",
    "sourceThreadId",
    "workspaceId",
    "targetThreadId",
    "processEpoch",
    "admissionId",
    "maxOutputBytes",
    "replayYieldTimeMs",
    "taskId",
    "cursor",
  ]);
  for (const key of [
    "device",
    "deviceKey",
    "hostId",
    "sourceThreadId",
    "workspaceId",
    "targetThreadId",
    "processEpoch",
    "admissionId",
  ])
    string(raw[key], key);
  if (raw.maxOutputBytes !== undefined)
    integer(raw.maxOutputBytes, 16384, REMOTE_TOOL_MAX_OUTPUT_BYTES);
  if (raw.replayYieldTimeMs !== undefined)
    integer(raw.replayYieldTimeMs, 10000, REMOTE_TOOL_MAX_YIELD_MS);
  if (raw.taskId !== undefined) string(raw.taskId, "taskId", 2048);
  if (raw.cursor !== undefined) string(raw.cursor, "cursor", 2048);
  return raw as unknown as Handle;
}
function parseContext(
  value: Record<string, unknown>,
  allowFacade = false,
): TargetContext {
  if (!allowFacade)
    only(value, [
      "workspace",
      "targetThreadId",
      "processEpoch",
      "toolGeneration",
      "deviceKey",
    ]);
  return {
    workspace: string(value.workspace, "workspace"),
    deviceKey: string(value.deviceKey, "deviceKey"),
    targetThreadId: string(value.targetThreadId, "targetThreadId"),
    processEpoch: string(value.processEpoch, "processEpoch"),
    toolGeneration: string(value.toolGeneration, "toolGeneration"),
  };
}
function parseDisclosure(value: Record<string, unknown>): CatalogDisclosure {
  only(value, [
    "source",
    "device",
    "deviceKey",
    "sourceThreadId",
    "workspaceId",
    "targetThreadId",
    "catalog",
  ]);
  if (
    value.source !== "zenx.fleet.tools" ||
    Buffer.byteLength(JSON.stringify(value), "utf8") >
      MAX_CATALOG_DISCLOSURE_BYTES
  )
    throw new Error("Invalid or oversized Fleet catalog disclosure");
  return {
    source: "zenx.fleet.tools",
    device: string(value.device, "device"),
    deviceKey: string(value.deviceKey, "deviceKey"),
    sourceThreadId: string(value.sourceThreadId, "sourceThreadId"),
    workspaceId: string(value.workspaceId, "workspaceId"),
    targetThreadId: string(value.targetThreadId, "targetThreadId"),
    catalog: parseRemoteToolCatalogResult(value.catalog),
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: string[]) {
  for (const key of Object.keys(value))
    if (!keys.includes(key))
      throw new Error(`Unexpected Fleet routing argument: ${key}`);
}
function string(value: unknown, name: string, max = 512): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    /[\u0000-\u001f]/u.test(value)
  )
    throw new Error(`Invalid Fleet ${name}`);
  return value;
}
function integer(value: unknown, fallback: number, max: number): number {
  const number = value ?? fallback;
  if (
    !Number.isSafeInteger(number) ||
    typeof number !== "number" ||
    number < 1 ||
    number > max
  )
    throw new Error(`Fleet timing/output bound must be 1..${max}`);
  return number;
}
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
const targetContextSchema = {
  type: "object",
  properties: {
    workspace: { type: "string" },
    deviceKey: { type: "string" },
    targetThreadId: { type: "string" },
    processEpoch: { type: "string" },
    toolGeneration: { type: "string" },
  },
  required: [
    "workspace",
    "deviceKey",
    "targetThreadId",
    "processEpoch",
    "toolGeneration",
  ],
  additionalProperties: false,
};
