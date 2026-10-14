import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

/** Fixture-only snapshot publication; never replay the UIA operation on failure. */
export async function publishWindowsSmokePhase(
  directory: string,
  phase: string,
) {
  const temporary = path.join(directory, `.phase-${randomUUID()}`);
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(phase, "utf8");
    await handle.close();
    // The native sampler shares deletion, so an open reader keeps the complete
    // old snapshot while later readers see this complete replacement.
    await rename(temporary, path.join(directory, "phase"));
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
  }
}
