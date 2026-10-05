/** Native generic-tool wire. No Host runtime or Node imports, including on mobile. */
import type { ModelTool } from "../../model.js";
import type { JsonValue } from "../../item.js";
import type { ToolBundleIdentity } from "../../tool-identity.js";

export const REMOTE_TOOL_VERSION = 1;
export const REMOTE_TOOL_CAPABILITY = "tools-v1";
export const REMOTE_TOOL_MAX_ARGUMENT_BYTES = 48 * 1024;
export const REMOTE_TOOL_MAX_OUTPUT_BYTES = 64 * 1024;
export const REMOTE_TOOL_MAX_STRUCTURED_BYTES = 1024 * 1024;
export const REMOTE_TOOL_MAX_TIMEOUT_MS = 120_000;
export const REMOTE_TOOL_MAX_YIELD_MS = 30_000;
export const REMOTE_TOOL_MAX_ADMISSION_WINDOW_MS = 300_000;

/** Immutable acceptance bounds are embedded in the opaque admission identity. */
export function makeRemoteToolAdmissionId(
  createdAtMs: number,
  expiresAtMs: number,
  opaqueId: string,
): string {
  integer(createdAtMs, "createdAtMs", Number.MAX_SAFE_INTEGER, 0);
  integer(expiresAtMs, "expiresAtMs", Number.MAX_SAFE_INTEGER, 0);
  if (
    expiresAtMs <= createdAtMs ||
    expiresAtMs - createdAtMs > REMOTE_TOOL_MAX_ADMISSION_WINDOW_MS
  )
    fail("Invalid admission acceptance window");
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(opaqueId))
    fail("Invalid opaque admission identity");
  return `rt1:${createdAtMs}:${expiresAtMs}:${opaqueId}`;
}

export interface RemoteToolBinding {
  version: 1;
  hostId: string;
  processEpoch: string;
  sourceThreadId: string;
  workspaceId: string;
  targetThreadId: string;
}
export interface RemoteToolCatalogRequest extends RemoteToolBinding {}
export interface RemoteToolDefinition {
  owner: ToolBundleIdentity;
  definition: ModelTool;
  generation: string;
  eligible: boolean;
  reason?: string;
}
export interface RemoteToolCatalogResult {
  version: 1;
  hostId: string;
  processEpoch: string;
  tools: RemoteToolDefinition[];
}
export interface RemoteToolExecuteRequest extends RemoteToolBinding {
  admissionId: string;
  /** Acceptance window is part of the exact payload, preventing expired ID reuse. */
  createdAtMs: number;
  expiresAtMs: number;
  name: string;
  toolGeneration: string;
  arguments: Record<string, unknown>;
  yieldTimeMs: number;
  timeoutMs: number;
  maxOutputBytes: number;
}
export interface RemoteToolWaitRequest extends RemoteToolBinding {
  admissionId: string;
  taskId: string;
  /** Acknowledge this receipt and request the next; omission replays current output. */
  ackCursor?: string;
  yieldTimeMs: number;
  maxOutputBytes: number;
  terminate?: boolean;
}
export type RemoteToolCancelRequest = Omit<RemoteToolWaitRequest, "terminate">;
export interface RemoteToolStatusRequest extends RemoteToolBinding {
  admissionId: string;
  taskId?: string;
}
export type RemoteToolStatus =
  | "admitting"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancel_requested"
  | "cancellation_unconfirmed"
  | "cancelled";
export interface RemoteToolOrigin {
  hostId: string;
  processEpoch: string;
  workspaceId: string;
  threadId: string;
  toolName: string;
  toolGeneration: string;
}
export interface RemoteToolResult {
  origin: RemoteToolOrigin;
  admissionId: string;
  taskId: string;
  status: RemoteToolStatus;
  /** Ephemeral acknowledgement cursor; never a durable recovery token. */
  cursor: string;
  output: string;
  exitCode: number;
  contentType?: string;
  structuredContent?: JsonValue;
  sourceTruncated: boolean;
  /** Paths in text/JSON retain their origin and must never be opened as local files. */
  paths: "remote-host";
}
export interface RemoteToolStatusResult {
  origin: RemoteToolOrigin;
  admissionId: string;
  taskId: string;
  status: RemoteToolStatus;
  cursor: string | null;
  outputAvailable: boolean;
  expiresAtMs: number;
}

const bindingKeys = [
  "version",
  "hostId",
  "processEpoch",
  "sourceThreadId",
  "workspaceId",
  "targetThreadId",
];
export function parseRemoteToolCatalogRequest(
  value: unknown,
): RemoteToolCatalogRequest {
  const data = record(value);
  keys(data, bindingKeys);
  binding(data);
  return value as RemoteToolCatalogRequest;
}
export function parseRemoteToolExecuteRequest(
  value: unknown,
): RemoteToolExecuteRequest {
  const data = record(value);
  keys(data, [
    ...bindingKeys,
    "admissionId",
    "createdAtMs",
    "expiresAtMs",
    "name",
    "toolGeneration",
    "arguments",
    "yieldTimeMs",
    "timeoutMs",
    "maxOutputBytes",
  ]);
  binding(data);
  for (const key of ["admissionId", "name", "toolGeneration"])
    string(data[key], key);
  integer(data.createdAtMs, "createdAtMs", Number.MAX_SAFE_INTEGER, 0);
  integer(data.expiresAtMs, "expiresAtMs", Number.MAX_SAFE_INTEGER, 0);
  if (
    Number(data.expiresAtMs) <= Number(data.createdAtMs) ||
    Number(data.expiresAtMs) - Number(data.createdAtMs) >
      REMOTE_TOOL_MAX_ADMISSION_WINDOW_MS
  )
    fail("Invalid admission acceptance window");
  const admission =
    typeof data.admissionId === "string"
      ? /^rt1:([0-9]+):([0-9]+):([A-Za-z0-9][A-Za-z0-9._~-]{0,127})$/u.exec(
          data.admissionId,
        )
      : null;
  if (
    admission === null ||
    Number(admission[1]) !== data.createdAtMs ||
    Number(admission[2]) !== data.expiresAtMs
  )
    fail("Admission ID must embed its immutable acceptance window");
  record(data.arguments);
  assertRemoteToolJson(data.arguments, REMOTE_TOOL_MAX_ARGUMENT_BYTES);
  timing(data, true);
  return value as RemoteToolExecuteRequest;
}
export function parseRemoteToolWaitRequest(
  value: unknown,
): RemoteToolWaitRequest {
  return parseWait(value, true) as RemoteToolWaitRequest;
}
export function parseRemoteToolCancelRequest(
  value: unknown,
): RemoteToolCancelRequest {
  return parseWait(value, false) as RemoteToolCancelRequest;
}
function parseWait(
  value: unknown,
  terminate: boolean,
): RemoteToolWaitRequest | RemoteToolCancelRequest {
  const data = record(value);
  keys(data, [
    ...bindingKeys,
    "admissionId",
    "taskId",
    "ackCursor",
    "yieldTimeMs",
    "maxOutputBytes",
    ...(terminate ? ["terminate"] : []),
  ]);
  binding(data);
  string(data.admissionId, "admissionId");
  string(data.taskId, "taskId", 1024);
  if (data.ackCursor !== undefined) string(data.ackCursor, "ackCursor", 1024);
  if (data.terminate !== undefined && typeof data.terminate !== "boolean")
    fail("terminate must be boolean");
  timing(data, false);
  return value as RemoteToolWaitRequest;
}
export function parseRemoteToolStatusRequest(
  value: unknown,
): RemoteToolStatusRequest {
  const data = record(value);
  keys(data, [...bindingKeys, "admissionId", "taskId"]);
  binding(data);
  string(data.admissionId, "admissionId");
  if (data.taskId !== undefined) string(data.taskId, "taskId", 1024);
  return value as RemoteToolStatusRequest;
}
export function parseRemoteToolCatalogResult(
  value: unknown,
): RemoteToolCatalogResult {
  const data = record(value);
  keys(data, ["version", "hostId", "processEpoch", "tools"]);
  if (data.version !== REMOTE_TOOL_VERSION) fail("Unsupported tool version");
  string(data.hostId, "hostId");
  string(data.processEpoch, "processEpoch");
  if (!Array.isArray(data.tools) || data.tools.length > 256)
    fail("Invalid tool catalog");
  for (const entry of data.tools as unknown[]) {
    const tool = record(entry);
    keys(tool, ["owner", "definition", "generation", "eligible", "reason"]);
    const owner = record(tool.owner);
    keys(owner, ["kind", "id"]);
    if (!["builtin", "plugin", "external"].includes(String(owner.kind)))
      fail("Invalid owner kind");
    string(owner.id, "owner.id");
    const definition = record(tool.definition);
    keys(definition, ["name", "description", "inputSchema", "rawSource"]);
    string(definition.name, "definition.name");
    if (typeof definition.description !== "string")
      fail("Invalid definition description");
    record(definition.inputSchema);
    if (definition.rawSource !== undefined) {
      const source = record(definition.rawSource);
      keys(source, ["language", "argument"]);
      if (source.language !== "javascript" || source.argument !== "code")
        fail("Invalid raw source");
    }
    string(tool.generation, "generation");
    if (typeof tool.eligible !== "boolean") fail("Invalid eligibility");
    if (tool.reason !== undefined) string(tool.reason, "reason", 4096);
  }
  assertRemoteToolJson(data, REMOTE_TOOL_MAX_STRUCTURED_BYTES);
  return value as RemoteToolCatalogResult;
}
export function parseRemoteToolResult(value: unknown): RemoteToolResult {
  const data = record(value);
  keys(data, [
    "origin",
    "admissionId",
    "taskId",
    "status",
    "cursor",
    "output",
    "exitCode",
    "contentType",
    "structuredContent",
    "sourceTruncated",
    "paths",
  ]);
  resultIdentity(data);
  string(data.cursor, "cursor", 1024);
  if (
    typeof data.output !== "string" ||
    byteLength(data.output) > REMOTE_TOOL_MAX_OUTPUT_BYTES
  )
    fail("Invalid output");
  if (!Number.isSafeInteger(data.exitCode)) fail("Invalid exitCode");
  if (typeof data.sourceTruncated !== "boolean" || data.paths !== "remote-host")
    fail("Invalid result origin contract");
  if (
    (data.contentType === undefined) !==
    (data.structuredContent === undefined)
  )
    fail("Invalid structured result");
  if (data.contentType !== undefined) {
    string(data.contentType, "contentType");
    assertRemoteToolJson(
      data.structuredContent,
      REMOTE_TOOL_MAX_STRUCTURED_BYTES,
    );
  }
  return value as RemoteToolResult;
}
export function parseRemoteToolStatusResult(
  value: unknown,
): RemoteToolStatusResult {
  const data = record(value);
  keys(data, [
    "origin",
    "admissionId",
    "taskId",
    "status",
    "cursor",
    "outputAvailable",
    "expiresAtMs",
  ]);
  resultIdentity(data);
  if (data.cursor !== null) string(data.cursor, "cursor", 1024);
  if (typeof data.outputAvailable !== "boolean")
    fail("Invalid outputAvailable");
  integer(data.expiresAtMs, "expiresAtMs", Number.MAX_SAFE_INTEGER, 0);
  return value as RemoteToolStatusResult;
}
function resultIdentity(data: Record<string, unknown>): void {
  const origin = record(data.origin);
  keys(origin, [
    "hostId",
    "processEpoch",
    "workspaceId",
    "threadId",
    "toolName",
    "toolGeneration",
  ]);
  for (const key of [
    "hostId",
    "processEpoch",
    "workspaceId",
    "threadId",
    "toolName",
    "toolGeneration",
  ])
    string(origin[key], key);
  string(data.admissionId, "admissionId");
  string(data.taskId, "taskId", 1024);
  if (
    ![
      "admitting",
      "queued",
      "running",
      "completed",
      "failed",
      "timed_out",
      "cancel_requested",
      "cancellation_unconfirmed",
      "cancelled",
    ].includes(String(data.status))
  )
    fail("Invalid tool status");
}
function binding(data: Record<string, unknown>): void {
  if (data.version !== REMOTE_TOOL_VERSION) fail("Unsupported tool version");
  for (const key of bindingKeys.slice(1)) string(data[key], key);
}
function timing(data: Record<string, unknown>, execute: boolean): void {
  integer(data.yieldTimeMs, "yieldTimeMs", REMOTE_TOOL_MAX_YIELD_MS);
  integer(data.maxOutputBytes, "maxOutputBytes", REMOTE_TOOL_MAX_OUTPUT_BYTES);
  if (execute) integer(data.timeoutMs, "timeoutMs", REMOTE_TOOL_MAX_TIMEOUT_MS);
}
function integer(value: unknown, name: string, max: number, min = 1): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    fail(`${name} must be an integer from ${min} to ${max}`);
}
function string(value: unknown, name: string, max = 256): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    byteLength(value) > max
  )
    fail(`${name} must be a bounded non-empty string`);
}
function record(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail("Expected a JSON object");
  return value as Record<string, unknown>;
}
function keys(data: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(data).some((key) => !allowed.includes(key)))
    fail("Unexpected request or response field");
}
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
function fail(message: string): never {
  throw new TypeError(message);
}
/** Bounded, finite, plain JSON only; no media objects, handles or executable values. */
export function assertRemoteToolJson(
  value: unknown,
  maxBytes: number,
): asserts value is JsonValue {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 32) fail("JSON exceeds structural limits");
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean"
    )
      return;
    if (typeof entry === "number" && Number.isFinite(entry)) return;
    if (typeof entry !== "object" || seen.has(entry as object))
      fail("Value is not finite acyclic JSON");
    const object = entry as object;
    seen.add(object);
    if (Array.isArray(entry)) {
      for (let index = 0; index < entry.length; index++) {
        if (!(index in entry)) fail("Sparse JSON array");
        visit(entry[index], depth + 1);
      }
    } else {
      const data = record(entry);
      for (const child of Object.values(data)) visit(child, depth + 1);
    }
    seen.delete(object);
  };
  visit(value, 0);
  if (byteLength(JSON.stringify(value)) > maxBytes)
    fail("JSON exceeds byte limit");
}
