import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { ModelStreamDiagnostic } from "../../../src/model/openai-compatible.js";

/** Host-owned failure diagnostics; bounded received payload context; no request headers or bodies. */
export function createModelDiagnosticWriter(directory: string) {
  let pending = Promise.resolve();
  const filename = path.join(directory, "model-stream-errors.jsonl");
  return (event: ModelStreamDiagnostic): Promise<void> => {
    const line = JSON.stringify(event) + "\n";
    const write = pending.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const size = await stat(filename).then(
        (value) => value.size,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return 0;
          throw error;
        },
      );
      if (size + Buffer.byteLength(line) > 5 * 1024 * 1024) {
        await rename(filename, filename + ".1");
      }
      await appendFile(filename, line, { mode: 0o600 });
    });
    pending = write.catch(() => undefined);
    return write;
  };
}
