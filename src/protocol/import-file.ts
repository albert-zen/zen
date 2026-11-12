import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { MAX_THREAD_IMPORT_BYTES } from "../thread-import.js";

export async function readSelectedImportFile(
  filePath: string,
): Promise<string> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Select a regular JSONL file.");
    if (stat.size > MAX_THREAD_IMPORT_BYTES)
      throw new Error("Import exceeds the 16 MiB limit.");
    const bytes = Buffer.alloc(
      Math.min(stat.size + 1, MAX_THREAD_IMPORT_BYTES + 1),
    );
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > stat.size)
      throw new Error(
        "The selected file changed while reading; select a stable export.",
      );
    if (offset !== stat.size)
      throw new Error("The selected file was truncated while reading.");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, offset),
    );
  } finally {
    await handle.close();
  }
}
