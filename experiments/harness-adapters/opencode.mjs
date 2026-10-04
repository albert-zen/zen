import { scoped, sdkData } from "./shared.mjs";
/** Official @opencode-ai/sdk v1 client, injected; server owns permissions. */
export function createOpenCodeAdapter(client, { cwd }) {
  const scope = scoped("opencode", cwd);
  const args = (id) => ({ path: { id }, query: { directory: cwd } });
  return Object.freeze({
    engine: "opencode",
    capabilities: Object.freeze({
      textInput: true,
      createSession: true,
      steer: false,
      fork: true,
      resume: true,
      read: true,
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
      const session = sdkData(
        await client.session.create({ query: { directory: cwd }, body: {} }),
      );
      return scope.ref(session.id);
    },
    async readSession(ref) {
      const id = scope.id(ref);
      const session = sdkData(await client.session.get(args(id)));
      if (session.id !== id)
        throw new Error("Snapshot session identity mismatch");
      const messages = sdkData(await client.session.messages(args(id)));
      if (!Array.isArray(messages))
        throw new Error("Malformed session messages");
      return {
        ref: scope.ref(id),
        format: "opencode-messages",
        snapshot: { session, messages },
      };
    },
    async send(ref, input) {
      const id = scope.id(ref);
      scope.start(input);
      const result = sdkData(
        await client.session.prompt({
          ...args(id),
          body: { parts: [{ type: "text", text: input.text }] },
        }),
      );
      if (result?.info?.sessionID !== id)
        throw new Error("Response session identity mismatch");
      if (result.info.error)
        throw new Error(
          `OpenCode prompt failed: ${result.info.error.name ?? "agent error"}`,
        );
      return {
        ref: scope.ref(id),
        messageId: input.messageId,
        status: "settled",
        consumption: "unknown",
        result,
      };
    },
    async forkSession(ref) {
      const session = sdkData(
        await client.session.fork({ ...args(scope.id(ref)), body: {} }),
      );
      return scope.ref(session.id);
    },
    async interrupt(ref) {
      if (sdkData(await client.session.abort(args(scope.id(ref)))) !== true)
        throw new Error("OpenCode did not confirm session abort");
    },
  });
}
