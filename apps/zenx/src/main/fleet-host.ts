import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { connectFleetRelayHost } from "./fleet-relay.js";
import { RemoteGrantFile } from "../../../../src/protocol/native/remote-grants.js";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  RemoteHostAccess,
  RemoteHostError,
  type RemoteRoomsPort,
  type RemoteShellPort,
} from "../../../../src/protocol/native/remote-host.js";
import {
  serveRemoteHost,
  originAuthority,
  type RemoteHostTransport,
} from "../../../../src/protocol/native/remote-transport.js";
import type { ZenAppServer } from "../../../../src/app-server.js";
import {
  FLEET_INVITATION_LIFETIME_MS,
  normalizeFleetInvitationEndpoint,
  parseFleetInvitationHostConsent,
  type FleetInvitation,
} from "../fleet-invitation.js";
export interface FleetHostConfig {
  enabled: boolean;
  hostId: string;
  bindAddress: string;
  port: number;
  tlsCertificateFile: string;
  tlsKeyFile: string;
  grantFile: string;
  access: "read" | "control";
  shellEnabled?: boolean;
  relayEndpoint?: string;
  originEndpoint?: string;
  relayRegistrationToken?: string;
  workspaces: Array<{ id: string; label: string; cwd: string }>;
}
/** Current configured authorities only; this never tests network reachability. */
export function fleetInvitationEndpoints(
  config: { originEndpoint?: string; relayEndpoint?: string },
  status: { enabled?: unknown; url?: unknown; relayConnected?: unknown },
): string[] {
  if (status.enabled !== true) return [];
  const values = [
    status.url,
    config.originEndpoint,
    ...(status.relayConnected === true ? [config.relayEndpoint] : []),
  ];
  const endpoints = new Set<string>();
  for (const value of values) {
    if (value === undefined) continue;
    try {
      const normalized = normalizeFleetInvitationEndpoint(value);
      const hostname = new URL(normalized).hostname;
      if (!["0.0.0.0", "[::]"].includes(hostname)) endpoints.add(normalized);
    } catch {
      // Unsupported/currently invalid endpoints are not invitation candidates.
    }
  }
  return [...endpoints];
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
    !["read", "control"].includes(c.access) ||
    (c.shellEnabled !== undefined && typeof c.shellEnabled !== "boolean")
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
  #certificate: X509Certificate | undefined;
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
    readonly shell?: RemoteShellPort,
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
      if (action === "invitation") {
        const data = input as Record<string, unknown>;
        if (
          !data ||
          typeof data !== "object" ||
          Array.isArray(data) ||
          data.confirmed !== true ||
          Object.keys(data).some(
            (key) =>
              !["endpoint", "label", "confirmed", "expected"].includes(key),
          )
        )
          throw new Error(
            "Explicit human confirmation is required to share an invitation",
          );
        const endpoint = normalizeFleetInvitationEndpoint(data.endpoint);
        const expected = parseFleetInvitationHostConsent(data.expected);
        if (
          typeof data.label !== "string" ||
          !data.label.trim() ||
          data.label.length > 120 ||
          /[\x00-\x1f\x7f]/u.test(data.label)
        )
          throw new Error(
            "A Fleet invitation label is required (at most 120 characters)",
          );
        if (!this.#access || !this.#server || !this.#config?.enabled)
          throw new Error(
            "Enable configured Fleet hosting before sharing an invitation",
          );
        if (
          expected.hostId !== this.#config.hostId ||
          expected.access !== this.#config.access ||
          expected.shellEnabled !==
            (this.#config.access === "control" &&
              this.#config.shellEnabled === true) ||
          expected.relayEndpoint !== (this.#config.relayEndpoint ?? null)
        )
          throw new Error(
            "Fleet invitation scope changed; refresh settings and review sharing again",
          );
        if (
          !fleetInvitationEndpoints(this.#config, this.status()).includes(
            endpoint,
          )
        )
          throw new Error(
            "Invitation endpoint must match an existing configured direct Host or connected relay",
          );
        const listenerOrigin = new URL(
          this.#server.url.replace(/^wss:/u, "https:"),
        ).origin;
        if (endpoint === listenerOrigin) {
          const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/gu, "");
          const match = isIP(hostname)
            ? this.#certificate?.checkIP(hostname)
            : this.#certificate?.checkHost(hostname, {
                subject: "never",
                wildcards: false,
              });
          if (!match)
            throw new Error(
              "Direct invitation endpoint must match the running TLS certificate SAN",
            );
        }
        // The canonical RemoteHostAccess grant keeps its existing one-use five
        // minute authority. This preview expires no later than that grant.
        const expiresAt = Date.now() + FLEET_INVITATION_LIFETIME_MS;
        return {
          version: 1,
          hostId: this.#config.hostId,
          endpoint,
          label: data.label,
          expiresAt,
          access: this.#config.access,
          shellEnabled:
            this.#config.access === "control" &&
            this.#config.shellEnabled === true,
          code: this.#access.createPairingCode(),
        } satisfies FleetInvitation;
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
        shellEnabled: config.shellEnabled === true,
        ...(this.shell ? { shell: this.shell } : {}),
      });
      const cert = await readFile(config.tlsCertificateFile);
      this.#certificate = new X509Certificate(cert);
      this.#server = await serveRemoteHost({
        enabled: true,
        listen: config.bindAddress,
        port: config.port,
        tls: {
          cert,
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
        const dns = this.#certificate.subjectAltName?.match(
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
    this.#certificate = undefined;
    this.#access?.close();
    this.#access = undefined;
  }
}
