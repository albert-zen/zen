import { unwrapQueueMutationIpcReply } from "../../preload/queue-edit-ipc.js";
import type {
  NativeQueueReorderParams,
  NativeQueueReorderResult,
} from "../../../../../src/protocol/native/wire.js";
import {
  QueueMutationUnknownError,
  queuedReorderReceipt,
} from "./queue-mutation-state.js";
import { i18n } from "./i18n.js";

export async function checkQueuedReorder(
  params: NativeQueueReorderParams,
  onRecovered?: () => void,
): Promise<NativeQueueReorderResult> {
  try {
    const { thread } = await window.zenx.protocol.request("zen/thread/read", {
      threadId: params.threadId,
    });
    if (thread.id !== params.threadId)
      throw new Error("Mismatched recovery Thread");
    onRecovered?.();
    const receipt = queuedReorderReceipt(params, thread.items);
    if (receipt) return receipt;
  } catch {
    /* Absence or read failure never proves rejection. */
  }
  throw new QueueMutationUnknownError(i18n.t("shell:queueReorderUnconfirmed"));
}

export async function requestQueuedReorder(
  params: NativeQueueReorderParams,
  onRecovered?: () => void,
): Promise<NativeQueueReorderResult> {
  params = structuredClone(params);
  try {
    const result = unwrapQueueMutationIpcReply(
      await window.zenx.protocol.request("zen/thread/queue/reorder", params),
    );
    if (
      !["reordered", "already_reordered"].includes(result?.status) ||
      typeof result.reorderItemId !== "string" ||
      !result.reorderItemId.trim()
    )
      throw new Error("Invalid queue reorder receipt");
    return result;
  } catch (error) {
    const code = (error as { data?: { zenCode?: unknown } } | null)?.data
      ?.zenCode;
    if (typeof code === "string")
      throw new Error(i18n.t("shell:queueReorderConflict"), { cause: error });
    try {
      return await checkQueuedReorder(params, onRecovered);
    } catch {
      throw new QueueMutationUnknownError(
        i18n.t("shell:queueReorderUnconfirmed"),
        { cause: error },
      );
    }
  }
}
