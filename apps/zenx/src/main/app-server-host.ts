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
  ZenXHostToolBundle,
} from "./capability-tool-executor.js";
import type { ZenXCapabilityGenerationSnapshot } from "./capabilities/types.js";
import { projectThreadAttachments } from "./image-attachments.js";
import { compileModelMessages } from "../../../../src/model.js";
import {
  estimateModelMessageInputTokens,
  projectModelUsage,
} from "../../../../src/model-usage.js";
import { ToolOutputSpool } from "../../../../src/tool-output-spool.js";

let server: CodexWebSocketServer | undefined;
let appServer: HostedZenAppServer | undefined;
let tools: ZenXHostToolBundle | undefined;
let replaceCapabilities:
  ((capabilities: ZenXCapabilityGenerationSnapshot) => void) | undefined;
let currentCapabilityGeneration: (() => string) | undefined;
let closeToolComposition: ((reason?: string) => Promise<void>) | undefined;
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
      send({
        type: "capabilities/replaced",
        requestId: command.requestId,
        generationToken: command.capabilities.generationToken,
      });
    } catch (error) {
      send({
        type: "capabilities/replaced",
        requestId: command.requestId,
        generationToken: command.capabilities.generationToken,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (command.type === "capabilities/current") {
    const generationToken = currentCapabilityGeneration?.();
    send(
      generationToken === undefined
        ? {
            type: "capabilities/current",
            requestId: command.requestId,
            error: "Zen App Server is not ready",
          }
        : {
            type: "capabilities/current",
            requestId: command.requestId,
            generationToken,
          },
    );
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
      const snapshot = await appServer.readThread(command.threadId);
      const selection = {
        providerProfileId: snapshot.providerProfileId,
        modelId: snapshot.modelId,
        reasoningEffort: snapshot.reasoningEffort,
      };
      const contextWindow =
        appServer
          .listModels()
          .find(
            (entry) =>
              entry.providerProfileId === selection.providerProfileId &&
              entry.model.id === selection.modelId,
          )?.model.contextWindow ?? null;
      send({
        type: "thread-usage/result",
        requestId: command.requestId,
        usage: projectModelUsage(snapshot.items, {
          contextWindow,
          estimatedInputTokens: estimateModelMessageInputTokens(
            compileModelMessages(snapshot.items, selection),
          ),
        }),
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
  if (command.type === "plugin-turn/start") {
    if (appServer === undefined) {
      send({
        type: "plugin-turn/result",
        requestId: command.requestId,
        error: "Zen App Server is not ready",
      });
      return;
    }
    try {
      const turn = await appServer.startTurn(command.threadId, command.input);
      await turn.done;
      send({
        type: "plugin-turn/result",
        requestId: command.requestId,
        threadId: command.threadId,
        turnId: turn.id,
        items: structuredClone([
          ...(await appServer.readThread(command.threadId)).items,
        ]),
      });
    } catch (error) {
      send({
        type: "plugin-turn/result",
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
  tools = toolComposition.capabilityBundle;
  replaceCapabilities = toolComposition.replaceCapabilities;
  currentCapabilityGeneration = toolComposition.currentGenerationToken;
  closeToolComposition = toolComposition.close;
  appServer = createHostedAppServer({
    ...command.config,
    toolEnvironment: toolComposition.toolEnvironment,
    toolDefinitionProjection: toolComposition.toolDefinitionProjection,
    toolOutputSpool,
    codeRuntimeOptions: {
      ...command.config.codeRuntimeOptions,
      workerUrl: codeRuntimeWorkerEntry(),
    },
    onToolPresentationWarning: (warning) =>
      console.warn(`[tool presentation] ${warning}`),
  });
  server = await serveCodexWebSocket({
    appServer,
    zenHome: command.config.dataDirectory,
    listen: command.listen ?? "ws://127.0.0.1:0",
    bearerToken: command.bearerToken,
  });
  send({ type: "ready", url: server.url });
}

function codeRuntimeWorkerEntry(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("../../../../src/code-runtime-worker.ts", import.meta.url)
    : new URL("./code-runtime-worker.js", import.meta.url);
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
  await closeToolComposition?.();
  tools = undefined;
  replaceCapabilities = undefined;
  currentCapabilityGeneration = undefined;
  closeToolComposition = undefined;
  if (process.connected) process.disconnect();
  process.exit(process.exitCode ?? 0);
}

function send(event: HostEvent): void {
  if (process.connected) process.send?.(event);
}
