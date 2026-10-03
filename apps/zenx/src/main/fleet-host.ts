import { X509Certificate } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { connectFleetRelayHost } from "./fleet-relay.js";
import { RemoteGrantFile } from "../../../../src/protocol/native/remote-grants.js";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  RemoteHostAccess,
  RemoteHostError,
  type RemoteRoomsPort,
} from "../../../../src/protocol/native/remote-host.js";
import {
  serveRemoteHost,
  originAuthority,
  type RemoteHostTransport,
} from "../../../../src/protocol/native/remote-transport.js";
import type { ZenAppServer } from "../../../../src/app-server.js";
export interface FleetHostConfig {
  enabled: boolean;
  hostId: string;
  bindAddress: string;
  port: number;
  tlsCertificateFile: string;
  tlsKeyFile: string;
  grantFile: string;
  access: "read" | "control";
  relayEndpoint?: string;
  originEndpoint?: string;
  relayRegistrationToken?: string;
  workspaces: Array<{ id: string; label: string; cwd: string }>;
}
function validateWorkspaces(value: unknown): FleetHostConfig["workspaces"] {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    value.some(
      (w) =>
        !w ||
        typeof w.id !== "string" ||
        !w.id ||
        w.id.length > 512 ||
        typeof w.label !== "string" ||
        w.label.length > 512 ||
        typeof w.cwd !== "string" ||
        !path.isAbsolute(w.cwd),
    ) ||
    new Set(value.map((w) => w.id)).size !== value.length
  )
    throw new Error("Invalid Fleet workspace allowlist");
  return value.map(({ id, label, cwd }) => ({ id, label, cwd }));
}
export function validateFleetHostConfig(value: unknown): FleetHostConfig {
  const c = value as FleetHostConfig;
  if (
    !c ||
    typeof c.enabled !== "boolean" ||
    typeof c.hostId !== "string" ||
    !c.hostId ||
    c.hostId.length > 128 ||
    typeof c.bindAddress !== "string" ||
    !c.bindAddress ||
    c.bindAddress.length > 253 ||
    !Number.isInteger(c.port) ||
    c.port < 0 ||
    c.port > 65535 ||
    !["read", "control"].includes(c.access)
  )
    throw new Error("Invalid Fleet hosting configuration");
  const workspaces = validateWorkspaces(c.workspaces);
  for (const file of c.enabled
    ? [c.tlsCertificateFile, c.tlsKeyFile, c.grantFile]
    : [c.grantFile])
    if (typeof file !== "string" || !path.isAbsolute(file))
      throw new Error("Fleet hosting paths must be absolute");
  if (c.originEndpoint !== undefined) {
    if (typeof c.originEndpoint !== "string")
      throw new Error("Invalid Fleet Android Origin endpoint");
    if (originAuthority(c.originEndpoint).port !== c.port)
      throw new Error("Remote Origin endpoint port must equal the bound port");
  }
  return { ...c, workspaces };
}
export class FleetHostService {
  #access: RemoteHostAccess | undefined;
  #server: RemoteHostTransport | undefined;
  #config: FleetHostConfig | undefined;
  #error: string | undefined;
  #workspaceError: string | undefined;
  #scopeRefreshing = false;
  #relay: Awaited<ReturnType<typeof connectFleetRelayHost>> | undefined;
  #relayAbort: AbortController | undefined;
  #relayError: string | undefined;
  #operations: Promise<unknown> = Promise.resolve();
  constructor(
    readonly appServer: ZenAppServer,
    readonly rooms: RemoteRoomsPort,
  ) {}
  async control(action: string, input?: unknown): Promise<unknown> {
    const operation = this.#operations.then(async () => {
      if (action === "configure")
        return await this.#configure(validateFleetHostConfig(input));
      if (action === "workspaces/refresh") {
        if (this.#config) this.#config.workspaces = [];
        this.#scopeRefreshing = true;
        return this.status();
      }
      if (action === "workspaces") {
        // This is the same object used by RemoteHostAccess's dynamic callback.
        // Replacing only its allowlist keeps the gateway and retained Agents.
        this.#scopeRefreshing = false;
        try {
          const workspaces = validateWorkspaces(input);
          if (this.#config) this.#config.workspaces = workspaces;
          else if (workspaces.length)
            throw new Error("Configure Fleet hosting before its workspaces");
          this.#workspaceError = undefined;
          return this.status();
        } catch (error) {
          if (this.#config) this.#config.workspaces = [];
          this.#workspaceError =
            error instanceof Error
              ? error.message
              : "Fleet workspace update failed";
          throw error;
        }
      }
      if (action === "status") return this.status();
      if (action === "pair") {
        if (!this.#access || !this.#config)
          throw new Error("Enable Fleet hosting first");
        return {
          hostId: this.#config.hostId,
          code: this.#access.createPairingCode(),
        };
      }
      if (action === "revoke") {
        if (!this.#config || typeof input !== "string" || !input)
          throw new Error("Device not found");
        if (this.#access) this.#access.revoke(input);
        else {
          const file = new RemoteGrantFile(
            this.#config.grantFile,
            this.#config.hostId,
          );
          const devices = file.read();
          if (!devices.some((d) => d.deviceId === input))
            throw new Error("Device not found");
          file.write(
            devices.map((d) =>
              d.deviceId === input ? { ...d, revoked: true } : d,
            ),
          );
        }
        return this.status();
      }
      throw new Error("Unsupported Fleet hosting action");
    });
    this.#operations = operation.catch(() => undefined);
    return await operation;
  }
  status() {
    return {
      enabled: !!this.#server,
      relayConnected: !!this.#relay,
      ...(this.#relayError ? { relayError: this.#relayError } : {}),
      hostId: this.#config?.hostId ?? "",
      ...(this.#server
        ? {
            url: this.#server.url
              .replace(/^wss:/, "https:")
              .replace(/\/remote$/, ""),
          }
        : {}),
      clients:
        this.#access?.devices() ??
        (this.#config
          ? new RemoteGrantFile(this.#config.grantFile, this.#config.hostId)
              .read()
              .map(({ digest: _digest, ...device }) => device)
          : []),
      ...(this.#error ? { error: this.#error } : {}),
      ...(this.#workspaceError ? { error: this.#workspaceError } : {}),
    };
  }
  async #configure(config: FleetHostConfig) {
    await this.close();
    this.#config = config;
    this.#error = undefined;
    this.#workspaceError = undefined;
    this.#scopeRefreshing = false;
    if (!config.enabled) return this.status();
    try {
      const keyStat = await stat(config.tlsKeyFile);
      if (
        !keyStat.isFile() ||
        (process.platform !== "win32" && (keyStat.mode & 0o077) !== 0)
      )
        throw new Error("TLS private key must be a private regular file");
      this.#access = new RemoteHostAccess({
        appServer: this.appServer,
        hostId: config.hostId,
        grantFile: config.grantFile,
        access: config.access,
        workspaces: () => {
          if (this.#scopeRefreshing)
            throw new RemoteHostError("scope_refreshing");
          return config.workspaces;
        },
        rooms: this.rooms,
      });
      this.#server = await serveRemoteHost({
        enabled: true,
        listen: config.bindAddress,
        port: config.port,
        tls: {
          cert: await readFile(config.tlsCertificateFile),
          key: await readFile(config.tlsKeyFile),
        },
        access: this.#access,
        ...(config.originEndpoint
          ? { originEndpoint: config.originEndpoint }
          : {}),
      });
      if (config.relayEndpoint) {
        if (!config.relayRegistrationToken)
          throw new Error("Relay registration token missing");
        const url = new URL(this.#server.url.replace(/^wss:/, "https:"));
        if (
          !["127.0.0.1", "localhost", "0.0.0.0", "[::]", "[::1]"].includes(
            url.hostname,
          )
        )
          throw new Error(
            "Relay hosting requires a loopback or all-interface listener",
          );
        if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
        if (url.hostname === "[::]") url.hostname = "[::1]";
        url.pathname = "/";
        const cert = await readFile(config.tlsCertificateFile);
        const dns = new X509Certificate(cert).subjectAltName?.match(
          /(?:^|, )DNS:([a-zA-Z0-9.-]+)/,
        )?.[1];
        const controller = new AbortController();
        this.#relayAbort = controller;
        void this.#relayLoop(config, url.origin, cert, dns, controller);
      }
      return this.status();
    } catch (error) {
      this.#error =
        error instanceof Error ? error.message : "Fleet hosting failed";
      await this.close();
      throw error;
    }
  }
  async #relayLoop(
    config: FleetHostConfig,
    nativeEndpoint: string,
    nativeCa: Buffer,
    nativeServerName: string | undefined,
    controller: AbortController,
  ) {
    let backoff = 1000;
    while (!controller.signal.aborted) {
      try {
        const relay = await connectFleetRelayHost({
          hostId: config.hostId,
          relayEndpoint: config.relayEndpoint!,
          registrationToken: config.relayRegistrationToken!,
          nativeEndpoint,
          nativeCa,
          ...(nativeServerName ? { nativeServerName } : {}),
        });
        if (controller.signal.aborted) {
          await relay.close();
          return;
        }
        this.#relay = relay;
        this.#relayError = undefined;
        backoff = 1000;
        await relay.closed;
        if (this.#relay === relay) this.#relay = undefined;
        if (!controller.signal.aborted)
          this.#relayError = "Relay disconnected; reconnecting";
      } catch (error) {
        if (!controller.signal.aborted)
          this.#relayError =
            error instanceof Error ? error.message : "Relay connection failed";
      }
      if (controller.signal.aborted) return;
      try {
        await delay(backoff, undefined, { signal: controller.signal });
      } catch {
        return;
      }
      backoff = Math.min(backoff * 2, 30000);
    }
  }
  async close() {
    this.#scopeRefreshing = false;
    this.#relayAbort?.abort();
    this.#relayAbort = undefined;
    await this.#relay?.close();
    this.#relay = undefined;
    this.#relayError = undefined;
    await this.#server?.close();
    this.#server = undefined;
    this.#access?.close();
    this.#access = undefined;
  }
}
