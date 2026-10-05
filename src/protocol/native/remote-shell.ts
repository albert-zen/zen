import { randomUUID } from "node:crypto";
import {
  capturedToolOutput,
  ToolEnvironment,
  ToolOutputWindow,
  type PreparedToolInvocation,
  type ToolExecutionResult,
} from "../../tool.js";
import { TOOL_TASK_CONTENT_TYPE } from "../../tool-task-content.js";
import { RemoteHostError, type RemoteShellPort } from "./remote-host.js";
import type { ThreadSnapshot } from "../../app-server.js";
import type { RemoteShellRequest, RemoteShellResult } from "./remote-wire.js";

/** One bounded shell call through the target's existing execution/admission environment. */
export class FleetShellGateway implements RemoteShellPort {
  constructor(readonly tools: ToolEnvironment) {}

  async execute(
    request: RemoteShellRequest,
    resolveTarget: () => Promise<ThreadSnapshot>,
    signal: AbortSignal,
  ): Promise<RemoteShellResult> {
    const target = await resolveTarget();
    const controller = new AbortController();
    const executionSignal = AbortSignal.any([signal, controller.signal]);
    const callId = `fleet-shell:${randomUUID()}`;
    const prepared = this.tools.prepare({
      callId,
      name: "shell",
      arguments: { command: request.command },
      cwd: target.cwd,
      sandbox: target.sandbox,
      threadId: target.id,
      outputAudience: "program",
      signal: executionSignal,
      task: {
        timeoutMs: request.timeoutMs,
        previewBytes: request.maxOutputBytes,
        waitForCompletion: true,
      },
    });
    let executed = false;
    try {
      // Normal full-access admission may skip the name policy store. A target's
      // remembered denial must still win over a remote caller in every mode.
      const remembered = await this.tools.admitInherited(prepared);
      if (remembered !== "accept")
        throw new RemoteHostError(
          "operation_forbidden",
          "Shell is denied by the target Host's remembered tool policy",
        );
      try {
        const decision = await this.tools.admit(prepared, {
          policy:
            target.approvalPolicy === "never" ? "full_access" : "ask_unknown",
          approvalRequest: {
            threadId: target.id,
            turnId: callId,
            itemId: callId,
            callId,
            toolName: "shell",
            toolArguments: prepared.invocation.arguments,
            command: request.command,
            cwd: target.cwd,
            signal: executionSignal,
          },
          // There is no target UI route for standalone Fleet shell approval.
          // Never answer an unknown approval from the calling Host.
        });
        if (decision !== "accept" && decision !== "acceptForSession")
          throw new RemoteHostError("operation_forbidden");
      } catch (error) {
        if (
          error instanceof RemoteHostError ||
          executionSignal.aborted ||
          !(error instanceof Error) ||
          !/approval/i.test(error.message)
        )
          throw error;
        throw new RemoteHostError(
          "approval_required",
          "Approve shell on the target Host before retrying. Fleet shell cannot answer target approval requests.",
        );
      }
      const current = await resolveTarget();
      if (
        current.id !== target.id ||
        current.cwd !== target.cwd ||
        current.sandbox !== target.sandbox ||
        current.approvalPolicy !== target.approvalPolicy
      )
        throw new RemoteHostError("stale_thread");
      executionSignal.throwIfAborted();
      executed = true;
      let result = await this.tools.execute(prepared);
      const output = new ToolOutputWindow(request.maxOutputBytes, undefined);
      let truncated = false;
      const capture = (value: ToolExecutionResult) => {
        const captured = capturedToolOutput(value);
        if (captured) {
          if (captured.output !== undefined) output.write(captured.output);
          else {
            // Head/tail previews may overlap, especially when a small capture's
            // spool is unavailable. Count the captured bytes rather than repeat
            // the overlapping suffix or equate every file receipt with truncation.
            const head = Buffer.from(captured.head);
            const tail = Buffer.from(captured.tail);
            const overlap = Math.max(
              0,
              head.length + tail.length - captured.capturedBytes,
            );
            const preview = Buffer.concat([
              head,
              tail.subarray(Math.min(overlap, tail.length)),
            ]);
            output.write(preview.toString("utf8"));
            truncated ||= preview.length < captured.capturedBytes;
          }
          truncated ||= captured.sourceTruncated;
        } else output.write(value.output);
        truncated ||= value.sourceTruncated === true;
      };
      capture(result);
      const cleanup = AbortSignal.timeout(5_000);
      let status: RemoteShellResult["status"] = "completed";
      while (result.contentType === TOOL_TASK_CONTENT_TYPE) {
        const rawReceipt = result.structuredContent;
        if (
          rawReceipt === null ||
          typeof rawReceipt !== "object" ||
          Array.isArray(rawReceipt)
        )
          throw new RemoteHostError("operation_unknown");
        const receipt = rawReceipt as Readonly<Record<string, unknown>>;
        if (receipt.status === "timed_out" || receipt.status === "cancelled") {
          status = receipt.status;
          break;
        }
        if (receipt.status === "completed" || receipt.status === "failed")
          break;
        if (typeof receipt.task_id !== "string")
          throw new RemoteHostError("operation_unknown");
        // Drain this existing shell task until cancellation is confirmed. This
        // never re-admits/replays the command and never runs a target Agent turn.
        result = await this.tools.waitRuntime.execute({
          callId,
          name: "wait",
          arguments: { task_id: receipt.task_id, yield_time_ms: 1000 },
          cwd: target.cwd,
          threadId: target.id,
          signal: cleanup,
        });
        capture(result);
      }
      const final = await output.finish(truncated);
      return {
        output: final.metadata?.head ?? final.output,
        exitCode: result.exitCode,
        status,
        sourceTruncated: final.metadata?.sourceTruncated ?? truncated,
      };
    } finally {
      if (!executed) await this.#release(prepared, controller);
    }
  }

  async #release(
    prepared: PreparedToolInvocation,
    controller: AbortController,
  ) {
    // ToolEnvironment owns prepared leases. Abort before execute releases a
    // still-prepared lease without launching; an already released lease rejects.
    controller.abort();
    try {
      await this.tools.execute(prepared);
    } catch {
      /* released or aborted */
    }
  }
}
