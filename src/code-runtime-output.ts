import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import {
  capturedToolOutput,
  toolOutputSuffix,
  type ToolExecutionResult,
} from "./tool.js";

export const MAX_PROGRAM_OUTPUT_BYTES = 1024 * 1024;

export interface ProgramOutputInfo {
  complete: boolean;
  capturedBytes: number;
  sourceTruncated: boolean;
  reason?: "program_limit" | "source_truncated" | "unavailable";
  fullOutput?: { path: string; sha256: string; lifetime: "host_instance" };
}

/** Project host capture into program data; model receipts remain a separate projection. */
export async function programToolResult(result: ToolExecutionResult): Promise<
  Omit<ToolExecutionResult, "output"> & {
    output: string | null;
    outputInfo: ProgramOutputInfo;
    diagnostic?: string;
  }
> {
  const capture = capturedToolOutput(result);
  const capturedBytes =
    capture?.capturedBytes ?? Buffer.byteLength(result.output);
  const sourceTruncated =
    capture?.sourceTruncated === true || result.sourceTruncated === true;
  const info: ProgramOutputInfo = {
    complete: false,
    capturedBytes,
    sourceTruncated,
    ...(capture?.path === undefined
      ? {}
      : {
          fullOutput: {
            path: capture.path,
            sha256: capture.sha256,
            lifetime: capture.lifetime,
          },
        }),
  };
  let output: string | null = null;
  if (sourceTruncated) info.reason = "source_truncated";
  else if (capturedBytes > MAX_PROGRAM_OUTPUT_BYTES)
    info.reason = "program_limit";
  else if (capture === undefined) output = result.output;
  else if (capture.output !== undefined) output = capture.output;
  else if (capture.path === undefined) info.reason = "unavailable";
  else {
    try {
      const file = await open(capture.path, "r");
      try {
        // Bound the read even if the temporary file changed after capture.
        const buffer = Buffer.alloc(capturedBytes + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await file.read(
            buffer,
            offset,
            buffer.length - offset,
            offset,
          );
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        const bytes = buffer.subarray(0, offset);
        if (
          offset !== capturedBytes ||
          createHash("sha256").update(bytes).digest("hex") !== capture.sha256
        ) {
          info.reason = "unavailable";
        } else output = bytes.toString("utf8");
      } finally {
        await file.close();
      }
    } catch {
      output = null;
      info.reason = "unavailable";
    }
  }
  info.complete = output !== null;
  const diagnostic = toolOutputSuffix(result);
  return {
    ...result,
    output,
    outputInfo: info,
    ...(diagnostic === undefined || diagnostic.length === 0
      ? {}
      : { diagnostic }),
  };
}
