import type { ClientRequestResults } from "../protocol-client/types.js";

const rejectionType = "zenx.compaction-rejection.v1";
/** Local diagnostic data survives both Electron boundaries; it is not an export. */
export interface CompactionIpcRejection {
  type: typeof rejectionType;
  message: string;
  zenCode?: string;
}
export type CompactionIpcReply =
  ClientRequestResults["thread/compact"] | CompactionIpcRejection;

export function compactionIpcRejection(
  reason: unknown,
): CompactionIpcRejection {
  const value = record(reason);
  const code = record(value?.data)?.zenCode ?? value?.zenCode ?? value?.code;
  return {
    type: rejectionType,
    message:
      typeof value?.message === "string"
        ? value.message
        : typeof reason === "string"
          ? reason
          : String(reason),
    ...(typeof code === "string" ? { zenCode: code } : {}),
  };
}

/** Decode in the renderer, not preload: contextBridge strips thrown Error fields. */
export function unwrapCompactionIpcReply(
  reply: CompactionIpcReply,
): ClientRequestResults["thread/compact"] {
  if (record(reply)?.type === rejectionType) {
    const failure = reply as CompactionIpcRejection;
    throw Object.assign(new Error(failure.message), {
      zenCode: failure.zenCode,
    });
  }
  if (
    typeof record(reply)?.compactionItemId !== "string" ||
    !(reply as ClientRequestResults["thread/compact"]).compactionItemId.trim()
  ) {
    throw new Error(
      "Compaction reply did not contain a committed compaction receipt.",
    );
  }
  return reply as ClientRequestResults["thread/compact"];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
