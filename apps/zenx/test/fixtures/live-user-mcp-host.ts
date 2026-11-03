import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerManager } from "../../src/main/app-server-manager.js";
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

/** Booted explicitly by tests, never by the production stdio launcher. */
export async function createLiveUserMcpHost(
  root: string,
  options: {
    environment?: NodeJS.ProcessEnv;
    useBuilt?: boolean;
    builtMainDirectory?: string;
  } = {},
) {
  const environment = options.environment ?? process.env;
  const useBuilt =
    options.builtMainDirectory !== undefined ||
    (options.useBuilt ?? process.env.ZEN_MCP_TEST_USE_BUILT === "1");
  let manager!: AppServerManager;
  const port = new MutableAppServerRequestPort();
  const sidebar = new ThreadSidebarStore(path.join(root, "sidebar"));
  let rooms: ZenXRoom[] = [];
  const roomListeners = new Set<() => void>();
  const observe = (listener: () => void) => {
    roomListeners.add(listener);
    return () => {
      roomListeners.delete(listener);
    };
  };
  const board = new BoardHostService({
    appServer: port,
    sidebar,
    rooms: {
      roomsAvailable: () => true,
      snapshot: () => ({ rooms }),
      onChange: observe,
      postAddressedRoomMessage: async () => {
        throw new Error("Fixture does not send Room messages");
      },
    },
    readThreadSummary: async (threadId) =>
      (await manager.listThreadSummaries()).find(
        (thread) => thread.threadId === threadId,
      ),
    executeTool: async () => {
      throw new Error("Fixture does not execute Board human actions");
    },
  });
  const self = new ZenXSelfControlCapabilityPackage({
    appServer: port,
    sidebar,
    sidebarRooms: () => rooms,
  });
  const resources = fileURLToPath(new URL("../../resources/", import.meta.url));
  const capabilities = new ZenXCapabilityService({
    userDataDirectory: path.join(root, "profile"),
    resourcesDirectory: resources,
    pnpmCliPath: fileURLToPath(
      new URL("../../../../node_modules/pnpm/bin/pnpm.cjs", import.meta.url),
    ),
    pnpmEnvironment: {
      ...environment,
      npm_config_cache: path.join(root, "npm-cache"),
    },
    bundledProvidersOnly: true,
    appServerPort: port,
    projectProjection: port.projectProjection,
    trustedProfileLoaders: {
      "zenx-self-control": createDelegatingFirstPartyProfileLoader(() => self),
      "zenx-board": createDelegatingFirstPartyProfileLoader(
        () => new ZenXBoardCapabilityPackage(board),
      ),
    },
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await manager?.stop();
      } finally {
        try {
          await capabilities.close();
        } finally {
          await sidebar.close();
        }
      }
    })());
  try {
    await capabilities.initialize();
    for (const plugin of [
      FIRST_PARTY_PLUGIN_PACKAGES.selfControl,
      FIRST_PARTY_PLUGIN_PACKAGES.board,
    ])
      await capabilities.installBundledPluginPackage(
        path.join(resources, "plugins", plugin.tarball),
        { pluginId: plugin.pluginId, packageName: plugin.packageName },
      );
    const descriptorFile = path.join(root, "runtime", "connection.json");
    manager = new AppServerManager({
      entryPath: options.builtMainDirectory
        ? path.join(options.builtMainDirectory, "app-server-host.js")
        : fileURLToPath(
            new URL(
              useBuilt
                ? "../../out/main/app-server-host.js"
                : "../../src/main/app-server-host.ts",
              import.meta.url,
            ),
          ),
      environment,
      tokenFile: path.join(root, "runtime", "token"),
      descriptorFile,
      hostConfig: {
        cwd: root,
        dataDirectory: path.join(root, "data"),
        model: "fake",
        models: ["fake"],
        approvalPolicy: "never",
        provider: { type: "fake" },
        toolPresentation: "direct",
      },
      execArgv: useBuilt ? [] : ["--import", "tsx"],
      startupTimeoutMs: 10000,
      capabilityHost: capabilities,
      userMcpOwners: {
        readOwner: board.readOwner.bind(board),
        onChange: observe,
      },
    });
    await port.attach(manager, root, [root]);
    await manager.start();
    const thread = (
      await manager.request("thread/start", {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      })
    ).thread;
    await manager.completePluginTurn(
      thread.id,
      "Actual already-running Desktop child history for the MCP launcher.",
    );
    return {
      manager,
      descriptorFile,
      threadId: thread.id,
      setRooms(value: ZenXRoom[]) {
        rooms = value;
        for (const listener of roomListeners) listener();
      },
      replaceGeneration: () => manager.refreshCapabilitiesAfterCommit(),
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Live MCP Host setup failed",
      );
    }
    throw error;
  }
}
