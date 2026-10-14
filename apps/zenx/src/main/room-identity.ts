import type { TriggerSnapshot } from "./trigger-types.js";

/** Model identity changes use Host invocation identity, never model arguments. */
export function assertPawRenameScope(
  snapshot: Pick<TriggerSnapshot, "rooms" | "history">,
  id: string,
  callingThreadId: string | undefined,
): void {
  const target = snapshot.rooms.find((room) => room.id === id);
  if (target?.assistant) {
    // Only the Host-supplied canonical Thread is identity authority.
    // Model arguments, matching cwd, and fork ancestry grant no binding.
    if (!callingThreadId || target.assistant.threadId !== callingThreadId)
      throw new Error("Only the bound PAW can change its own identity");
    const bound = snapshot.rooms.filter(
      (room) => room.assistant?.threadId === callingThreadId,
    );
    const sources = new Set(
      snapshot.history
        .filter(
          (entry) =>
            entry.threadId === callingThreadId &&
            (entry.status === "starting" || entry.status === "running") &&
            entry.sourceRoomId !== null,
        )
        .map((entry) => entry.sourceRoomId),
    );
    if (
      (sources.size > 0 && (sources.size !== 1 || !sources.has(id))) ||
      (sources.size === 0 && bound.length !== 1)
    )
      throw new Error("PAW identity requires an unambiguous current Room");
  }
}
