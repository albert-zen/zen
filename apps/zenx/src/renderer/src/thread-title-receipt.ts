import type {
  ThreadTitleProjection,
  ThreadTitleSnapshot,
} from "../../main/thread-title-types.js";

/** A command receipt may arrive after a newer authoritative title notification. */
export function applyThreadTitleReceipt(
  current: ThreadTitleSnapshot,
  projection: ThreadTitleProjection,
): ThreadTitleSnapshot {
  const previous = current[projection.threadId];
  if (previous !== undefined && previous.version > projection.version)
    return current;
  return { ...current, [projection.threadId]: projection };
}
