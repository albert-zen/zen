import type { ContextCompactionStatusEvent } from "../../../../../src/app-server.js";
import type { ComposerState } from "./composer-state.js";
import { i18n } from "./i18n.js";

/** Only live native observations; no prediction, retry or canonical success synthesis. */
export function applyCompactionStatus(
  state: ComposerState,
  event: ContextCompactionStatusEvent,
  observation?: { processEpoch: string; watermark: number },
): ComposerState {
  if (
    observation !== undefined &&
    state.compactionObservation !== undefined &&
    (observation.processEpoch !== state.compactionObservation.processEpoch ||
      observation.watermark <= state.compactionObservation.watermark)
  )
    return state;
  if (
    event.phase !== "pending" &&
    state.compactionRequest !== undefined &&
    state.compaction?.status === "pending" &&
    state.compaction.operationId === undefined
  )
    return state;
  if (
    event.phase !== "pending" &&
    state.compaction?.operationId !== undefined &&
    state.compaction.operationId !== event.operationId
  )
    return state;
  if (
    event.phase === "pending" &&
    state.compaction?.operationId === event.operationId
  )
    return state;
  const phase = event.phase;
  const message =
    phase === "pending"
      ? i18n.t(
          event.initiator === "automatic"
            ? "shell:automaticCompactionPending"
            : "shell:explicitCompactionPending",
        )
      : phase === "committed"
        ? i18n.t("shell:contextCompacted")
        : phase === "unknown"
          ? i18n.t("shell:compactionOutcomeUnknown")
          : phase === "cancelled"
            ? i18n.t("shell:compactionCancelledNotCommitted")
            : i18n.t("shell:compactionFailedNotCommitted");
  const reason = i18n.t(`shell:compactionCause.${event.trigger.reason}`);
  return {
    ...state,
    ...(observation === undefined
      ? {}
      : {
          compactionObservation: {
            processEpoch: observation.processEpoch,
            watermark: observation.watermark,
          },
        }),
    ...(event.phase === "pending" &&
    event.trigger.reason === "explicit_request" &&
    state.compactionRequest !== undefined &&
    state.compactionRequest.operationId === undefined
      ? {
          compactionRequest: {
            ...state.compactionRequest,
            operationId: event.operationId,
          },
        }
      : {}),
    ...(event.phase === "committed" &&
    event.compactionItemId !== undefined &&
    state.compactionRequest?.operationId === event.operationId
      ? {
          compactionRequest: {
            ...state.compactionRequest,
            observedCommitItemId: event.compactionItemId,
          },
        }
      : {}),
    compaction: {
      operationId: event.operationId,
      startedAfterItemId: event.startedAfterItemId,
      ...(event.compactionItemId === undefined
        ? {}
        : { compactionItemId: event.compactionItemId }),
      ...(event.phase === "unknown" ? { outcomeUnknown: true } : {}),
      coveredThroughItemId: event.coveredThroughItemId,
      status:
        phase === "pending"
          ? "pending"
          : phase === "committed"
            ? "succeeded"
            : "failed",
      message: `${message} · ${reason}`,
      ...(phase === "committed"
        ? {}
        : {
            detail: [
              reason,
              event.error?.message,
              JSON.stringify(
                {
                  ...event.trigger,
                  contextWindow: event.contextWindow,
                  triggerPercent: event.triggerPercent,
                  targetPercent: event.targetPercent,
                  agenticEnabled: event.agenticEnabled,
                },
                null,
                2,
              ),
            ]
              .filter(Boolean)
              .join("\n\n"),
          }),
    },
  };
}

/** Disconnect retires a live observation, not the underlying operation. */
export function markCompactionOutcomeUnknown(
  state: ComposerState,
): ComposerState {
  const { compactionObservation: _retired, ...withoutCursor } = state;
  if (
    state.compaction?.status !== "pending" ||
    state.compaction.operationId === undefined
  )
    return state.compactionObservation === undefined ? state : withoutCursor;
  return {
    ...withoutCursor,
    compaction: {
      ...state.compaction,
      status: "failed",
      outcomeUnknown: true,
      message: i18n.t("shell:compactionOutcomeUnknown"),
    },
  };
}
