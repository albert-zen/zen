import { StringDecoder } from "node:string_decoder";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type PawOperation = "list" | "read" | "post";
export type PawRequest = (
  operation: PawOperation,
  params: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

/** Private child-pipe transport only; Room services own admission and history. */
export function attachPawPipe(
  child: ChildProcessWithoutNullStreams,
  request: PawRequest,
  isCurrent: () => boolean,
): () => void {
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  let active = true;
  let pending = 0;
  const send = (value: object) => {
    if (!active || !isCurrent() || child.stdin.destroyed) return;
    const line = JSON.stringify(value);
    if (Buffer.byteLength(line) > 1024 * 1024) {
      const id = (value as { id: string }).id;
      child.stdin.write(
        JSON.stringify({
          type: "paw-response",
          id,
          error: "PAW response exceeds transport limit",
        }) + "\n",
      );
    } else child.stdin.write(line + "\n");
  };
  const receive = (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > 1024 * 1024) {
      buffer = "";
      child.kill();
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || value.type !== "paw-request") continue;
      const { id, operation, params } = value;
      if (typeof id !== "string" || id.length > 128) continue;
      const response = { type: "paw-response", id };
      if (
        !["list", "read", "post"].includes(String(operation)) ||
        !params ||
        typeof params !== "object" ||
        Array.isArray(params)
      ) {
        send({ ...response, error: "Invalid PAW request" });
        continue;
      }
      if (pending >= 16) {
        send({ ...response, error: "PAW transport busy; retry later" });
        continue;
      }
      if (!active || !isCurrent()) continue;
      pending++;
      void request(operation as PawOperation, params as Record<string, unknown>)
        .then(
          (result) => send({ ...response, result }),
          (error) =>
            send({
              ...response,
              error:
                error instanceof Error ? error.message : "PAW request failed",
            }),
        )
        .finally(() => pending--);
    }
  };
  child.stdout.on("data", receive);
  return () => {
    active = false;
    child.stdout.off("data", receive);
  };
}
