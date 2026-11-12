import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
export type PublicationPhase = "temporary" | "published" | "synced";
export const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
export async function assertOwnedFile(
  filename: string,
  allowHardlinks = false,
): Promise<void> {
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || (!allowHardlinks && stat.nlink !== 1))
      throw new Error(
        `Storage file must be an unaliased regular file: ${filename}`,
      );
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
export async function syncDirectory(directory: string): Promise<void> {
  // Windows Node does not expose directory fsync. File data is still fsynced.
  if (process.platform === "win32") return;
  const file = await open(directory, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
/** Every failure may be outcome-unknown; caller must reconcile before retry. */
export async function replaceFile(
  filename: string,
  bytes: Uint8Array,
  onPhase?: (phase: PublicationPhase) => void | Promise<void>,
  allowHardlinks = false,
): Promise<void> {
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true });
  await assertOwnedFile(filename, allowHardlinks);
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.${randomUUID()}.tmp`,
  );
  const file = await open(temporary, "wx", 0o600);
  let closed = false;
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    closed = true;
    await onPhase?.("temporary");
    await rename(temporary, filename);
    await onPhase?.("published");
    await syncDirectory(directory);
    await onPhase?.("synced");
  } finally {
    if (!closed) await file.close();
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}
