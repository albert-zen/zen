import { BoardToolService } from "./board-tool-service.js";
import { ShellPanelService } from "./shell-panel-service.js";
import { randomUUID } from "node:crypto";
import { FleetToolGateway } from "../../../../src/protocol/native/remote-tools.js";
import { FleetShellGateway } from "./fleet-shell.js";
import type { ToolEnvironment } from "../../../../src/tool.js";
import { FleetHostService } from "./fleet-host.js";
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
import { ToolOutputSpool } from "../../../../src/tool-output-spool.js";

let fleetHost: FleetHostService | undefined;
const boardActions = new Map<
  string,
  {
    controller: AbortController;
    ownerCheck?: (error?: Error) => void;
  }
>();
const roomListeners = new Set<
  (event: { roomId: string; threadId: string }) => void
>();
const roomRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let server: CodexWebSocketServer | undefined;
let appServer: HostedZenAppServer | undefined;
let tools: ZenXHostToolBundle | undefined;
let targetToolEnvironment: ToolEnvironment | undefined;
let replaceCapabilities:
  ((capabilities: ZenXCapabilityGenerationSnapshot) => void) | undefined;
let currentCapabilityGeneration: (() => string) | undefined;
let closeToolComposition: ((reason?: string) => Promise<void>) | undefined;
let shuttingDown = false;
let toolOutputSpool: ToolOutputSpool | undefined;
let maintenance:
  | {
      token: string;
      result: Extract<
        ReturnType<HostedZenAppServer["tryBeginMaintenance"]>,
        { accepted: true }
      >;
    }
  | undefined;

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
  if (command.type === "board-tool/owner-result") {
    boardActions
      .get(command.requestId)
      ?.ownerCheck?.(
        command.error === undefined ? undefined : new Error(command.error),
      );
    return;
  }
  if (command.type === "board-tool/cancel") {
    boardActions
      .get(command.requestId)
      ?.controller.abort(new Error("Board action cancellation requested"));
    return;
  }
  if (command.type === "board-tool/request") {
    const controller = new AbortController();
    if (boardActions.has(command.requestId)) {
      send({
        type: "board-tool/result",
        requestId: command.requestId,
        error:
          "Board action identity is already in use; do not repeat the request",
      });
      return;
    }
    const action: {
      controller: AbortController;
      ownerCheck?: (error?: Error) => void;
    } = { controller };
    boardActions.set(command.requestId, action);
    try {
      if (!appServer || !targetToolEnvironment)
        throw new Error("Board tool Host is unavailable");
      const result = await new BoardToolService(
        appServer,
        targetToolEnvironment,
        () =>
          new Promise<void>((resolve, reject) => {
            controller.signal.throwIfAborted();
            const timer = setTimeout(
              () =>
                done(
                  new Error("Board owner validation timed out before dispatch"),
                ),
              5000,
            );
            const abort = () =>
              done(new Error("Board action cancelled before owner validation"));
            const done = (error?: Error) => {
              clearTimeout(timer);
              controller.signal.removeEventListener("abort", abort);
              delete action.ownerCheck;
              if (error) reject(error);
              else resolve();
            };
            action.ownerCheck = done;
            controller.signal.addEventListener("abort", abort, { once: true });
            send({
              type: "board-tool/check-owner",
              requestId: command.requestId,
            });
          }),
      ).execute(command.input, controller.signal);
      send({ type: "board-tool/result", requestId: command.requestId, result });
    } catch (error) {
      send({
        type: "board-tool/result",
        requestId: command.requestId,
        error:
          error instanceof Error
            ? error.message
            : "Board tool outcome is unconfirmed; do not retry automatically",
      });
    } finally {
      boardActions.delete(command.requestId);
    }
    return;
  }

  if (command.type === "model-debug/request") {
    try {
      if (!appServer) throw new Error("Local Host unavailable");
      send({
        type: "model-debug/result",
        requestId: command.requestId,
        result: await appServer.modelRequestDebug.control(command.input),
      });
    } catch {
      send({
        type: "model-debug/result",
        requestId: command.requestId,
        error: "Durable Trace read failed",
      });
    }
    return;
  }
  if (command.type === "shell-panel/request") {
    try {
      if (!appServer || !targetToolEnvironment)
        throw new Error("Shell Host unavailable");
      const result = await new ShellPanelService(
        appServer,
        targetToolEnvironment,
      ).request(command.input);
      send({
        type: "shell-panel/result",
        requestId: command.requestId,
        result,
      });
    } catch (error) {
      send({
        type: "shell-panel/result",
        requestId: command.requestId,
        error: error instanceof Error ? error.message : "Shell request failed",
      });
    }
    return;
  }

  if (command.type === "fleet/room-event") {
    for (const listener of roomListeners) listener(command);
    return;
  }
  if (command.type === "fleet/room-result") {
    const request = roomRequests.get(command.requestId);
    if (request) {
      roomRequests.delete(command.requestId);
      clearTimeout(request.timer);
      if (command.error) request.reject(new Error(command.error));
      else request.resolve(command.result);
    }
    return;
  }
  if (command.type === "fleet/control") {
    try {
      if (!appServer) throw new Error("Host unavailable");
      fleetHost ??= new FleetHostService(
        appServer,
        {
          request: (operation, params) =>
            new Promise((resolve, reject) => {
              if (roomRequests.size >= 32) {
                reject(new Error("Too many Room requests"));
                return;
              }
              const requestId = randomUUID();
              const timer = setTimeout(() => {
                roomRequests.delete(requestId);
                reject(new Error("Room result unknown"));
              }, 15000);
              roomRequests.set(requestId, { resolve, reject, timer });
              send({
                type: "fleet/room-request",
                requestId,
                operation,
                params,
              });
            }),
          subscribe: (listener) => {
            roomListeners.add(listener);
            return () => roomListeners.delete(listener);
          },
        },
        targetToolEnvironment
          ? new FleetShellGateway(targetToolEnvironment)
          : undefined,
        targetToolEnvironment
          ? ({ hostId, processEpoch }) =>
              new FleetToolGateway({
                tools: targetToolEnvironment!,
                hostId,
                processEpoch,
              })
          : undefined,
      );
      send({
        type: "fleet/result",
        requestId: command.requestId,
        result: await fleetHost.control(command.action, command.input),
      });
    } catch (error) {
      send({
        type: "fleet/result",
        requestId: command.requestId,
        error: error instanceof Error ? error.message : "Fleet control failed",
      });
    }
    return;
  }

  if (command.type === "capability/result") {
    tools?.handleResult(command);
    return;
  }
  if (command.type === "shutdown") {
    await shutdown();
    return;
  }
  if (command.type === "configuration/prepare") {
    if (appServer === undefined) {
      send({
        type: "configuration/prepared",
        requestId: command.requestId,
        error: "Zen App Server is not ready",
      });
      return;
    }
    try {
      send({
        type: "configuration/prepared",
        requestId: command.requestId,
        candidate: await appServer.prepareConfiguration(
          command.config,
          command.revision,
          command.candidateToken,
        ),
      });
    } catch (error) {
      send({
        type: "configuration/prepared",
        requestId: command.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (command.type === "configuration/publish") {
    if (appServer === undefined) {
      send({
        type: "configuration/published",
        requestId: command.requestId,
        error: "Zen App Server is not ready",
      });
      return;
    }
    try {
      send({
        type: "configuration/published",
        requestId: command.requestId,
        current: appServer.publishConfiguration(command.candidate),
      });
    } catch (error) {
      send({
        type: "configuration/published",
        requestId: command.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (command.type === "configuration/discard") {
    if (appServer === undefined) {
      send({
        type: "configuration/discarded",
        requestId: command.requestId,
        error: "Zen App Server is not ready",
      });
      return;
    }
    try {
      await appServer.discardConfiguration(command.candidate);
      send({ type: "configuration/discarded", requestId: command.requestId });
    } catch (error) {
      send({
        type: "configuration/discarded",
        requestId: command.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (command.type === "configuration/current") {
    send(
      appServer === undefined
        ? {
            type: "configuration/current",
            requestId: command.requestId,
            error: "Zen App Server is not ready",
          }
        : {
            type: "configuration/current",
            requestId: command.requestId,
            current: {
              ...appServer.currentConfiguration(),
              threadStartDefaults: appServer.threadStartDefaults(),
            },
          },
    );
    return;
  }
  if (command.type === "maintenance/try-begin") {
    if (appServer === undefined) {
      send({
        type: "maintenance/result",
        requestId: command.requestId,
        accepted: false,
        activity: {
          acceptingRootOperations: false,
          rootOperations: [],
          activeToolTasks: 0,
        },
      });
      return;
    }
    const result =
      maintenance?.token === command.requestId
        ? maintenance.result
        : appServer.tryBeginMaintenance();
    if (result.accepted) {
      maintenance = { token: command.requestId, result };
    }
    send({
      type: "maintenance/result",
      requestId: command.requestId,
      accepted: result.accepted,
      activity: result.activity,
    });
    return;
  }
  if (command.type === "maintenance/end") {
    if (maintenance?.token === command.maintenanceToken) {
      maintenance.result.end();
      maintenance = undefined;
    }
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
      send({
        type: "thread-usage/result",
        requestId: command.requestId,
        usage: await appServer.readModelUsage(command.threadId),
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
    experimentalRtk: command.config.experimentalRtk,
    blockedEnvironmentVariables: command.config.secretEnvironmentVariables,
    send,
    toolOutputSpool,
  });
  tools = toolComposition.capabilityBundle;
  targetToolEnvironment = toolComposition.toolEnvironment;
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
  send({
    type: "ready",
    url: server.url,
    processEpoch: appServer.processEpoch,
  });
}

function codeRuntimeWorkerEntry(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("./source-code-runtime-worker.mjs", import.meta.url)
    : new URL("./code-runtime-worker.js", import.meta.url);
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const action of boardActions.values())
    action.controller.abort(new Error("Board Host is closing"));
  const failures: unknown[] = [];
  const cleanup = async (operation: () => unknown | Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  // Begin owned native cancellation immediately, before unrelated transport
  // teardown can spend the outer Host shutdown budget.
  const toolCleanup = cleanup(() => closeToolComposition?.());
  closeToolComposition = undefined;
  await cleanup(() => fleetHost?.close());
  fleetHost = undefined;
  for (const request of roomRequests.values()) {
    clearTimeout(request.timer);
    request.reject(new Error("Host stopped"));
  }
  roomRequests.clear();
  await cleanup(() => server?.close());
  server = undefined;
  await toolCleanup;
  if (appServer !== undefined) {
    await cleanup(() => appServer!.closeHostResources());
  } else {
    await cleanup(() => toolOutputSpool?.close());
  }
  appServer = undefined;
  toolOutputSpool = undefined;
  tools = undefined;
  targetToolEnvironment = undefined;
  replaceCapabilities = undefined;
  currentCapabilityGeneration = undefined;
  maintenance = undefined;
  if (failures.length > 0) {
    const message = `Host cleanup is unconfirmed: ${failures.map(String).join("; ")}`;
    send({ type: "error", message });
    console.error(message);
    process.exitCode = 1;
  }
  if (process.connected) process.disconnect();
  process.exit(process.exitCode ?? 0);
}

function send(event: HostEvent): void {
  if (process.connected) process.send?.(event);
}
