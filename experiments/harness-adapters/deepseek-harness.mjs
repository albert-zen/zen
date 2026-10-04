import { scoped, requiredString, unsupported } from "./shared.mjs";
/** DeepSeek's official automation ACP; transport is already initialized. */
export function createDeepSeekHarnessAdapter(transport, { cwd }) {
  const scope = scoped("deepseek-harness", cwd);
  return Object.freeze({
    engine: "deepseek-harness",
    capabilities: Object.freeze({
      textInput: true,
      createSession: true,
      steer: false,
      fork: false,
      resume: true,
      read: false,
      interrupt: true,
      interruptScope: "session",
      consumptionReceipt: false,
      eventStream: false,
      approvalUI: false,
      companion: false,
      sideChat: false,
    }),
    async createSession(input = {}) {
      scope.create(input);
      const result = await transport.request("session/new", {
        cwd,
        mcpServers: [],
      });
      return scope.ref(result?.sessionId);
    },
    async send(ref, input) {
      const sessionId = scope.id(ref);
      scope.start(input);
      const result = await transport.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: input.text }],
      });
      const stopReason = requiredString(result?.stopReason, "stopReason");
      return {
        ref: scope.ref(sessionId),
        messageId: input.messageId,
        status: "settled",
        consumption: "unknown",
        stopReason,
      };
    },
    async interrupt(ref) {
      await transport.notify("session/cancel", { sessionId: scope.id(ref) });
    },
    async resumeSession(ref) {
      const sessionId = scope.id(ref);
      await transport.request("session/resume", {
        sessionId,
        cwd,
        mcpServers: [],
      });
      return scope.ref(sessionId);
    },
    readSession: unsupported,
    forkSession: unsupported,
  });
}
