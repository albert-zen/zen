import { unwrapQueueMutationIpcReply } from "../../preload/queue-edit-ipc.js";
import type {
  NativeQueueSteerParams,
  NativeQueueSteerResult,
} from "../../../../../src/protocol/native/wire.js";
import {
  QueueMutationUnknownError,
  queuedSteerReceipt,
} from "./queue-mutation-state.js";
import { i18n } from "./i18n.js";

/** Read a canonical receipt after transport ambiguity. Never cancel or resubmit. */
export async function requestQueuedSteer(
  params: NativeQueueSteerParams,
  onRecovered?: () => void,
): Promise<NativeQueueSteerResult> {
  // Keep recovery tied to the dispatched identity even if the caller reuses
  // its request object while this asynchronous operation is outstanding.
  params = { ...params };
  try {
    const result = unwrapQueueMutationIpcReply(
      await window.zenx.protocol.request("zen/thread/queue/steer", params),
    );
    if (
      result?.queuedItemId !== params.queuedItemId ||
      result.clientId !== params.clientId ||
      !["staged", "steered", "started", "already_started"].includes(
        result.status,
      ) ||
      typeof result.turnId !== "string" ||
      !result.turnId.trim() ||
      (result.status === "staged" &&
        (result.revision !== params.expectedRevision + 1 ||
          typeof result.promotionItemId !== "string" ||
          !result.promotionItemId.trim()))
    )
      throw new Error(i18n.t("shell:queueSteerUnconfirmed"));
    return result;
  } catch (error) {
    const code = (error as { data?: { zenCode?: unknown } } | null)?.data
      ?.zenCode;
    if (typeof code === "string") {
      const key =
        code === "queue_revision_conflict"
          ? "shell:queueSteerConflict"
          : ["queue_cancelled", "queue_not_found", "thread_not_found"].includes(
                code,
              )
            ? "shell:queueSteerNoLongerPending"
            : "shell:queueSteerRejected";
      throw new Error(i18n.t(key), { cause: error });
    }
    try {
      return await checkQueuedSteer(params, onRecovered);
    } catch {
      throw new QueueMutationUnknownError(
        i18n.t("shell:queueSteerUnconfirmed"),
        { cause: error },
      );
    }
  }
}

/** A manual check is read-only, never a second promotion. */
export async function checkQueuedSteer(
  params: NativeQueueSteerParams,
  onRecovered?: () => void,
): Promise<NativeQueueSteerResult> {
  try {
    const { thread } = await window.zenx.protocol.request("zen/thread/read", {
      threadId: params.threadId,
    });
    if (thread.id !== params.threadId)
      throw new Error("Mismatched recovery Thread");
    onRecovered?.();
    const receipt = queuedSteerReceipt(params, thread.items);
    if (receipt) return receipt;
  } catch {
    /* An unreadable Thread cannot prove delivery. */
  }
  throw new QueueMutationUnknownError(i18n.t("shell:queueSteerUnconfirmed"));
}
