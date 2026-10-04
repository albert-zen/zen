import type { AppServerManager } from "../app-server-manager.js";
import type {
  AgentProviderAdapter,
  AgentProviderEvent,
  AgentProviderCapabilities,
} from "./types.js";
import type { FilePermissionMode } from "../../protocol-client/types.js";

/** The existing Zen Host remains the authority; this port never constructs a runtime. */
export class ZenAgentAdapter implements AgentProviderAdapter {
  readonly capabilities: AgentProviderCapabilities = {
    models: true,
    interrupt: true,
    resume: true,
    changeModel: true,
    approvals: true,
    permissionModes: ["read-only", "workspace-write", "danger-full-access"],
  };
  constructor(
    readonly manager: Pick<
      AppServerManager,
      | "request"
      | "onNotification"
      | "respondToApproval"
      | "onApprovalRequest"
      | "onApprovalResolved"
    >,
  ) {}
  async models() {
    return (await this.manager.request("model/list", {})).data;
  }
  async create(input: {
    cwd: string;
    model?: string;
    permissionMode: FilePermissionMode;
  }) {
    const result = await this.manager.request("thread/start", {
      cwd: input.cwd,
      model: input.model,
      sandbox: input.permissionMode,
    });
    return {
      nativeSessionId: result.thread.id,
      thread: result.thread,
      model: result.model,
    };
  }
  async read(nativeSessionId: string) {
    const result = await this.manager.request("thread/resume", {
      threadId: nativeSessionId,
    });
    return {
      nativeSessionId: result.thread.id,
      thread: result.thread,
      model: result.model,
    };
  }
  async send(nativeSessionId: string, input: { text: string; model?: string }) {
    await this.manager.request("turn/start", {
      threadId: nativeSessionId,
      input: [{ type: "text", text: input.text }],
      model: input.model,
    });
  }
  async interrupt(nativeSessionId: string) {
    const { thread } = await this.manager.request("thread/read", {
      threadId: nativeSessionId,
      includeTurns: true,
    });
    const turn = thread.turns.find((t) => t.status === "inProgress");
    if (!turn) throw new Error("This Zen session has no active Turn");
    await this.manager.request("turn/interrupt", {
      threadId: nativeSessionId,
      turnId: turn.id,
    });
  }
  async respondApproval(requestId: string, decision: "accept" | "decline") {
    this.manager.respondToApproval(requestId, decision);
  }
  onEvent(listener: (event: AgentProviderEvent) => void) {
    const notifications = this.manager.onNotification((_method, params) => {
      if ("threadId" in params && typeof params.threadId === "string")
        listener({ type: "changed", sessionId: params.threadId });
    });
    const approvals = this.manager.onApprovalRequest((event) =>
      listener({
        type: "approval",
        sessionId: event.params.threadId,
        requestId: event.requestId,
        title: event.params.toolName ?? "Tool approval",
        detail: event.params.command,
      }),
    );
    const resolved = this.manager.onApprovalResolved((event) =>
      listener({
        type: "approvalResolved",
        sessionId: event.threadId,
        requestId: event.requestId,
      }),
    );
    return () => {
      notifications();
      approvals();
      resolved();
    };
  }
  async dispose() {
    /* Zen's existing Host lifecycle owns the shared manager. */
  }
}
