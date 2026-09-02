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
  type HostEvent,
} from "./host-messages.js";
import {
  createZenXHostToolEnvironment,
  ZenXHostToolExecutor,
} from "./capability-tool-executor.js";
import type { ZenXCapabilityHostSnapshot } from "./capabilities/types.js";
import { projectThreadAttachments } from "./image-attachments.js";
import { projectModelUsage } from "../../../../src/model-usage.js";
import { ToolOutputSpool } from "../../../../src/tool-output-spool.js";

let server: CodexWebSocketServer | undefined;
let appServer: HostedZenAppServer | undefined;
let tools: ZenXHostToolExecutor | undefined;
let replaceCapabilities:
  ((capabilities: ZenXCapabilityHostSnapshot) => void) | undefined;
let shuttingDown = false;
let toolOutputSpool: ToolOutputSpool | undefined;

process.on("message", (message: unknown) => {
  if (!isHostCommand(message)) return;
  void handleCommand(message).catch((error: unknown) => {
    send({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    void shutdown();
  });
});

process.once("disconnect", () => void shutdown());
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

async function handleCommand(command: HostCommand): Promise<void> {
  if (command.type === "capability/result") {
    tools?.handleResult(command);
    return;
  }
  if (command.type === "shutdown") {
    await shutdown();
    return;
  }
  if (command.type === "capabilities/replace") {
    try {
      if (replaceCapabilities === undefined) {
        throw new Error("Zen App Server is not ready");
      }
      replaceCapabilities(command.capabilities);
      send({ type: "capabilities/replaced", requestId: command.requestId });
    } catch (error) {
      send({
        type: "capabilities/replaced",
        requestId: command.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (command.type === "thread-summary/list") {
    if (appServer === undefined) {
      send({
        type: "thread-summary/result",
        requestId: command.requestId,
        error: "Zen App Server is not ready",
      });
      return;
    }
    try {
      send({
        type: "thread-summary/result",
        requestId: command.requestId,
        summaries: await appServer.listThreadSummaries(command.options),
      });
    } catch (error) {
      send({
        type: "thread-summary/result",
        requestId: command.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (command.type === "thread-attachments/read") {
    if (appServer === undefined) {
      send({
        type: "thread-attachments/result",
        requestId: command.requestId,
        error: "Zen App Server is not ready",
      });
      return;
    }
    try {
      send({
        type: "thread-attachments/result",
        requestId: command.requestId,
        attachments: projectThreadAttachments(
          await appServer.readThread(command.threadId),
        ),
      });
    } catch (error) {
      send({
        type: "thread-attachments/result",
        requestId: command.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (command.type === "thread-usage/read") {
    if (appServer === undefined) {
      send({
        type: "thread-usage/result",
        requestId: command.requestId,
        error: "Zen App Server is not ready",
      });
      return;
    }
    try {
      send({
        type: "thread-usage/result",
        requestId: command.requestId,
        usage: projectModelUsage(
          (await appServer.readThread(command.threadId)).items,
        ),
      });
    } catch (error) {
      send({
        type: "thread-usage/result",
        requestId: command.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (server !== undefined) {
    throw new Error("ZenX App Server host already started");
  }
  toolOutputSpool = new ToolOutputSpool(command.config.toolOutputSpoolOptions);
  const toolComposition = createZenXHostToolEnvironment({
    capabilities: command.capabilities,
    blockedEnvironmentVariables: command.config.secretEnvironmentVariables,
    send,
    toolOutputSpool,
  });
  tools = toolComposition.capabilityProvider;
  replaceCapabilities = toolComposition.replaceCapabilities;
  appServer = createHostedAppServer({
    ...command.config,
    toolEnvironment: toolComposition.toolEnvironment,
    toolDefinitionProjection: toolComposition.toolDefinitionProjection,
    toolOutputSpool,
  });
  server = await serveCodexWebSocket({
    appServer,
    zenHome: command.config.dataDirectory,
    listen: command.listen ?? "ws://127.0.0.1:0",
    bearerToken: command.bearerToken,
  });
  send({ type: "ready", url: server.url });
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await server?.close();
  server = undefined;
  if (appServer !== undefined) {
    await appServer.closeHostResources();
  } else {
    await toolOutputSpool?.close();
  }
  appServer = undefined;
  toolOutputSpool = undefined;
  tools?.close();
  tools = undefined;
  replaceCapabilities = undefined;
  if (process.connected) process.disconnect();
  process.exit(process.exitCode ?? 0);
}

function send(event: HostEvent): void {
  if (process.connected) process.send?.(event);
}
