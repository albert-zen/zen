import { localErrorDetail } from "../local-error-detail.js";

const type = "zenx.question-error.v1";
// Deliberately excludes question_state_unavailable: it can occur after admission.
const rejected = new Set([
  // Native DTO validation and question identity/schema checks precede admission.
  "invalid_request",
  "question_not_found",
  // Exact question state/idempotency checks run inside the pre-append fence.
  "question_already_answered",
  "question_response_pending",
  "idempotency_conflict",
  "queue_id_cancelled",
]);

/** Plain diagnostics survive both Electron boundaries; absence is never rejection. */
export interface QuestionIpcError {
  type: typeof type;
  outcome: "rejected" | "unknown";
  code?: string;
  message: string;
  detail: string;
}
export function questionIpcError(error: unknown): QuestionIpcError {
  const record = error as {
    message?: unknown;
    data?: { zenCode?: unknown };
  } | null;
  const code =
    typeof record?.data?.zenCode === "string" ? record.data.zenCode : undefined;
  return {
    type,
    outcome: code !== undefined && rejected.has(code) ? "rejected" : "unknown",
    ...(code === undefined ? {} : { code }),
    message:
      typeof record?.message === "string" ? record.message : String(error),
    detail: localErrorDetail(error),
  };
}
export function unwrapQuestionIpcReply<T>(reply: T | QuestionIpcError): T {
  if (
    typeof reply === "object" &&
    reply !== null &&
    "type" in reply &&
    reply.type === type
  ) {
    const error = reply as QuestionIpcError;
    throw Object.assign(new Error(error.message), {
      // Recheck allowlist after serialization; unknown codes cannot enable a new send.
      questionRejected:
        error.outcome === "rejected" &&
        error.code !== undefined &&
        rejected.has(error.code),
      localDiagnosticDetail: error.detail,
    });
  }
  return reply as T;
}
