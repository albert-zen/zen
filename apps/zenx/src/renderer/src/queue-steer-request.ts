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
  try {
    return unwrapQueueMutationIpcReply(
      await window.zenx.protocol.request("zen/thread/queue/steer", params),
    );
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
      throw new Error(i18n.t(key));
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
            item.threadId === params.threadId &&
            item.clientId === params.clientId,
        );
      if (delivered && delivered.turnId !== undefined)
        return {
          queuedItemId: params.queuedItemId,
          clientId: params.clientId,
          status: "already_started",
          turnId: delivered.turnId,
        };
    } catch {
      /* An unreadable Thread cannot prove delivery. */
    }
    throw new Error(i18n.t("shell:queueSteerUnconfirmed"));
  }
}
