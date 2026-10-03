import { createClaudeCodeAdapter } from "./claude-code.mjs";
import { createOpenCodeAdapter } from "./opencode.mjs";
import { createDeepSeekHarnessAdapter } from "./deepseek-harness.mjs";
/**
 * Experimental request boundary, not a second runtime or a transport launcher.
 * The caller supplies an already initialized, authenticated, engine-specific
 * transport. Request failures propagate unchanged; this module never retries.
 */
const dialects = {
  zen: {
    readMethod: "zen/thread/read",
    format: "zen-canonical-items",
    validateSnapshot(thread) {
      return Array.isArray(thread.items) && Array.isArray(thread.turns);
    },
    async send(request, id, input) {
      const result = await request("zen/turn/send", {
        threadId: id,
        mode: input.mode,
        input: [{ type: "text", text: input.text }],
        clientUserMessageId: input.messageId,
        ...(input.mode === "steer"
          ? { expectedTurnId: input.expectedTurnId }
          : {}),
      });
      return requiredString(result?.turnId, "turnId");
    },
  },
  codex: {
    readMethod: "thread/read",
    format: "codex-thread",
    validateSnapshot(thread) {
      return Array.isArray(thread.turns);
    },
    async send(request, id, input) {
      const result = await request(
        input.mode === "start" ? "turn/start" : "turn/steer",
        {
          threadId: id,
          input: [{ type: "text", text: input.text }],
          ...(input.mode === "steer"
            ? { expectedTurnId: input.expectedTurnId }
            : {}),
        },
      );
      return requiredString(
        input.mode === "start" ? result?.turn?.id : result?.turnId,
        "turnId",
      );
    },
  },
};

export function createHarnessAdapter(engine, transport, options = {}) {
  if (engine === "claude-code")
    return createClaudeCodeAdapter(transport, options);
  if (engine === "opencode") return createOpenCodeAdapter(transport, options);
  if (engine === "deepseek-harness")
    return createDeepSeekHarnessAdapter(transport, options);
  const dialect = Object.hasOwn(dialects, engine)
    ? dialects[engine]
    : undefined;
  if (!dialect) throw new Error(`Unsupported harness: ${engine}`);
  if (typeof transport?.request !== "function")
    throw new Error("request transport is required");
  const request = transport.request.bind(transport);
  function sessionId(ref) {
    if (ref?.engine !== engine)
      throw new Error("Session engine does not match adapter");
    return requiredString(ref.id, "session id");
  }
  return Object.freeze({
    engine,
    // These are capabilities of this slice, not promises about every backend.
    capabilities: Object.freeze({
      textInput: true,
      createSession: true,
      read: true,
      interrupt: true,
      interruptScope: "turn",
      steer: true,
      fork: false,
      resume: false,
      consumptionReceipt: false,
      approvalUI: false,
      eventStream: false,
      companion: false,
      sideChat: false,
    }),
    async createSession({ cwd }) {
      requiredString(cwd, "cwd");
      const result = await request("thread/start", {
        cwd,
        sandbox: "read-only",
        approvalPolicy: "on-request",
      });
      return Object.freeze({
        engine,
        id: requiredString(result?.thread?.id, "thread id"),
      });
    },
    async readSession(ref) {
      const id = sessionId(ref);
      const result = await request(dialect.readMethod, {
        threadId: id,
        ...(engine === "codex" ? { includeTurns: true } : {}),
      });
      const thread = result?.thread;
      if (thread?.id !== id)
        throw new Error("Snapshot session identity mismatch");
      if (!dialect.validateSnapshot(thread))
        throw new Error("Malformed thread snapshot");
      // Never relabel a foreign transcript as Zen canonical Items.
      return { ref: { engine, id }, format: dialect.format, snapshot: thread };
    },
    async send(ref, input) {
      const id = sessionId(ref);
      requiredString(input?.text, "text");
      requiredString(input?.messageId, "messageId");
      if (input.mode !== "start" && input.mode !== "steer")
        throw new Error("Unsupported send mode");
      if (input.mode === "steer")
        requiredString(input.expectedTurnId, "expectedTurnId");
      const turnId = await dialect.send(request, id, input);
      return {
        ref: { engine, id },
        messageId: input.messageId,
        turnId,
        status: "accepted",
        consumption: "unknown",
      };
    },
    async interrupt(ref, turnId) {
      const id = sessionId(ref);
      requiredString(turnId, "turnId");
      await request("turn/interrupt", { threadId: id, turnId });
    },
  });
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${label} is required`);
  return value;
}
