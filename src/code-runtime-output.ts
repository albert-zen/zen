import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolveBuiltinTaskReference } from "./builtin-model-handles.js";
import { trustedModelReferenceBindings } from "./model-references.js";
import { TOOL_TASK_CONTENT_TYPE } from "./tool-task-content.js";
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
  Omit<ToolExecutionResult, "output" | "referenceBindings"> & {
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
  const { referenceBindings: _hostOnlyReferences, ...programResult } = result;
  const task = result.structuredContent;
  if (
    result.contentType === TOOL_TASK_CONTENT_TYPE &&
    task &&
    typeof task === "object" &&
    !Array.isArray(task) &&
    "task_id" in task &&
    typeof task.task_id === "string"
  ) {
    const matching = (trustedModelReferenceBindings(result) ?? []).filter(
      (binding) =>
        binding.ref.startsWith("t") &&
        resolveBuiltinTaskReference(binding.ownerThreadId, binding.ref, [
          binding,
        ]) === task.task_id,
    );
    if (matching.length > 1)
      throw new Error("Conflicting builtin task result references");
    if (matching[0])
      programResult.structuredContent = { ...task, task_id: matching[0].ref };
  }
  // Reserved first-party discovery authority is a Host-only annotation, not program data.
  // Never recursively rewrite user output or arbitrary structured JSON fields.
  if (result.contentType === "zen/fleet-tool-catalog-disclosure") {
    delete programResult.contentType;
    delete programResult.structuredContent;
  }
  return {
    ...programResult,
    output,
    outputInfo: info,
    ...(diagnostic === undefined || diagnostic.length === 0
      ? {}
      : { diagnostic }),
  };
}
