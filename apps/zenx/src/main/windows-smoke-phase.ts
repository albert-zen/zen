import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

// One smoke process publishes sequential stages; the probe directory is private
// to that run and its existing harness cleanup removes all retained snapshots.
let generation = 0n;

/** Fixture-only snapshot publication; never replay the UIA operation on failure. */
export async function publishWindowsSmokePhase(
  directory: string,
  phase: string,
): Promise<string> {
  const identity = `${(++generation).toString().padStart(20, "0")}-${randomUUID()}`;
  const temporary = path.join(directory, `.phase-${identity}`);
  const snapshot = path.join(directory, `phase-${identity}.snapshot`);
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(phase, "utf8");
    await handle.close();
    // Windows cannot replace an open destination even with delete sharing.
    // Publish to a fresh name; readers only enumerate completed snapshots and
    // never block publication or see an in-place partial write.
    await rename(temporary, snapshot);
    return snapshot;
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
  }
}
