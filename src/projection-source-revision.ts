import { lstat } from "node:fs/promises";

/** A disposable display-cache invalidation token, never a source-integrity or dispatch proof. */
export async function projectionFileRevision(
  filename: string,
): Promise<string> {
  try {
    const stat = await lstat(filename, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n)
      throw new Error(
        `Projection source must be an unaliased regular file: ${filename}`,
      );
    return [
      stat.dev,
      stat.ino,
      stat.mode,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ].join(":");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return "missing";
    throw error;
  }
}
