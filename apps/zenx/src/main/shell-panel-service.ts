import { randomUUID } from "node:crypto";
import type { ZenAppServer } from "../../../../src/app-server.js";
import type { ToolEnvironment } from "../../../../src/tool.js";
import {
  validateShellPanelRequest,
  type ShellPanelResult,
} from "../shell-panel.js";

/** Trusted desktop operations on the Host's existing Shell task authority. */
export class ShellPanelService {
  constructor(
    readonly app: Pick<
      ZenAppServer,
      "readThread" | "beginHostOperation" | "dispatchHostTool"
    >,
    readonly tools: ToolEnvironment,
  ) {}
  async request(input: unknown): Promise<ShellPanelResult> {
    validateShellPanelRequest(input);
    const thread = await this.app.readThread(input.threadId);
    const tasks = this.tools.taskManager;
    const canInput =
      !thread.archived && thread.sandbox === "danger-full-access";
    if (input.operation === "list")
      return {
        sessions: tasks.listShellSessions(thread.id).map((session) => ({
          ...session,
          inputAvailable: canInput && session.inputAvailable,
        })),
        cwd: thread.cwd,
        host: "local",
        canCreate: canInput,
        ...(thread.archived
          ? { restriction: "archived" }
          : thread.sandbox !== "danger-full-access"
            ? { restriction: "sandbox" }
            : {}),
      };
    if (input.operation === "read") {
      const view = tasks.readShellSession(
        thread.id,
        input.taskId,
        input.cursor,
      );
      view.session.inputAvailable &&= canInput;
      return view;
    }
    if (input.operation === "stop")
      return tasks.stopShellSession(thread.id, input.taskId);
    if (thread.archived)
      throw new Error(
        "Restore this thread before opening or typing in a terminal",
      );
    if (thread.sandbox !== "danger-full-access")
      throw new Error(
        "Interactive terminals require the thread's Full Access policy; it has not been changed",
      );
    const admission = this.app.beginHostOperation("other", "shell-panel/input");
    let prepared: ReturnType<ToolEnvironment["prepare"]> | undefined;
    try {
      prepared = this.tools.prepare({
        name: "shell",
        callId: `human-shell:${randomUUID()}`,
        arguments: { command: "Interactive shell" },
        cwd: thread.cwd,
        threadId: thread.id,
        sandbox: thread.sandbox,
        signal: new AbortController().signal,
        outputAudience: "program",
        ...(input.operation === "create"
          ? {
              userTerminal: { cols: input.cols, rows: input.rows },
              task: { yieldTimeMs: 1 },
            }
          : {}),
      });
      // A direct human terminal gesture is its own input consent. It does not
      // approve model calls or overwrite the remembered shell policy.
      if ((await this.tools.admitInherited(prepared)) !== "accept")
        throw new Error("Shell is denied by this Host's tool policy");
      const approved = prepared;
      // Use the existing AppServer mutation fence: task registration (or the
      // synchronous input write) happens before permissions/archive can change.
      const dispatched = await this.app.dispatchHostTool(thread, async () => {
        if (input.operation === "write") {
          tasks.writeShellSession(thread.id, input.taskId, input.data);
          return null;
        }
        if (input.operation === "resize") {
          tasks.resizeShellSession(
            thread.id,
            input.taskId,
            input.cols,
            input.rows,
          );
          return null;
        }
        const result = await this.tools.execute(approved);
        const body = result.structuredContent;
        const taskId =
          body && typeof body === "object" && "task_id" in body
            ? body.task_id
            : undefined;
        if (typeof taskId !== "string")
          throw new Error(result.output || "Interactive Shell could not start");
        return tasks.readShellSession(thread.id, taskId).session;
      });
      return await dispatched.result;
    } finally {
      if (prepared) this.tools.discard(prepared);
      admission.release();
    }
  }
}
