import type { ClientRequestResults } from "../../protocol-client/types.js";
import { unwrapQueueEditIpcReply } from "../../preload/queue-edit-ipc.js";
import type {
  NativeQueueEditParams,
  NativeQueueEditResult,
} from "../../../../../src/protocol/native/wire.js";
import { pendingQueuedMessages } from "../../../../../src/input-queue.js";
import { i18n } from "./i18n.js";

/** Recover an uncertain edit by reading its immutable receipt, never by resending. */
export async function requestQueuedEdit(
  params: NativeQueueEditParams,
  onRecoveredThread?: (result: ClientRequestResults["zen/thread/read"]) => void,
): Promise<NativeQueueEditResult> {
  try {
    return unwrapQueueEditIpcReply(
      await window.zenx.protocol.request("zen/thread/queue/edit", params),
    );
  } catch (error) {
    // Known native rejections are definite failures, not uncertain transport.
    const data =
      typeof error === "object" && error !== null && "data" in error
        ? error.data
        : undefined;
    const code =
      typeof data === "object" && data !== null && "zenCode" in data
        ? data.zenCode
        : undefined;
    const key = rejectedEditMessage(code);
    if (key !== null) throw new Error(i18n.t(key));
    let message = i18n.t("shell:queueEditUnconfirmed");
    try {
      const recovered = await window.zenx.protocol.request("zen/thread/read", {
        threadId: params.threadId,
      });
      const { thread } = recovered;
      if (thread.id !== params.threadId)
        throw new Error("Mismatched recovery thread");
      onRecoveredThread?.(recovered);
      const receipt = thread.items.find(
        (item) =>
          item.type === "user_message_queue_edited" &&
          item.threadId === params.threadId &&
          item.editId === params.editId &&
          item.queuedItemId === params.queuedItemId &&
          item.clientId === params.clientId &&
          item.revision === params.expectedRevision + 1 &&
          JSON.stringify(item.input) === JSON.stringify(params.input),
      );
      if (receipt?.type === "user_message_queue_edited")
        return {
          status: "already_edited",
          queuedItemId: params.queuedItemId,
          clientId: params.clientId,
          revision: receipt.revision,
          editItemId: receipt.id,
        };
      const current = pendingQueuedMessages(thread.items).find(
        (item) =>
          item.id === params.queuedItemId && item.clientId === params.clientId,
      );
      if (!current) message = i18n.t("shell:queueEditNoLongerPending");
      else if (current.revision !== params.expectedRevision)
        message = i18n.t("shell:queueEditConflict");
    } catch {
      /* A failed read cannot establish the edit outcome. */
    }
    throw new Error(message);
  }
}

/** Uses the existing typed import boundary without touching the main Composer. */
export async function importQueuedImages(files: readonly File[]) {
  return await window.zenx.imageAttachments.import(
    await Promise.all(
      files.map(async (file) => ({
        name: file.name,
        mediaType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    ),
  );
}

function rejectedEditMessage(
  code: unknown,
):
  | "shell:queueEditNoLongerPending"
  | "shell:queueEditConflict"
  | "shell:queueEditUnsupported"
  | "shell:queueEditInvalid"
  | "shell:queueEditImagesUnsupported"
  | "shell:queueEditAttachmentUnavailable"
  | "shell:queueEditModelUnavailable"
  | "shell:queueEditForbidden"
  | null {
  switch (code) {
    case "queue_not_found":
    case "queue_already_started":
    case "queue_cancelled":
    case "thread_not_found":
      return "shell:queueEditNoLongerPending";
    case "queue_revision_conflict":
    case "idempotency_conflict":
      return "shell:queueEditConflict";
    case "queue_edit_unsupported_input":
      return "shell:queueEditUnsupported";
    case "invalid_request":
    case "invalid_input":
      return "shell:queueEditInvalid";
    case "image_input_unsupported":
      return "shell:queueEditImagesUnsupported";
    case "attachment_missing":
    case "attachment_corrupt":
    case "attachment_invalid":
    case "attachment_too_large":
    case "attachment_dimensions_exceeded":
    case "attachment_mime_mismatch":
      return "shell:queueEditAttachmentUnavailable";
    case "provider_unavailable":
    case "model_unavailable":
    case "context_window_unknown":
    case "reasoning_effort_unknown":
    case "reasoning_effort_unavailable":
      return "shell:queueEditModelUnavailable";
    case "operation_forbidden":
      return "shell:queueEditForbidden";
    default:
      return null;
  }
}
