import { i18n } from "./i18n.js";
import type { ComposerState } from "./composer-state.js";

export function isCompactCommand(text: string): boolean {
  return /^\/compact(?:\s|$)/u.test(text.trim());
}

export interface ContextCompactionRequest {
  threadId: string | null;
  active: boolean;
  clearCommandDraft: boolean;
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
  const pending = {
    status: "pending" as const,
    message: i18n.t("common:compacting"),
  };
  options.update((current) => ({
    ...current,
    submission: null,
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
    options.update((current) =>
      current.compaction !== pending
        ? current
        : {
            ...current,
            draft:
              options.clearCommandDraft && current.draft === state.draft
                ? { text: "", images: [] }
                : current.draft,
            compaction: {
              status: "succeeded",
              message: i18n.t("common:compacted"),
            },
          },
    );
  } catch (reason) {
    options.update((current) =>
      current.compaction !== pending
        ? current
        : {
            ...current,
            compaction: { status: "failed", ...compactError(reason) },
          },
    );
  }
}

function compactError(reason: unknown): { message: string; detail: string } {
  // Do not infer a semantic error code from Electron's free-form IPC message.
  // Only a preserved typed code is authoritative. Never render raw rejection text:
  // it may include provider output, credentials, or a private conversation.
  const value = reason !== null && typeof reason === "object" ? reason : null;
  const code =
    value !== null && "code" in value && typeof value.code === "string"
      ? value.code
      : value !== null &&
          "zenCode" in value &&
          typeof value.zenCode === "string"
        ? value.zenCode
        : null;
  const detail =
    code === "thread_busy" || code === "compaction_not_available"
      ? i18n.t("common:compactRejected", { code })
      : i18n.t("common:compactUnknown");
  if (code === "thread_busy")
    return {
      message: i18n.t("common:compactWait"),
      detail,
    };
  if (code === "compaction_not_available")
    return {
      message: i18n.t("common:compactNoNew"),
      detail,
    };
  return {
    message: i18n.t("common:compactUnconfirmed"),
    detail,
  };
}
