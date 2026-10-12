import type { JsonValue } from "./item.js";

export const TOOL_TASK_CONTENT_TYPE = "application/vnd.zen.tool-task+json";

/**
 * A fixed Host control budget, separate from the original tool's JSON payload.
 * An 8 KiB ASCII qualified handle, seven 512-byte identity occurrences (at
 * most twice their UTF-8 size after JSON escaping), and fixed fields fit here.
 */
export const MAX_TOOL_TASK_CONTROL_BYTES = 16 * 1024;

/** Exact target-owned task receipts; arbitrary JSON cannot claim the control budget. */
export function validateTargetToolTaskEnvelope(
  content: JsonValue,
  exitCode: number,
): {
  control: Record<string, JsonValue>;
  payload?: { contentType: string; structuredContent: JsonValue };
} {
  const data = object(content);
  only(data, [
    "status",
    "task_id",
    "tool_name",
    "lifetime",
    "origin",
    "paths",
    "exit_code",
    "result",
    "result_content_type",
  ]);
  if (
    typeof data.status !== "string" ||
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
    ].includes(data.status)
  )
    fail("Invalid task status");
  boundedString(data.task_id, "task_id", 8192);
  boundedString(data.tool_name, "tool_name", 512);
  if (data.lifetime !== "host_instance" || data.paths !== "remote-host")
    fail("Invalid task lifetime or path origin");
  const terminal = ["completed", "failed", "timed_out", "cancelled"].includes(
    data.status,
  );
  if (
    terminal
      ? data.exit_code !== exitCode || !Number.isSafeInteger(data.exit_code)
      : data.exit_code !== null || exitCode !== 0
  )
    fail("Invalid task exit code");
  const origin = object(data.origin);
  const originKeys = [
    "hostId",
    "processEpoch",
    "workspaceId",
    "threadId",
    "toolName",
    "toolGeneration",
  ];
  only(origin, originKeys);
  // Native origin identities are currently capped at 256 UTF-8 bytes. This
  // 512-byte Host control bound preserves every legal Unicode wire identity.
  for (const key of originKeys) boundedString(origin[key], key, 512);
  if (origin.toolName !== data.tool_name) fail("Task tool origin mismatch");
  const hasResult = Object.hasOwn(data, "result");
  if (hasResult !== Object.hasOwn(data, "result_content_type"))
    fail("Task payload requires both result and result_content_type");
  const { result, ...control } = data;
  if (!hasResult) return { control };
  const contentType = data.result_content_type;
  if (typeof contentType !== "string")
    fail("Invalid task payload content type");
  return { control, payload: { contentType, structuredContent: result! } };
}

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("Expected a task control object");
  return value as Record<string, JsonValue>;
}

function only(
  data: Record<string, JsonValue>,
  allowed: readonly string[],
): void {
  if (Object.keys(data).some((key) => !allowed.includes(key)))
    fail("Unexpected task control field");
}

function boundedString(
  value: JsonValue | undefined,
  name: string,
  max: number,
): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    new TextEncoder().encode(value).length > max
  )
    fail(`Invalid bounded task ${name}`);
}

function fail(message: string): never {
  throw new Error(message);
}
