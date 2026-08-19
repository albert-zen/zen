import {
  createHostedAppServer,
  type HostedZenAppServer,
} from "../../../../apps/cli/src/host.js";
import {
  serveCodexWebSocket,
  type CodexWebSocketServer,
} from "../../../../src/protocol/codex/websocket.js";
import {
  isHostCommand,
  type HostCommand,
} from "../../src/main/host-messages.js";

let appServer: HostedZenAppServer | undefined;
let server: CodexWebSocketServer | undefined;

process.on("message", (message: unknown) => {
  if (!isHostCommand(message)) return;
  void handle(message).catch((error: unknown) => {
    process.send?.({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  });
});

async function handle(command: HostCommand): Promise<void> {
  if (command.type === "shutdown") {
    await server?.close();
    await appServer?.closeProviderTransport();
    process.disconnect();
    return;
  }
  if (command.type === "start") {
    appServer = createHostedAppServer(command.config);
    server = await serveCodexWebSocket({
      appServer,
      zenHome: command.config.dataDirectory,
      listen: "ws://127.0.0.1:0",
      bearerToken: command.bearerToken,
    });
    process.send?.({ type: "ready", url: server.url });
    return;
  }
  if (command.type !== "thread-summary/list") return;

  const mode = process.env["ZENX_SUMMARY_FIXTURE_MODE"];
  if (mode === "matching-malformed") {
    process.send?.({
      type: "thread-summary/result",
      requestId: command.requestId,
    });
    return;
  }
  if (mode === "error") {
    process.send?.({
      type: "thread-summary/result",
      requestId: command.requestId,
      error: "fixture summary error",
    });
    return;
  }

  process.send?.({
    type: "thread-summary/result",
    requestId: `unmatched-${command.requestId}`,
    summaries: [{ threadId: 42 }],
  });
  process.send?.({
    type: "thread-summary/result",
    requestId: command.requestId,
    summaries: [
      {
        threadId: "fixture-thread",
        currentMetadata: {
          model: "fake",
          provider: "fake",
          cwd: command.options.archived === true ? "/archived" : "/workspace",
          sandbox: "danger-full-access",
          approvalPolicy: "never",
        },
        archived: command.options.archived ?? false,
        createdAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-19T00:00:00.000Z",
        preview: "fixture",
        status: "idle",
      },
    ],
  });
  setImmediate(() => {
    process.send?.({
      type: "thread-summary/result",
      requestId: command.requestId,
      summaries: [{ threadId: 42 }],
    });
  });
}
