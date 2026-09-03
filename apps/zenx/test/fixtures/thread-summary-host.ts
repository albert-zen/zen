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
let summaryRequestCount = 0;
let generationToken = "legacy";
let replacementCount = 0;
let currentQueryCount = 0;

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
    generationToken = command.capabilities.generationToken;
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
  if (command.type === "capabilities/replace") {
    const mode = process.env["ZENX_SUMMARY_FIXTURE_MODE"];
    replacementCount += 1;
    if (mode !== "query-old") {
      generationToken = command.capabilities.generationToken;
    }
    if (mode === "exit-replacement") {
      process.exit(42);
    }
    const reply = () => {
      if (!process.connected) return;
      process.send?.(
        {
          type: "capabilities/replaced",
          requestId: command.requestId,
          generationToken,
        },
        () => undefined,
      );
    };
    if (
      mode === "query-old" ||
      (mode === "double-timeout" && replacementCount === 1)
    ) {
      return;
    }
    if (
      (mode === "query-new" || mode === "late-ack-query-timeout") &&
      replacementCount === 1
    ) {
      setTimeout(reply, 80);
    } else {
      reply();
    }
    return;
  }
  if (command.type === "capabilities/current") {
    const mode = process.env["ZENX_SUMMARY_FIXTURE_MODE"];
    currentQueryCount += 1;
    if (
      mode === "late-ack-query-timeout" ||
      (mode === "double-timeout" && currentQueryCount === 1)
    ) {
      return;
    }
    process.send?.({
      type: "capabilities/current",
      requestId: command.requestId,
      generationToken,
    });
    return;
  }
  if (command.type !== "thread-summary/list") return;

  const mode = process.env["ZENX_SUMMARY_FIXTURE_MODE"];
  summaryRequestCount += 1;
  if (mode === "matching-unknown-discriminant" && summaryRequestCount === 1) {
    process.send?.({
      type: "thread-summary/unknown",
      requestId: command.requestId,
    });
    return;
  }
  if (mode === "colliding-known-events" || mode === "double-timeout") {
    process.send?.({
      type: "capability/cancel",
      invocationId: "unrelated-capability",
      generationToken,
      requestId: command.requestId,
    });
    process.send?.({
      type: "capability/invoke",
      invocationId: "fixture-capability",
      generationToken,
      requestId: command.requestId,
      invocation: {
        callId: "call-1",
        name: "fixture_inspect",
        arguments: { target: "summary" },
        cwd: "/workspace",
      },
    });
    setImmediate(() => sendValidSummary(command));
    return;
  }
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
  sendValidSummary(command);
  setImmediate(() => {
    process.send?.({
      type: "thread-summary/result",
      requestId: command.requestId,
      summaries: [{ threadId: 42 }],
    });
  });
}

function sendValidSummary(
  command: Extract<HostCommand, { type: "thread-summary/list" }>,
): void {
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
}
