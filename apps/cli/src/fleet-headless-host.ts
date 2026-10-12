import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { RemoteHostAccess } from "../../../src/protocol/native/remote-host.js";
import { serveRemoteHost } from "../../../src/protocol/native/remote-transport.js";
import { FleetShellGateway } from "../../../src/protocol/native/remote-shell.js";
import { ShellToolRuntime, ToolEnvironment } from "../../../src/tool.js";
import { ToolOutputSpool } from "../../../src/tool-output-spool.js";
import { createHostedAppServer, type ZenHostOptions } from "./host.js";
import {
  assertPrivateFleetPath,
  type FleetHeadlessConfig,
} from "./fleet-headless-config.js";

/** One explicitly started foreground process; durable grants do not start it. */
export async function startFleetHeadlessHost(
  config: FleetHeadlessConfig,
  options: ZenHostOptions,
) {
  await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
  await assertPrivateFleetPath(options.dataDirectory, "directory");
  const spool = new ToolOutputSpool({
    rootDirectory: path.join(options.dataDirectory, "tool-output-spool"),
  });
  const tools = new ToolEnvironment({
    toolOutputSpool: spool,
    runtimes: [
      new ShellToolRuntime({
        blockedEnvironmentVariables: options.secretEnvironmentVariables ?? [],
        toolOutputSpool: spool,
      }),
    ],
  });
  let host;
  try {
    host = createHostedAppServer({
      ...options,
      toolOutputSpool: spool,
      toolEnvironment: tools,
    });
  } catch (error) {
    await Promise.allSettled([tools.close(), spool.close()]);
    throw error;
  }
  let access: RemoteHostAccess | undefined;
  let server: Awaited<ReturnType<typeof serveRemoteHost>> | undefined;
  let pairingIdentity: { dev: number; ino: number } | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const activeTurns = new Map<string, string>();
  const interruptions = new Set<Promise<void>>();
  const interrupt = (threadId: string, turnId: string) => {
    const pending = host
      .interruptTurn(threadId, turnId)
      .catch((error: unknown) => {
        // A completion can race the local process shutdown.
        if ((error as { code?: string }).code !== "turn_not_running")
          throw error;
      });
    interruptions.add(pending);
    void pending.catch(() => undefined);
  };
  const unsubscribe = host.subscribe((event) => {
    if (event.type === "turn_started") {
      activeTurns.set(event.threadId, event.turnId);
      if (closed) interrupt(event.threadId, event.turnId);
    } else if (event.type === "turn_completed") {
      if (activeTurns.get(event.threadId) === event.turnId)
        activeTurns.delete(event.threadId);
    }
  });
  const removePairingFile = async () => {
    if (pairingIdentity === undefined) return;
    try {
      const current = await lstat(config.pairCodeFile);
      if (
        current.dev !== pairingIdentity.dev ||
        current.ino !== pairingIdentity.ino
      )
        throw new Error(
          "Fleet pairing file changed; refusing to remove another file",
        );
      await unlink(config.pairCodeFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    pairingIdentity = undefined;
  };
  const close = async () => {
    closePromise ??= (async () => {
      closed = true;
      // Revoke this process's admission before closing transport/execution.
      access?.close();
      // Provider retirement waits for active execution leases. Close root
      // admission and interrupt the actual Host turns before waiting on it.
      const providerClosing = host.closeRuntimeConfiguration();
      for (const [threadId, turnId] of activeTurns) interrupt(threadId, turnId);
      const results = await Promise.allSettled([
        providerClosing,
        server?.close(),
        removePairingFile(),
        host.closeHostResources(),
      ]);
      results.push(...(await Promise.allSettled(interruptions)));
      unsubscribe();
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (errors.length)
        throw new AggregateError(errors, "Fleet Host shutdown failed");
    })();
    await closePromise;
  };
  try {
    access = new RemoteHostAccess({
      appServer: host,
      hostId: config.hostId,
      grantFile: config.grantFile,
      access: config.access,
      shellEnabled: config.shellEnabled,
      ...(config.shellEnabled ? { shell: new FleetShellGateway(tools) } : {}),
      workspaces: () => config.workspaces,
    });
    server = await serveRemoteHost({
      enabled: true,
      listen: config.bindAddress,
      port: config.port,
      tls: {
        cert: await readFile(config.tlsCertificateFile),
        key: await readFile(config.tlsKeyFile),
      },
      access,
      ...(config.originEndpoint === undefined
        ? {}
        : { originEndpoint: config.originEndpoint }),
    });
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  const authority = access;
  return {
    url: server.url,
    hostId: config.hostId,
    devices: () => authority.devices(),
    revoke(deviceId: string) {
      if (closed) throw new Error("Fleet Host is closed");
      if (!authority.devices().some((device) => device.deviceId === deviceId))
        throw new Error("Device not found");
      authority.revoke(deviceId);
    },
    async createPairingCodeFile() {
      if (closed) throw new Error("Fleet Host is closed");
      await removePairingFile();
      const file = await open(
        config.pairCodeFile,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        const info = await file.stat();
        pairingIdentity = { dev: info.dev, ino: info.ino };
        await file.writeFile(`${authority.createPairingCode()}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
    },
    close,
  };
}
