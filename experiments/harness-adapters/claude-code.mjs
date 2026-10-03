import { scoped, unsupported } from "./shared.mjs";
/** Official @anthropic-ai/claude-agent-sdk query/session utilities, injected. */
export function createClaudeCodeAdapter(sdk, { cwd }) {
  const scope = scoped("claude-code", cwd);
  async function run(input, id) {
    scope.start(input);
    const query = sdk.query({
      prompt: input.text,
      options: {
        cwd,
        permissionMode: "default",
        ...(id ? { resume: id } : {}),
        // No approval UI in this probe. A host can replace this callback at integration.
        canUseTool: async () => ({
          behavior: "deny",
          message: "This experiment has no approval UI",
        }),
      },
    });
    let result;
    try {
      for await (const event of query) {
        if (event.type === "result") result = event;
      }
      if (!result) throw new Error("Claude query ended without a result");
      if (result.is_error || result.subtype !== "success")
        throw new Error(`Claude query failed: ${result.subtype}`);
      const ref = scope.ref(result.session_id);
      if (id && id !== ref.id)
        throw new Error("Snapshot session identity mismatch");
      return {
        ref,
        messageId: input.messageId,
        status: "settled",
        consumption: "unknown",
        result,
      };
    } finally {
      query.close();
    }
  }
  return Object.freeze({
    engine: "claude-code",
    capabilities: Object.freeze({
      textInput: true,
      createSession: false,
      startSession: true,
      steer: false,
      fork: true,
      resume: true,
      read: true,
      interrupt: false,
      consumptionReceipt: false,
      eventStream: false,
      approvalUI: false,
      companion: false,
      sideChat: false,
    }),
    createSession: unsupported,
    startSession: (input) => run(input),
    async send(ref, input) {
      return run(input, scope.id(ref));
    },
    async readSession(ref) {
      const id = scope.id(ref);
      const info = await sdk.getSessionInfo(id, { dir: cwd });
      if (info?.sessionId !== id)
        throw new Error("Session unavailable or identity mismatch");
      const messages = await sdk.getSessionMessages(id, { dir: cwd });
      if (!Array.isArray(messages))
        throw new Error("Malformed session messages");
      return {
        ref: scope.ref(id),
        format: "claude-session-messages",
        snapshot: { info, messages },
      };
    },
    async forkSession(ref) {
      const result = await sdk.forkSession(scope.id(ref), { dir: cwd });
      return scope.ref(result.sessionId);
    },
    interrupt: unsupported,
  });
}
