import { EventEmitter, once } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolOutputSpool } from "../../../../src/tool-output-spool.js";
import { createZenXHostToolEnvironment } from "../../src/main/capability-tool-executor.js";
import { createHostedAppServer } from "../../../cli/src/host.js";
import { CodexConnection } from "../../../../src/protocol/codex/connection.js";
import { NativeConnection } from "../../../../src/protocol/native/connection.js";
import { NativeRecoveryProjection } from "../../../../src/protocol/native/recovery.js";
import type { JsonRpcMessage } from "../../../../src/protocol/codex/wire.js";
import { ZenXCapabilityService } from "../../src/main/capability-service.js";
import { BoardHostService } from "../../src/main/board-host-service.js";
import { ThreadSidebarStore } from "../../src/main/thread-sidebar-store.js";
import {
  MutableAppServerRequestPort,
  ZenXSelfControlCapabilityPackage,
} from "../../src/main/capabilities/self-control-package.js";
import { ZenXBoardCapabilityPackage } from "../../src/main/capabilities/board-package.js";
import {
  FIRST_PARTY_PLUGIN_PACKAGES,
  createDelegatingFirstPartyProfileLoader,
} from "../../src/main/first-party-profile-loader.js";
import type { ZenXRoom } from "../../src/main/trigger-types.js";

/** Real private Host composition, with a credential-free local model only for seeding history. */
export async function createRealUserMcpHost(root: string) {
  await mkdir(root, { recursive: true });
  const active = new Map<string, AbortController>();
  let capabilities!: ZenXCapabilityService;
  const spool = new ToolOutputSpool();
  const composition = createZenXHostToolEnvironment({
    capabilities: { definitions: [], plugins: [] },
    toolOutputSpool: spool,
    send: (event) => {
      if (event.type === "capabilities/released") {
        if (event.generationToken !== "legacy")
          capabilities.releaseHostGeneration(event.generationToken);
        return;
      }
      if (event.type === "capability/cancel") {
        active.get(event.invocationId)?.abort(new Error("Host tool cancelled"));
        return;
      }
      if (event.type !== "capability/invoke") return;
      const controller = new AbortController();
      active.set(event.invocationId, controller);
      void capabilities
        .execute(
          { ...event.invocation, signal: controller.signal },
          event.generationToken,
        )
        .then(
          (result) =>
            composition.capabilityBundle.handleResult({
              type: "capability/result",
              invocationId: event.invocationId,
              generationToken: event.generationToken,
              ...result,
            }),
          (error) =>
            composition.capabilityBundle.handleResult({
              type: "capability/result",
              invocationId: event.invocationId,
              generationToken: event.generationToken,
              error: error instanceof Error ? error.message : String(error),
            }),
        )
        .finally(() => active.delete(event.invocationId));
    },
  });
  const app = createHostedAppServer({
    cwd: root,
    dataDirectory: path.join(root, "data"),
    model: "fake",
    models: ["fake"],
    approvalPolicy: "never",
    toolPresentation: "direct",
    provider: { type: "fake" },
    toolEnvironment: composition.toolEnvironment,
    toolDefinitionProjection: composition.toolDefinitionProjection,
    toolOutputSpool: spool,
  });
  const first = await app.startThread({
    cwd: root,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  const second = await app.startThread({
    cwd: root,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  await (
    await app.startTurn(
      first.id,
      "A real private MCP fixture history: choose a small release.",
    )
  ).done;
  const responses = new Map<
    string | number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  const approvals = new EventEmitter();
  const send = (message: JsonRpcMessage) => {
    if (
      "method" in message &&
      message.method === "item/commandExecution/requestApproval" &&
      "id" in message
    ) {
      approvals.emit("request", { id: message.id, params: message.params });
      return;
    }
    if (
      !("id" in message) ||
      message.id == null ||
      !("result" in message || "error" in message)
    )
      return;
    const pending = responses.get(message.id);
    if (!pending) return;
    responses.delete(message.id);
    if ("error" in message) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  };
  const cas = new CodexConnection({ appServer: app, zenHome: root, send });
  const projection = new NativeRecoveryProjection(app);
  const native = new NativeConnection({
    appServer: app,
    projection,
    send,
    isInitialized: () => cas.initialized,
  });
  let next = 1;
  const request = async (method: string, params: unknown): Promise<any> => {
    const id = next++;
    const result = new Promise((resolve, reject) =>
      responses.set(id, { resolve, reject }),
    );
    const message = { id, method, params } as JsonRpcMessage;
    await (NativeConnection.handles(message) ? native : cas).receive(message);
    return result;
  };
  await request("initialize", {
    clientInfo: { name: "real-mcp-host-fixture", version: "1" },
  });
  await cas.receive({ method: "initialized" });
  const port = new MutableAppServerRequestPort();
  await port.attach({ request: request as never }, root, [root]);
  const sidebar = new ThreadSidebarStore(path.join(root, "sidebar"));
  let rooms: ZenXRoom[] = [
    {
      id: "mcp-room",
      name: "Private MCP test",
      createdAt: 0,
      operationEpoch: "fixture-generation",
      members: [{ threadId: first.id, name: "Worker" } as never],
      messages: [],
    },
  ];
  const roomListeners = new Set<() => void>();
  const roomPort = {
    roomsAvailable: () => true,
    snapshot: () => ({ rooms }),
    onChange: (listener: () => void) => {
      roomListeners.add(listener);
      return () => {
        roomListeners.delete(listener);
      };
    },
    postAddressedRoomMessage: async () => {
      throw new Error("The fixture never delivers model messages");
    },
  };
  const board = new BoardHostService({
    appServer: port,
    sidebar,
    rooms: roomPort,
    readThreadSummary: async (threadId) => {
      const value = await app.readThread(threadId);
      return { threadId: value.id, archived: value.archived };
    },
    executeTool: async () => {
      throw new Error("The fixture never executes Board UI actions");
    },
  });
  const self = new ZenXSelfControlCapabilityPackage({
    appServer: port,
    sidebar,
    sidebarRooms: () => rooms,
  });
  const boardPackage = new ZenXBoardCapabilityPackage(board);
  const resources = fileURLToPath(new URL("../../resources/", import.meta.url));
  capabilities = new ZenXCapabilityService({
    userDataDirectory: path.join(root, "profile"),
    resourcesDirectory: resources,
    pnpmCliPath: fileURLToPath(
      new URL("../../../../node_modules/pnpm/bin/pnpm.cjs", import.meta.url),
    ),
    pnpmEnvironment: {
      ...process.env,
      npm_config_cache: path.join(root, "npm-cache"),
    },
    bundledProvidersOnly: true,
    appServerPort: port,
    projectProjection: port.projectProjection,
    trustedProfileLoaders: {
      "zenx-self-control": createDelegatingFirstPartyProfileLoader(() => self),
      "zenx-board": createDelegatingFirstPartyProfileLoader(() => boardPackage),
    },
  });
  await capabilities.initialize();
  for (const plugin of [
    FIRST_PARTY_PLUGIN_PACKAGES.selfControl,
    FIRST_PARTY_PLUGIN_PACKAGES.board,
  ])
    await capabilities.installBundledPluginPackage(
      path.join(resources, "plugins", plugin.tarball),
      { pluginId: plugin.pluginId, packageName: plugin.packageName },
    );
  composition.replaceCapabilities(capabilities.captureHostSnapshot());
  const unwatch = capabilities.onChange(() => {
    queueMicrotask(() =>
      composition.replaceCapabilities(capabilities.captureHostSnapshot()),
    );
  });
  const lifetime = new AbortController();
  return {
    app,
    capabilities,
    tools: composition.toolEnvironment,
    capabilityGeneration: composition.currentGenerationToken,
    replaceHostCapabilityGeneration() {
      composition.replaceCapabilities(capabilities.captureHostSnapshot());
    },
    board,
    sidebar,
    threadId: first.id,
    otherThreadId: second.id,
    signal: lifetime.signal,
    existingApprovalHandler: cas.requestApproval.bind(cas),
    async nextApproval() {
      return (await once(approvals, "request"))[0] as {
        id: string | number;
        params: Record<string, unknown>;
      };
    },
    async respondApproval(
      id: string | number,
      decision: "accept" | "decline" | "cancel",
    ) {
      await cas.receive({ id, result: { decision } });
    },
    setRooms(value: ZenXRoom[]) {
      rooms = value;
      for (const listener of roomListeners) listener();
    },
    get rooms() {
      return structuredClone(rooms);
    },
    revoke() {
      lifetime.abort(new Error("Host connection generation retired"));
    },
    async close() {
      lifetime.abort();
      unwatch();
      await composition.close();
      await capabilities.close();
      await sidebar.close();
      native.close();
      cas.close();
      projection.close();
      await app.closeHostResources();
    },
  };
}
