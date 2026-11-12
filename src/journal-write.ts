import type { FileHandle } from "node:fs/promises";

/** Complete one serialized journal payload before the caller syncs or publishes it. */
export async function writeJournalPayload(
  file: FileHandle,
  text: string,
): Promise<void> {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(
      bytes,
      offset,
      bytes.length - offset,
      null,
    );
    if (bytesWritten < 1) throw new Error("Journal write made no progress");
    offset += bytesWritten;
  }
}
