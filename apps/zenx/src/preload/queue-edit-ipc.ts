import type {
  NativeQueueSteerResult,
  NativeQueueEditResult,
} from "../../../../src/protocol/native/wire.js";
import type {
  ClientRequestMethod,
  ClientRequestResults,
} from "../protocol-client/types.js";

const rejectionType = "zenx.queue-edit-rejection.v1";
const knownCodes = new Set([
  "queue_not_found",
  "queue_already_started",
  "queue_cancelled",
  "thread_not_found",
  "queue_revision_conflict",
  "idempotency_conflict",
  "queue_edit_unsupported_input",
  "invalid_request",
  "invalid_input",
  "image_input_unsupported",
  "attachment_missing",
  "attachment_corrupt",
  "attachment_invalid",
  "attachment_too_large",
  "attachment_dimensions_exceeded",
  "attachment_mime_mismatch",
  "provider_unavailable",
  "model_unavailable",
  "context_window_unknown",
  "reasoning_effort_unknown",
  "reasoning_effort_unavailable",
  "operation_forbidden",
]);

/** Private Electron reply: only safe codes cross IPC and contextBridge as data. */
export interface QueueEditIpcRejection {
  type: typeof rejectionType;
  data: { zenCode: string };
}
export type QueueEditIpcReply = NativeQueueEditResult | QueueEditIpcRejection;
export type ProtocolIpcResult<M extends ClientRequestMethod> =
  M extends "zen/thread/queue/edit"
    ? QueueEditIpcReply
    : M extends "zen/thread/queue/steer"
      ? NativeQueueSteerResult | QueueEditIpcRejection
      : ClientRequestResults[M];

export function queueEditIpcRejection(
  error: unknown,
): QueueEditIpcRejection | undefined {
  const data = isRecord(error) && isRecord(error.data) ? error.data : undefined;
  const code = data?.zenCode;
  return typeof code === "string" && knownCodes.has(code)
    ? { type: rejectionType, data: { zenCode: code } }
    : undefined;
}

/** Run in the renderer, after both Electron serialization boundaries. */
export function unwrapQueueEditIpcReply(
  reply: QueueEditIpcReply,
): NativeQueueEditResult {
  return unwrapQueueMutationIpcReply(reply);
}

export function unwrapQueueMutationIpcReply<
  T extends NativeQueueEditResult | NativeQueueSteerResult,
>(reply: T | QueueEditIpcRejection): T {
  if (isRecord(reply) && reply.type === rejectionType) {
    const safe = queueEditIpcRejection(reply);
    if (safe === undefined)
      throw new Error("Queue operation outcome is unconfirmed.");
    throw Object.assign(new Error("Queued message operation was rejected."), {
      data: safe.data,
    });
  }
  return reply as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
