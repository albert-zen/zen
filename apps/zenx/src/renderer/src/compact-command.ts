import { localErrorDetail } from "../../local-error-detail.js";
import { i18n } from "./i18n.js";
import type { ComposerState } from "./composer-state.js";

export function isCompactCommand(text: string): boolean {
  return /^\/compact(?:\s|$)/u.test(text.trim());
}

export interface ContextCompactionRequest {
  threadId: string | null;
  active: boolean;
  clearCommandDraft: boolean;
  refresh?(): Promise<void>;
  read(): ComposerState;
  update(change: (state: ComposerState) => ComposerState): void;
  compact(
    threadId: string,
    includeOriginalReference: boolean,
  ): Promise<unknown>;
}

/** Handles the composer command before any turn, queue, steer, or replacement. */
export async function handleCompactCommand(options: {
  threadId: string | null;
  active: boolean;
  refresh?(): Promise<void>;
  read(): ComposerState;
  update(change: (state: ComposerState) => ComposerState): void;
  compact(
    threadId: string,
    includeOriginalReference: boolean,
  ): Promise<unknown>;
}): Promise<boolean> {
  const state = options.read();
  if (state.compaction?.status === "pending") return true;
  if (!isCompactCommand(state.draft.text)) return false;
  if (state.submission?.status === "pending") return true;
  const error = !["/compact", "/compact --no-reference"].includes(
    state.draft.text.trim(),
  )
    ? i18n.t("common:compactArguments")
    : state.draft.images.length > 0
      ? i18n.t("common:compactAttachments")
      : options.threadId === null
        ? i18n.t("common:compactNoConversation")
        : options.active
          ? i18n.t("common:compactWait")
          : null;
  if (error !== null) {
    options.update((current) => ({
      ...current,
      compaction: { status: "failed", message: error },
    }));
    return true;
  }
  await requestContextCompaction({
    ...options,
    clearCommandDraft: true,
  });
  return true;
}

/** Shared executor for slash commands and explicit context UI actions. */
export async function requestContextCompaction(
  options: ContextCompactionRequest,
): Promise<void> {
  const state = options.read();
  if (
    state.compaction?.status === "pending" ||
    state.submission?.status === "pending"
  )
    return;
  const error =
    options.threadId === null
      ? i18n.t("common:compactNoConversation")
      : options.active
        ? i18n.t("common:compactWait")
        : null;
  if (error !== null) {
    options.update((current) => ({
      ...current,
      compaction: { status: "failed", message: error },
    }));
    return;
  }
  const requestToken = {};
  const pending = {
    status: "pending" as const,
    message: i18n.t("common:compacting"),
  };
  options.update((current) => ({
    ...current,
    submission: null,
    compactionRequest: { token: requestToken },
    compaction: pending,
  }));
  try {
    await options.compact(
      options.threadId!,
      !(
        options.clearCommandDraft &&
        state.draft.text.trim() === "/compact --no-reference"
      ),
    );
    let refreshFailure: string | undefined;
    try {
      await options.refresh?.();
    } catch (reason) {
      refreshFailure = localErrorText(reason);
    }
    options.update((current) => {
      if (current.compactionRequest?.token !== requestToken) return current;
      const { compactionRequest: _settled, ...rest } = current;
      return {
        ...rest,
        draft:
          options.clearCommandDraft &&
          current.draftRevision === state.draftRevision &&
          current.draft === state.draft
            ? { text: "", images: [] }
            : current.draft,
        compaction: hasOtherNativeCompaction(current)
          ? current.compaction
          : {
              status: "succeeded",
              message: i18n.t(
                refreshFailure === undefined
                  ? "common:compacted"
                  : "common:compactedRefreshFailed",
              ),
              ...(refreshFailure === undefined
                ? {}
                : { detail: refreshFailure }),
            },
      };
    });
  } catch (reason) {
    options.update((current) => {
      if (current.compactionRequest?.token !== requestToken) return current;
      const observedCommit = current.compactionRequest.observedCommitItemId;
      const failure = compactError(reason);
      const { compactionRequest: _settled, ...rest } = current;
      return {
        ...rest,
        compaction: hasOtherNativeCompaction(current)
          ? current.compaction
          : observedCommit === undefined || !failure.outcomeUnknown
            ? { status: "failed", ...failure }
            : {
                status: "succeeded",
                message: i18n.t("common:compacted"),
                detail: localErrorText(reason),
              },
      };
    });
  }
}

/** A late local reply may settle its own draft, never another native operation. */
function hasOtherNativeCompaction(state: ComposerState): boolean {
  return (
    state.compaction?.operationId !== undefined &&
    state.compaction.operationId !== state.compactionRequest?.operationId
  );
}

function compactError(reason: unknown): {
  message: string;
  detail: string;
  outcomeUnknown: boolean;
} {
  // Typed service codes determine outcome. Free-form provider/transport text is
  // local diagnostic evidence, never a source of inferred commit status.
  const value = reason !== null && typeof reason === "object" ? reason : null;
  const data =
    value !== null &&
    "data" in value &&
    typeof value.data === "object" &&
    value.data !== null
      ? value.data
      : null;
  const code =
    data !== null && "zenCode" in data && typeof data.zenCode === "string"
      ? data.zenCode
      : value !== null &&
          "zenCode" in value &&
          typeof value.zenCode === "string"
        ? value.zenCode
        : value !== null && "code" in value && typeof value.code === "string"
          ? value.code
          : null;
  const original = localErrorText(reason);
  const detail = [code, original].filter(Boolean).join("\n");
  if (code === "thread_busy")
    return {
      message: i18n.t("common:compactWait"),
      detail,
      outcomeUnknown: false,
    };
  if (code === "compaction_not_available")
    return {
      message: i18n.t("common:compactNoNew"),
      detail,
      outcomeUnknown: false,
    };
  // These service failures are raised before the compaction record is appended.
  const notApplied = new Set([
    "compaction_generation_failed",
    "compaction_boundary_changed",
    "compaction_invalid_summary",
    "compaction_incomplete_turn",
    "compaction_invalid_options",
    "compaction_budget_unavailable",
    "compaction_budget_exceeded",
    "compaction_aborted",
  ]);
  if (code !== null && notApplied.has(code))
    return {
      message: i18n.t("common:compactFailedNotApplied"),
      detail,
      outcomeUnknown: false,
    };
  return {
    message: i18n.t("common:compactUnconfirmed"),
    outcomeUnknown: true,
    detail: `${i18n.t("common:compactUnknown")}\n\n${detail}`,
  };
}

function localErrorText(reason: unknown): string {
  return localErrorDetail(reason);
}
