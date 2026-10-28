import { unwrapQueueMutationIpcReply } from "../../preload/queue-edit-ipc.js";
import type {
  NativeQueueSteerParams,
  NativeQueueSteerResult,
} from "../../../../../src/protocol/native/wire.js";
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
      !["steered", "started", "already_started"].includes(result.status) ||
      typeof result.turnId !== "string" ||
      !result.turnId.trim()
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
      const { thread } = await window.zenx.protocol.request("zen/thread/read", {
        threadId: params.threadId,
      });
      if (thread.id !== params.threadId)
        throw new Error("Mismatched recovery Thread");
      onRecovered?.();
      const original = thread.items.find(
        (item) =>
          (item.type === "user_message_queued" ||
            item.type === "thread_message_queued" ||
            item.type === "host_message_queued") &&
          item.threadId === params.threadId &&
          item.id === params.queuedItemId &&
          item.clientId === params.clientId,
      );
      const delivered =
        original &&
        thread.items.find(
          (item) =>
            (item.type === "user_message" ||
              item.type === "thread_message" ||
              item.type === "host_message") &&
            `${item.type}_queued` === original.type &&
            item.threadId === params.threadId &&
            item.clientId === params.clientId,
        );
      if (
        delivered &&
        typeof delivered.turnId === "string" &&
        delivered.turnId.trim()
      )
        return {
          queuedItemId: params.queuedItemId,
          clientId: params.clientId,
          status: "already_started",
          turnId: delivered.turnId,
        };
    } catch {
      /* An unreadable Thread cannot prove delivery. */
    }
    throw new Error(i18n.t("shell:queueSteerUnconfirmed"), { cause: error });
  }
}
