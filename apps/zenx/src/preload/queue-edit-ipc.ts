import { localErrorDetail } from "../local-error-detail.js";
import type { CompactionIpcReply } from "./compaction-ipc.js";
import type {
  NativeQueueSteerResult,
  NativeQueueEditResult,
} from "../../../../src/protocol/native/wire.js";
import type {
  ClientRequestMethod,
  ClientRequestResults,
} from "../protocol-client/types.js";

const unknownType = "zenx.queue-outcome-unknown.v1";
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

/** Local reply: preserve diagnostics as data; only known codes control recovery. */
export interface QueueEditIpcRejection {
  type: typeof rejectionType;
  data: { zenCode: string };
  message?: string;
  detail?: string;
}
export interface QueueIpcUnknown {
  type: typeof unknownType;
  message: string;
  detail: string;
}
export function queueIpcUnknown(error: unknown): QueueIpcUnknown {
  return {
    type: unknownType,
    message:
      isRecord(error) && typeof error.message === "string"
        ? error.message
        : String(error),
    detail: localErrorDetail(error),
  };
}
export type QueueEditIpcReply =
  NativeQueueEditResult | QueueEditIpcRejection | QueueIpcUnknown;
export type ProtocolIpcResult<M extends ClientRequestMethod> =
  M extends "thread/compact"
    ? CompactionIpcReply
    : M extends "zen/thread/queue/edit"
      ? QueueEditIpcReply
      : M extends "zen/thread/queue/steer"
        ? NativeQueueSteerResult | QueueEditIpcRejection | QueueIpcUnknown
        : ClientRequestResults[M];

export function queueEditIpcRejection(
  error: unknown,
): QueueEditIpcRejection | undefined {
  const data = isRecord(error) && isRecord(error.data) ? error.data : undefined;
  const code = data?.zenCode;
  return typeof code === "string" && knownCodes.has(code)
    ? {
        type: rejectionType,
        data: { zenCode: code },
        detail: localErrorDetail(error),
        ...(isRecord(error) && typeof error.message === "string"
          ? { message: error.message }
          : {}),
      }
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
>(reply: T | QueueEditIpcRejection | QueueIpcUnknown): T {
  if (isRecord(reply) && reply.type === unknownType) {
    // No rejection code: callers must retain read-only receipt recovery, never resend.
    throw Object.assign(
      new Error(
        typeof reply.message === "string"
          ? reply.message
          : "Queue operation outcome is unconfirmed.",
      ),
      {
        localDiagnosticDetail: reply.detail,
      },
    );
  }
  if (isRecord(reply) && reply.type === rejectionType) {
    const safe = queueEditIpcRejection(reply);
    if (safe === undefined)
      throw new Error("Queue operation outcome is unconfirmed.");
    throw Object.assign(
      new Error(safe.message ?? "Queued message operation was rejected."),
      {
        data: safe.data,
        localDiagnosticDetail: reply.detail,
      },
    );
  }
  return reply as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
