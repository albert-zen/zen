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
  compact(threadId: string): Promise<unknown>;
}

/** Handles the composer command before any turn, queue, steer, or replacement. */
export async function handleCompactCommand(options: {
  threadId: string | null;
  active: boolean;
  read(): ComposerState;
  update(change: (state: ComposerState) => ComposerState): void;
  compact(threadId: string): Promise<unknown>;
}): Promise<boolean> {
  const state = options.read();
  if (state.compaction?.status === "pending") return true;
  if (!isCompactCommand(state.draft.text)) return false;
  if (state.submission?.status === "pending") return true;
  const error =
    state.draft.text.trim() !== "/compact"
      ? "Use /compact on its own, without arguments."
      : state.draft.images.length > 0
        ? "Remove attachments before compacting context."
        : options.threadId === null
          ? "There is no conversation to compact yet."
          : options.active
            ? "Wait for the current reply to finish before compacting context."
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
      ? "There is no conversation to compact yet."
      : options.active
        ? "Wait for the current reply to finish before compacting context."
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
    message: "Compacting context…",
  };
  options.update((current) => ({
    ...current,
    submission: null,
    compaction: pending,
  }));
  try {
    await options.compact(options.threadId!);
    options.update((current) =>
      current.compaction !== pending
        ? current
        : {
            ...current,
            draft:
              options.clearCommandDraft && current.draft === state.draft
                ? { text: "", images: [] }
                : current.draft,
            compaction: { status: "succeeded", message: "Context compacted." },
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
      ? `Request rejected by the service (code: ${code}). Original exception text is withheld to protect private data.`
      : "The desktop request returned an error; whether compaction took effect is unknown. Check the conversation before trying again. Original exception text is withheld to protect private data.";
  if (code === "thread_busy")
    return {
      message:
        "Wait for the current reply to finish before compacting context.",
      detail,
    };
  if (code === "compaction_not_available")
    return {
      message: "There is no new completed conversation to compact.",
      detail,
    };
  return {
    message:
      "Could not confirm this compaction request. Check the conversation before trying again.",
    detail,
  };
}
