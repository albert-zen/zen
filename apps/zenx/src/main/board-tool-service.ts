import { randomUUID } from "node:crypto";
import type { ZenAppServer } from "../../../../src/app-server.js";
import type {
  ToolEnvironment,
  ToolExecutionResult,
  PreparedToolInvocation,
} from "../../../../src/tool.js";
import { validateBoardToolRequest } from "../board-host.js";

/** No model input or Turn: reuse native Shell policy, task ownership and Trace. */
export class BoardToolService {
  constructor(
    readonly app: Pick<
      ZenAppServer,
      "readThread" | "beginHostOperation" | "dispatchHostTool"
    >,
    readonly tools: ToolEnvironment,
    readonly assertOwner?: () => Promise<void>,
  ) {}

  async execute(
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const request = validateBoardToolRequest(input);
    signal.throwIfAborted();
    const lease = this.app.beginHostOperation("other", "board/shell");
    let prepared: PreparedToolInvocation | undefined;
    let dispatched = false;
    try {
      const thread = await this.app.readThread(request.threadId);
      if (thread.archived)
        throw new Error(
          "Restore the Board's Thread before executing an action",
        );
      signal.throwIfAborted();
      const callId = `board-shell:${randomUUID()}`;
      prepared = this.tools.prepare(
        {
          callId,
          name: "shell",
          arguments: request.arguments,
          cwd: thread.cwd,
          threadId: thread.id,
          sandbox: thread.sandbox,
          signal,
          outputAudience: "program",
          // Existing task ownership waits for this script's real terminal result,
          // bounded by its configured deadline/cancellation, not an arbitrary UI yield.
          task: { waitForCompletion: true },
        },
        { targetRouting: false },
      );
      if ((await this.tools.admitInherited(prepared)) !== "accept")
        throw new Error("Shell is denied by this Host's tool policy");
      // The Board gesture never grants or changes tool policy. If this Host has
      // no applicable grant and requires an approval, ordinary admission fails
      // closed. Do not impersonate an Agent approval request or Full Access.
      const decision = await this.tools.admit(prepared, {
        policy:
          thread.approvalPolicy === "never" ? "full_access" : "ask_unknown",
        approvalRequest: {
          threadId: thread.id,
          turnId: callId,
          itemId: callId,
          callId,
          toolName: "shell",
          toolArguments: prepared.invocation.arguments,
          command:
            typeof request.arguments.command === "string"
              ? request.arguments.command
              : "Board Shell action",
          cwd: thread.cwd,
          signal,
        },
      });
      if (decision !== "accept" && decision !== "acceptForSession")
        throw new Error("Board Shell action was not approved");
      if ((await this.tools.admitInherited(prepared)) !== "accept")
        throw new Error(
          "Shell permission changed before Board action dispatch",
        );
      if (request.owner?.kind === "room") {
        if (!this.assertOwner)
          throw new Error("Room execution ownership cannot be revalidated");
        await this.assertOwner();
      }
      signal.throwIfAborted();
      const admitted = prepared;
      const launched = await this.app.dispatchHostTool(thread, () => {
        signal.throwIfAborted();
        dispatched = true;
        return this.tools.execute(admitted);
      });
      return await launched.result;
    } catch (error) {
      if (dispatched)
        throw new Error(
          "Board action was dispatched but its outcome is unconfirmed; do not retry automatically",
          { cause: error },
        );
      throw error;
    } finally {
      // Once dispatched, the ordinary task manager retains any yielded work.
      if (prepared && !dispatched) this.tools.discard(prepared);
      lease.release();
    }
  }
}
