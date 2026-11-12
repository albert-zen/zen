import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  FleetRouter,
  fleetDeviceKey,
  parseFleetConfig,
  readFleetConfig,
  type FleetConfig,
  type FleetDevice,
  type FleetTransport,
  type NativeFleetDevice,
  type FleetSourceFence,
} from "./fleet.js";
import { NativeFleetClient } from "./fleet-native.js";
import {
  ZenXCredentialVault,
  type LocalEncryption,
} from "./credential-vault.js";
import type { AppServerManager } from "./app-server-manager.js";
import {
  fleetInvitationEndpoints,
  type FleetHostConfig,
} from "./fleet-host.js";
import {
  encodeFleetInvitation,
  normalizeFleetInvitationEndpoint,
  parseFleetInvitationConsent,
  type FleetInvitation,
  type FleetInvitationConsent,
  type FleetReadiness,
} from "../fleet-invitation.js";
import { subscribeSshFleetThread } from "./fleet-ssh-watch.js";
import type { ZenXTriggerAppServerPort } from "./trigger-service.js";

type RemoteSubscriptionOptions = Parameters<
  NonNullable<ZenXTriggerAppServerPort["subscribeRemoteThread"]>
>[3];
interface FleetObservation {
  peer: FleetDevice;
  controller: AbortController;
  options: RemoteSubscriptionOptions;
  dispose?: () => void;
  stop(): void;
}
export interface FleetCheck {
  state: "not_checked" | "checking" | "reachable" | "failed";
  /** Check sessions are closed afterwards; this is never a live socket claim. */
  live: false;
  checkedAt?: number;
  detail?: string;
}
export class FleetSettingsService {
  readonly router: FleetRouter;
  readonly native: NativeFleetClient;
  readonly file: string;
  readonly #vault: ZenXCredentialVault;
  #operation: Promise<unknown> = Promise.resolve();
  #hostId: string | undefined;
  #restoredEpoch: string | undefined;
  #restoredManager: AppServerManager | undefined;
  #restoredHosting: string | undefined;
  #scopeGeneration = 0;
  #sourceGeneration = 0;
  #error: string | undefined;
  readonly #observations = new Set<FleetObservation>();
  readonly #checks = new Map<string, { identity: string; check: FleetCheck }>();
  constructor(
    readonly options: {
      directory: string;
      encryption: LocalEncryption;
      nativeCa?: string | Buffer;
      manager: () => AppServerManager;
      workspaces: () => Promise<Array<{ cwd: string; label: string }>>;
      /** Read-only transport seams for deterministic adapter/stream fixtures. */
      sshTransport?: FleetTransport;
      sshWatchLaunch?: Parameters<typeof subscribeSshFleetThread>[5];
    },
  ) {
    this.file = path.join(options.directory, "fleet.json");
    const vault = new ZenXCredentialVault(
      path.join(options.directory, "fleet-vault.json"),
      options.encryption,
    );
    this.#vault = vault;
    this.native = new NativeFleetClient({
      ...(options.nativeCa ? { ca: options.nativeCa } : {}),
      credentials: {
        get: async (id) => {
          const value = await vault.readApiKey(`device:${id}`);
          return value ? JSON.parse(value) : null;
        },
        set: async (id, value) =>
          vault.writeApiKey(`device:${id}`, JSON.stringify(value)),
        delete: async (id) => vault.clearApiKey(`device:${id}`),
      },
    });
    this.router = new FleetRouter(
      () => readFleetConfig(this.file),
      options.sshTransport,
      this.native,
      async (invocation) => {
        const hostId = await this.#existingIdentity();
        const config = await this.config();
        if (!hostId || !config.hosting?.enabled || !invocation.threadId)
          return undefined;
        const { thread } = await this.options
          .manager()
          .request("zen/thread/read", { threadId: invocation.threadId });
        const call = thread.items.find(
          (item) =>
            item.type === "tool_call" &&
            item.id === invocation.canonicalToolCallId &&
            item.callId === invocation.callId,
        );
        if (!call)
          throw new Error(
            "Fleet source does not match the canonical tool call",
          );
        const workspace = (await this.#workspaceAllowlist()).find(
          (value) => value.cwd === thread.cwd,
        );
        if (!workspace) return undefined;
        return {
          origin: { hostId, workspaceId: workspace.id },
          ...(thread.name ? { threadName: thread.name.slice(0, 512) } : {}),
        };
      },
    );
  }
  #relayKey(endpoint: string): string {
    return `relay:${createHash("sha256").update(endpoint).digest("hex")}`;
  }
  async #existingIdentity(): Promise<string | undefined> {
    if (this.#hostId) return this.#hostId;
    const file = path.join(this.options.directory, "fleet-host-id");
    try {
      const id = (await readFile(file, "utf8")).trim();
      if (!/^[a-zA-Z0-9-]{1,128}$/.test(id))
        throw new Error("Invalid Fleet Host identity");
      return (this.#hostId = id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return undefined;
  }
  async #identity(): Promise<string> {
    const existing = await this.#existingIdentity();
    if (existing) return existing;
    const file = path.join(this.options.directory, "fleet-host-id");
    const id = randomUUID();
    await mkdir(this.options.directory, { recursive: true });
    try {
      await writeFile(file, id + "\n", { mode: 0o600, flag: "wx" });
      return (this.#hostId = id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        return this.#identity();
      throw error;
    }
  }
  async config() {
    return await readFleetConfig(this.file);
  }
  async devices(snapshot?: FleetConfig) {
    const config = snapshot ?? (await this.config());
    const catalog = await this.router.devices(config);
    return catalog.map((device) => {
      const peer = config.devices.find((entry) => entry.id === device.id);
      const observation = peer ? this.#checks.get(peer.id) : undefined;
      const check: FleetCheck =
        observation &&
        peer &&
        observation.identity === fleetObservationIdentity(peer)
          ? { ...observation.check }
          : { state: "not_checked", live: false };
      return { ...device, check };
    });
  }
  async status() {
    const config = await this.config();
    const hostId = await this.#identity();
    let host: unknown;
    try {
      host = await this.options.manager().fleetControl("status");
    } catch (error) {
      host = {
        enabled: false,
        clients: [],
        error: error instanceof Error ? error.message : "Host unavailable",
      };
    }
    return {
      revision: config.revision ?? 0,
      config,
      devices: await this.devices(config),
      host: {
        ...(host as object),
        hostId,
        relayConfigured: !!(
          config.hosting?.relayEndpoint &&
          (await this.#vault.hasApiKey(
            this.#relayKey(config.hosting.relayEndpoint),
          ))
        ),
        ...(this.#error ? { error: this.#error } : {}),
      },
    };
  }
  /** Public discovery facts only; no listener, probe, pairing or identity write. */
  async readiness(): Promise<FleetReadiness> {
    let config: FleetConfig;
    try {
      config = await this.config();
    } catch {
      // JSON/filesystem errors can quote credential-bearing malformed input.
      throw new Error(
        "Fleet configuration could not be read; open Fleet settings for details",
      );
    }
    let current: Record<string, unknown> = {};
    let hostUnavailable = false;
    try {
      const value = await this.options.manager().fleetControl("status");
      if (fleetRecord(value)) current = value;
      else hostUnavailable = true;
    } catch {
      hostUnavailable = true;
    }
    let hostId: string | null = null;
    try {
      hostId = (await this.#existingIdentity()) ?? null;
    } catch {
      hostUnavailable = true;
    }
    if (
      typeof current.hostId === "string" &&
      /^[a-zA-Z0-9-]{1,128}$/u.test(current.hostId)
    )
      hostId = current.hostId;
    const hosting = config.hosting;
    let relayConfigured = false;
    let vaultUnavailable = false;
    if (hosting?.relayEndpoint) {
      try {
        relayConfigured = await this.#vault.hasApiKey(
          this.#relayKey(hosting.relayEndpoint),
        );
      } catch {
        vaultUnavailable = true;
      }
    }
    let url: string | undefined;
    if (typeof current.url === "string") {
      try {
        url = normalizeFleetInvitationEndpoint(current.url);
      } catch {
        hostUnavailable = true;
      }
    }
    const enabled = current.enabled === true;
    const endpoints = fleetInvitationEndpoints(hosting ?? {}, {
      enabled,
      ...(url ? { url } : {}),
      relayConnected: current.relayConnected === true,
    });
    const devices = (await this.devices(config)).map(
      ({ check, ...device }) => ({
        ...device,
        check: {
          state: check.state,
          live: false as const,
          ...(check.checkedAt === undefined
            ? {}
            : { checkedAt: check.checkedAt }),
          ...(check.state === "failed"
            ? {
                detail:
                  "Last check failed; open Fleet settings or run an explicit probe for details",
              }
            : {}),
        },
      }),
    );
    return {
      source: "zenx.fleet",
      revision: config.revision ?? 0,
      host: {
        configured: hosting !== undefined,
        enabled,
        hostId,
        access: hosting?.access ?? "read",
        shellEnabled:
          hosting?.access === "control" && hosting.shellEnabled === true,
        ...(url ? { url } : {}),
        ...(hosting?.originEndpoint
          ? { originEndpoint: hosting.originEndpoint }
          : {}),
        ...(hosting?.relayEndpoint
          ? { relayEndpoint: hosting.relayEndpoint }
          : {}),
        relayConnected: current.relayConnected === true,
        relayConfigured,
        ...(hostUnavailable ||
        current.error ||
        current.relayError ||
        this.#error ||
        vaultUnavailable
          ? {
              error:
                "Fleet Host or credentials need attention; open Fleet settings for details",
            }
          : {}),
      },
      devices,
      prerequisites: {
        credentialEncryption: this.options.encryption.isEncryptionAvailable(),
        tlsConfigured: !!(hosting?.tlsCertificateFile && hosting.tlsKeyFile),
        hostEnabled: enabled,
        trustedEndpointConfigured: endpoints.length > 0,
        relayCredentialConfigured: relayConfigured,
      },
      limits: [
        "Only user-configured peers are discovered; no automatic network scan, rendezvous or pairing.",
        "Direct HTTPS needs a certificate trusted by the client and a route to the Host. Listener state and timestamped checks do not prove current client reachability.",
        "Different networks need routing or a VPN arranged by the user, or an already configured reachable relay. Fleet does not set up routers, VPNs, certificates or relays.",
        "A relay is a trusted TLS termination point that can see pairing, requests and events; relay transport is not end-to-end encrypted.",
        "Invitations are human-only bearer secrets, expire within five minutes and can pair once. Host and client grants still bound control and shell access.",
      ],
    };
  }
  async #write(config: FleetConfig) {
    await mkdir(this.options.directory, { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(config) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, this.file);
  }
  #assertCurrentScope(
    manager: AppServerManager,
    epoch: string,
    scopeGeneration: number,
  ) {
    if (
      this.options.manager() !== manager ||
      ("processEpoch" in manager && manager.processEpoch !== epoch)
    )
      throw new Error(
        "Fleet Host or settings changed during configuration; refresh again",
      );
    if (scopeGeneration !== this.#scopeGeneration)
      throw new Error(
        "Fleet workspace scope changed during configuration; refresh again",
      );
  }
  async #assertCurrentHost(
    manager: AppServerManager,
    epoch: string,
    config: FleetConfig,
    scopeGeneration: number,
  ) {
    const current = await manager.currentConfiguration();
    const latest = await this.config();
    if (
      current.processEpoch !== epoch ||
      (latest.revision ?? 0) !== (config.revision ?? 0) ||
      JSON.stringify(latest.hosting) !== JSON.stringify(config.hosting)
    )
      throw new Error(
        "Fleet Host or settings changed during configuration; refresh again",
      );
    this.#assertCurrentScope(manager, epoch, scopeGeneration);
  }
  async #workspaceAllowlist(): Promise<FleetHostConfig["workspaces"]> {
    return (await this.options.workspaces()).map((w) => ({
      id: createHash("sha256").update(w.cwd).digest("hex").slice(0, 24),
      label: w.label,
      cwd: w.cwd,
    }));
  }
  async #hostInput(
    config: FleetConfig,
    workspaces: FleetHostConfig["workspaces"],
    disabled = false,
  ): Promise<FleetHostConfig> {
    const hosting = config.hosting ?? {
      enabled: false,
      bindAddress: "127.0.0.1",
      port: 0,
      tlsCertificateFile: "",
      tlsKeyFile: "",
      access: "read" as const,
    };
    const registrationToken = hosting.relayEndpoint
      ? await this.#vault.readApiKey(this.#relayKey(hosting.relayEndpoint))
      : undefined;
    if (
      !disabled &&
      hosting.enabled &&
      hosting.relayEndpoint &&
      !registrationToken
    )
      throw new Error("Relay registration token required for this endpoint");
    return {
      ...hosting,
      ...(disabled ? { enabled: false } : {}),
      ...(registrationToken
        ? { relayRegistrationToken: registrationToken }
        : {}),
      hostId: await this.#identity(),
      grantFile: path.join(this.options.directory, "fleet-device-grants.json"),
      workspaces,
      ...(config.messageSources
        ? {
            messageSources: config.messageSources.filter((binding) =>
              config.devices.some(
                (peer) =>
                  peer.transport === "https" &&
                  peer.id === binding.deviceId &&
                  peer.hostId === binding.hostId &&
                  fleetDeviceKey(peer) === binding.deviceKey,
              ),
            ),
          }
        : {}),
    };
  }
  async #failClosed(
    manager: AppServerManager,
    config: FleetConfig,
    error: unknown,
    superseded = false,
  ): Promise<never> {
    const cause =
      error instanceof Error ? error.message : "Fleet configuration failed";
    let outcome: string;
    try {
      // A newer Project refresh is already queued. Keep its empty scope
      // transient until that operation applies or fails; permanent clearing
      // between generations would fatally terminate retained workspace watches.
      const status = (await manager.fleetControl(
        superseded ? "workspaces/refresh" : "workspaces",
        superseded ? undefined : [],
      )) as
        | {
            enabled?: boolean;
          }
        | undefined;
      outcome =
        status?.enabled === true
          ? "Remote workspace access disabled; Fleet gateway remains running"
          : "Remote workspace access disabled; Fleet gateway is stopped";
      if (superseded) outcome += "; newer workspace refresh pending";
    } catch {
      this.#restoredEpoch = undefined;
      try {
        await manager.fleetControl(
          "configure",
          await this.#hostInput(config, [], true),
        );
        outcome = "Fleet gateway stopped";
      } catch {
        // An unacknowledged allowlist/disable RPC cannot prove the old scope
        // closed. Stop the owned Host, rather than leave stale access enabled.
        try {
          await manager.stop();
          outcome =
            "Fleet Host stopped because workspace access could not be disabled";
        } catch (stopError) {
          outcome = `Fleet Host stop could not be confirmed: ${stopError instanceof Error ? stopError.message : "shutdown failed"}`;
        }
      }
    }
    this.#error = `${cause}. ${outcome}`;
    throw new Error(this.#error, { cause: error });
  }
  async #synchronizeHost(config: FleetConfig, forceConfigure = false) {
    const manager = this.options.manager();
    const scopeGeneration = this.#scopeGeneration;
    try {
      const epoch = (await manager.currentConfiguration()).processEpoch;
      await this.#assertCurrentHost(manager, epoch, config, scopeGeneration);
      // Revocation happens before asynchronous path resolution. A blocked or
      // failed resolver has an empty scope, never the previous allowlist.
      // Pending scope has a distinct read-only reconnectable error so retained
      // workspace watches survive it. Final apply/failure clears pending state.
      // This transient clearing does not close the gateway or retained Agents.
      this.#assertCurrentScope(manager, epoch, scopeGeneration);
      await manager.fleetControl("workspaces/refresh");
      const workspaces = config.hosting?.enabled
        ? await this.#workspaceAllowlist()
        : [];
      await this.#assertCurrentHost(manager, epoch, config, scopeGeneration);
      if (
        !forceConfigure &&
        manager === this.#restoredManager &&
        epoch === this.#restoredEpoch &&
        JSON.stringify([config.hosting, config.messageSources]) ===
          this.#restoredHosting
      ) {
        this.#assertCurrentScope(manager, epoch, scopeGeneration);
        await manager.fleetControl("workspaces", workspaces);
      } else {
        const input = await this.#hostInput(config, workspaces);
        await this.#assertCurrentHost(manager, epoch, config, scopeGeneration);
        this.#assertCurrentScope(manager, epoch, scopeGeneration);
        await manager.fleetControl("configure", input);
      }
      await this.#assertCurrentHost(manager, epoch, config, scopeGeneration);
      this.#restoredManager = manager;
      this.#restoredEpoch = epoch;
      this.#restoredHosting = JSON.stringify([
        config.hosting,
        config.messageSources,
      ]);
      this.#error = undefined;
    } catch (error) {
      await this.#failClosed(
        manager,
        config,
        error,
        scopeGeneration !== this.#scopeGeneration,
      );
    }
  }
  async restore() {
    ++this.#sourceGeneration;
    return await this.#queue(async () => {
      try {
        await this.#synchronizeHost(await this.config());
      } catch {
        // Startup/reconnection reports the explicit fail-closed error in status.
      }
    });
  }
  async refreshWorkspaces() {
    // Project edits precede this call and are not Fleet settings revisions.
    // Invalidate an older resolver before joining the mutation queue so it
    // cannot re-apply its captured scope after a newer Project removal.
    ++this.#scopeGeneration;
    return await this.#queue(async () => {
      await this.#synchronizeHost(await this.config());
    });
  }
  #queue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(action);
    this.#operation = result.catch(() => undefined);
    return result;
  }
  async save(input: unknown, expectedRevision?: number) {
    ++this.#sourceGeneration;
    return await this.#queue(async () => {
      const current = await this.config();
      if (
        expectedRevision !== undefined &&
        expectedRevision !== (current.revision ?? 0)
      )
        throw new Error("Fleet settings changed; refresh before saving");
      const safe = structuredClone(input) as {
        hosting?: Record<string, unknown>;
      };
      const registrationToken = safe?.hosting?.relayRegistrationToken;
      if (safe?.hosting) delete safe.hosting.relayRegistrationToken;
      const config = parseFleetConfig(safe);
      if (registrationToken !== undefined) {
        if (
          typeof registrationToken !== "string" ||
          !registrationToken.trim() ||
          registrationToken.length > 4096 ||
          !config.hosting?.relayEndpoint
        )
          throw new Error("Relay endpoint and registration token required");
        await this.#vault.writeApiKey(
          this.#relayKey(config.hosting.relayEndpoint),
          registrationToken,
        );
      }
      for (const binding of config.messageSources ?? []) {
        if (
          current.messageSources?.some(
            (entry) => JSON.stringify(entry) === JSON.stringify(binding),
          )
        )
          continue;
        const peer = config.devices.find(
          (entry) => entry.id === binding.deviceId,
        );
        if (
          !peer ||
          peer.transport !== "https" ||
          peer.hostId !== binding.hostId ||
          fleetDeviceKey(peer) !== binding.deviceKey
        )
          throw new Error(
            "Return binding requires the exact existing HTTPS peer/key",
          );
        const bindingManager = this.options.manager();
        const bindingHostId = await this.#existingIdentity();
        const host = (await bindingManager.fleetControl("status")) as {
          enabled?: boolean;
          hostId?: string;
          clients?: Array<{
            deviceId: string;
            revoked: boolean;
            access?: string;
          }>;
        };
        if (
          !host.enabled ||
          !bindingHostId ||
          host.hostId !== bindingHostId ||
          !host.clients?.some(
            (entry) =>
              entry.deviceId === binding.inboundDeviceId &&
              !entry.revoked &&
              entry.access === "control",
          )
        )
          throw new Error(
            "Return binding requires an existing active inbound grant",
          );
        const result = (await this.native.invoke(
          peer,
          {
            version: 1,
            name: "zenx_projects_list",
            callId: randomUUID(),
            arguments: { limit: 100 },
          },
          AbortSignal.timeout(10000),
        )) as { projects?: Array<{ id: string }> };
        if (!result.projects?.some((entry) => entry.id === binding.workspaceId))
          throw new Error(
            "Return binding workspace is not available through the existing grant",
          );
        const currentHost = (await bindingManager.fleetControl(
          "status",
        )) as typeof host;
        if (
          this.options.manager() !== bindingManager ||
          currentHost.hostId !== bindingHostId ||
          !currentHost.enabled ||
          !currentHost.clients?.some(
            (entry) =>
              entry.deviceId === binding.inboundDeviceId &&
              !entry.revoked &&
              entry.access === "control",
          )
        )
          throw new Error(
            "Incoming grant changed while validating its return binding",
          );
      }
      config.revision = (current.revision ?? 0) + 1;
      await this.#write(config);
      this.#invalidateObservations(config);
      if (
        JSON.stringify(current.hosting) !== JSON.stringify(config.hosting) ||
        JSON.stringify(current.messageSources) !==
          JSON.stringify(config.messageSources) ||
        (!!config.messageSources?.length &&
          JSON.stringify(current.devices) !== JSON.stringify(config.devices)) ||
        this.#error !== undefined ||
        registrationToken !== undefined
      ) {
        try {
          await this.#synchronizeHost(config, true);
        } catch (error) {
          this.#error =
            error instanceof Error ? error.message : "Fleet hosting failed";
          throw new Error(
            `Settings saved, but hosting did not start: ${this.#error}`,
          );
        }
      }
      return await this.status();
    });
  }
  async pair(input: unknown) {
    ++this.#sourceGeneration;
    return await this.#queue(async () => {
      const data = input as Record<string, unknown>;
      if (
        !data ||
        typeof data.code !== "string" ||
        !data.code ||
        data.code.length > 512
      )
        throw new Error("One-time pairing code required");
      const { code, ...fields } = data;
      const peer = parseFleetConfig({
        version: 1,
        devices: [{ ...fields, transport: "https" }],
      }).devices[0] as NativeFleetDevice;
      const config = await this.config();
      if (
        config.devices.some(
          (d) =>
            d.id === peer.id &&
            (d.transport !== "https" ||
              d.hostId !== peer.hostId ||
              d.endpoint !== peer.endpoint),
        )
      )
        throw new Error(
          "Remove the old device identity before pairing a different Host",
        );
      if (!this.options.encryption.isEncryptionAvailable())
        throw new Error(
          "Fleet pairing requires operating-system credential encryption. Unlock the system keychain or credential store before pairing; no remote grant was requested.",
        );
      await this.native.pair(peer, code);
      this.#stopDeviceObservations(
        peer.id,
        "Fleet device pairing changed; source observation stopped. Resume the Trigger after reviewing the device.",
      );
      config.devices = [
        ...config.devices.filter((d) => d.id !== peer.id),
        peer,
      ];
      config.revision = (config.revision ?? 0) + 1;
      try {
        await this.#write(config);
      } catch (error) {
        throw new Error(
          "Pairing succeeded but local device list could not be saved; inspect before pairing again",
          { cause: error },
        );
      }
      return await this.status();
    });
  }
  async remove(id: string) {
    ++this.#sourceGeneration;
    return await this.#queue(async () => {
      const config = await this.config();
      const peer = config.devices.find((d) => d.id === id);
      if (!peer) throw new Error("Device not found");
      if (peer.transport === "https") {
        await this.native.forget(peer);
        this.#stopDeviceObservations(
          id,
          "Fleet device authorization was removed; source observation stopped.",
        );
      }
      config.devices = config.devices.filter((d) => d.id !== id);
      config.revision = (config.revision ?? 0) + 1;
      await this.#write(config);
      this.#invalidateObservations(config);
      return await this.status();
    });
  }
  async test(
    id: string,
    signal: AbortSignal = AbortSignal.timeout(10000),
    expectedDeviceKey?: string,
  ) {
    signal.throwIfAborted();
    const peer = (await this.config()).devices.find((d) => d.id === id);
    if (!peer) throw new Error("Device not found");
    if (
      expectedDeviceKey !== undefined &&
      fleetDeviceKey(peer) !== expectedDeviceKey
    )
      throw new Error("Fleet machine changed before probe; no request sent");
    const identity = fleetObservationIdentity(peer);
    this.#checks.set(id, {
      identity,
      check: { state: "checking", live: false },
    });
    try {
      const result =
        peer.transport === "https"
          ? await this.native.test(peer, signal)
          : await this.invoke(
              {
                device: id,
                expectedDeviceKey: fleetDeviceKey(peer),
                name: "zenx_threads_list",
                arguments: { limit: 1 },
              },
              signal,
            );
      this.#checks.set(id, {
        identity,
        check: { state: "reachable", live: false, checkedAt: Date.now() },
      });
      return result;
    } catch (error) {
      this.#checks.set(id, {
        identity,
        check: {
          state: "failed",
          live: false,
          checkedAt: Date.now(),
          detail: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }
  async invoke(
    input: {
      device: string;
      name: string;
      arguments: Record<string, unknown>;
      expectedDeviceKey?: string;
    },
    signal?: AbortSignal,
  ) {
    if (
      !input ||
      typeof input.device !== "string" ||
      typeof input.name !== "string" ||
      !input.arguments ||
      typeof input.arguments !== "object" ||
      Array.isArray(input.arguments)
    )
      throw new Error("Invalid Fleet operation");
    return await this.router.invoke(
      input.device,
      {
        name: input.name,
        arguments: input.arguments,
        callId: randomUUID(),
        canonicalToolCallId: randomUUID(),
        cwd: this.options.directory,
        signal: signal ?? AbortSignal.timeout(40000),
      },
      input.expectedDeviceKey,
    );
  }
  /** Short-lived authority fence. No credentials or snapshots leave this process. */
  #sourceFence(manager: AppServerManager) {
    const generation = this.#sourceGeneration;
    const scope = this.#scopeGeneration;
    const epoch = manager.processEpoch;
    const fingerprint = () => {
      const hash = createHash("sha256");
      for (const file of [
        this.file,
        "fleet-host-id",
        "fleet-device-grants.json",
        "fleet-vault.json",
      ]) {
        const absolute = path.isAbsolute(file)
          ? file
          : path.join(this.options.directory, file);
        try {
          const stat = statSync(absolute, { bigint: true });
          if (!stat.isFile() || stat.size > 4n * 1024n * 1024n)
            throw new Error("Invalid Fleet source authority file");
          hash.update(
            JSON.stringify([
              absolute,
              String(stat.ino),
              String(stat.size),
              String(stat.mtimeNs),
              String(stat.ctimeNs),
            ]),
          );
          hash.update(readFileSync(absolute));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          hash.update(absolute + ":missing");
        }
      }
      return hash.digest("hex");
    };
    const captured = fingerprint();
    return () => {
      if (
        this.options.manager() !== manager ||
        manager.processEpoch !== epoch ||
        this.#sourceGeneration !== generation ||
        this.#scopeGeneration !== scope ||
        fingerprint() !== captured
      )
        throw new Error(
          "Fleet source authorization changed during this operation; no stale result or unsent reply was released",
        );
    };
  }
  /** Exact canonical receipt lookup. Caller-supplied names/routes never choose a peer. */
  async messageSource(
    input: FleetMessageSourceRequest,
    reply?: import("../../../../src/tool.js").ToolInvocation,
  ): Promise<FleetMessageSourceView | unknown> {
    if (
      !input ||
      typeof input.threadId !== "string" ||
      !input.threadId ||
      typeof input.itemId !== "string" ||
      !input.itemId
    )
      throw new Error(
        "Exact receiving Thread and message Item IDs are required",
      );
    if (
      reply &&
      (reply.trustedPluginUi === true ||
        !reply.threadId ||
        !reply.canonicalToolCallId ||
        !reply.callId)
    )
      throw new Error(
        "Source replies require a canonical Agent tool call; human-message fallback is not supported",
      );
    const manager = this.options.manager();
    const assertUnchanged = this.#sourceFence(manager);
    const { thread } = await manager.request("zen/thread/read", {
      threadId: input.threadId,
    });
    assertUnchanged();
    const message = thread.items.find((item) => item.id === input.itemId);
    if (
      !message ||
      (message.type !== "thread_message" &&
        message.type !== "thread_message_queued") ||
      !message.sender.deviceId ||
      !message.sender.returnRoute
    )
      throw new Error(
        "This remote message has no verified return binding. Configure its existing inbound grant and outbound HTTPS peer; no local fallback was attempted.",
      );
    const sender = message.sender;
    const route = sender.returnRoute!;
    let authorization: string | undefined;
    const assertCurrent = async () => {
      assertUnchanged();
      const config = await this.config();
      const hostId = await this.#existingIdentity();
      if (
        this.options.manager() !== manager ||
        hostId !== route.receiverHostId ||
        !config.hosting?.enabled ||
        !config.messageSources?.some(
          (entry) =>
            entry.inboundDeviceId === sender.deviceId &&
            entry.hostId === route.hostId &&
            entry.workspaceId === route.workspaceId &&
            entry.deviceId === route.deviceId &&
            entry.deviceKey === route.deviceKey,
        )
      )
        throw new Error(
          "The message return binding is missing or changed. Review it in Fleet settings; the source was not retargeted.",
        );
      const peer = config.devices.find((entry) => entry.id === route.deviceId);
      if (
        !peer ||
        peer.transport !== "https" ||
        peer.hostId !== route.hostId ||
        fleetDeviceKey(peer) !== route.deviceKey
      )
        throw new Error(
          "The message source machine was removed or reconfigured; the source was not retargeted.",
        );
      const status = structuredClone(await manager.fleetControl("status")) as {
        enabled?: boolean;
        hostId?: string;
        clients?: Array<{
          deviceId: string;
          revoked: boolean;
          access?: string;
          workspaceIds?: readonly string[] | null;
        }>;
      };
      const receiverWorkspace = (await this.#workspaceAllowlist()).find(
        (entry) => entry.cwd === thread.cwd,
      )?.id;
      const currentStatus = await manager.fleetControl("status");
      // Compare across workspace resolution, then synchronously fence every
      // local authority/credential and Host epoch after the final await.
      assertUnchanged();
      const statusKey = JSON.stringify(status);
      if (
        JSON.stringify(currentStatus) !== statusKey ||
        (authorization !== undefined && authorization !== statusKey)
      )
        throw new Error(
          "Fleet source inbound authorization changed during validation",
        );
      authorization = statusKey;
      if (
        !receiverWorkspace ||
        config.hosting?.access !== "control" ||
        !status.enabled ||
        status.hostId !== route.receiverHostId ||
        !status.clients?.some(
          (entry) =>
            entry.deviceId === sender.deviceId &&
            !entry.revoked &&
            entry.access === "control" &&
            (entry.workspaceIds === null ||
              entry.workspaceIds?.includes(receiverWorkspace)),
        )
      )
        throw new Error("The source's inbound grant is unavailable or revoked");
      return peer;
    };
    await assertCurrent();
    const locator = {
      deviceId: route.deviceId,
      deviceKey: route.deviceKey,
      hostId: route.hostId,
      workspace: route.workspaceId,
      threadId: sender.threadId,
    };
    const history = await this.invoke(
      {
        device: route.deviceId,
        expectedDeviceKey: route.deviceKey,
        name: "zenx_threads_read",
        arguments: {
          workspace: route.workspaceId,
          threadId: sender.threadId,
          granularity: "items",
          maxItemsPerTurn: 25,
        },
      },
      reply?.signal,
    );
    const value = (history as { result?: Record<string, unknown> }).result;
    if (
      !value ||
      value.status === "not_found" ||
      value.status === "ambiguous" ||
      value.threadId !== sender.threadId
    )
      throw new Error(
        "The exact source Thread is missing, archived or inaccessible; no name or local fallback was attempted.",
      );
    const peer = await assertCurrent();
    if (reply) {
      if (peer.access !== "control")
        throw new Error(
          "The existing return grant is read-only; a human must explicitly configure control before replying",
        );
      return await this.router.invoke(
        route.deviceId,
        {
          ...reply,
          name: "zenx_threads_send",
          arguments: {
            workspace: route.workspaceId,
            threadId: sender.threadId,
            text: reply.arguments.text,
            messageType: reply.arguments.messageType ?? "guidance",
          },
        },
        route.deviceKey,
        { revalidate: assertCurrent, assertUnchanged },
      );
    }
    assertUnchanged();
    return {
      receipt: { ...input },
      locator,
      history: value,
    } satisfies FleetMessageSourceView;
  }
  sourceTargetFence(
    receipt: FleetMessageSourceRequest,
    locator: import("./fleet-product.js").FleetThreadLocator,
  ): FleetSourceFence {
    const assertUnchanged = this.#sourceFence(this.options.manager());
    return {
      assertUnchanged,
      revalidate: async () => {
        assertUnchanged();
        await this.assertMessageSourceTarget(receipt, locator);
        assertUnchanged();
      },
    };
  }
  async assertMessageSourceTarget(
    receipt: FleetMessageSourceRequest,
    locator: import("./fleet-product.js").FleetThreadLocator,
  ) {
    const source = (await this.messageSource(
      receipt,
    )) as FleetMessageSourceView;
    for (const key of ["deviceId", "deviceKey", "hostId", "workspace"] as const)
      if (!locator || locator[key] !== source.locator[key])
        throw new Error(
          "Source navigation must stay on its verified Host and workspace",
        );
  }
  async hostPair() {
    return await this.options.manager().fleetControl("pair");
  }
  /** Human renderer entry only. No model tool or persistent invitation state. */
  async hostInvitation(input: unknown): Promise<{
    invitation: FleetInvitation;
    serialized: string;
  }> {
    if (
      !fleetRecord(input) ||
      input.confirmed !== true ||
      Object.keys(input).some(
        (key) => !["endpoint", "label", "confirmed", "expected"].includes(key),
      )
    )
      throw new Error(
        "Explicit human confirmation is required to share an invitation",
      );
    const endpoint = normalizeFleetInvitationEndpoint(input.endpoint);
    if (
      typeof input.label !== "string" ||
      !input.label.trim() ||
      input.label.length > 120 ||
      /[\x00-\x1f\x7f]/u.test(input.label)
    )
      throw new Error(
        "A Fleet invitation label is required (at most 120 characters)",
      );
    const label = input.label;
    const expected = parseFleetInvitationConsent(input.expected);
    return await this.#queue(async () => {
      const config = await this.config();
      if (!config.hosting?.enabled)
        throw new Error(
          "Enable configured Fleet hosting before sharing an invitation",
        );
      const manager = this.options.manager();
      const hostId = await this.#existingIdentity();
      assertFleetInvitationConsent(config, hostId, expected);
      const current = await manager.fleetControl("status");
      if (
        !fleetRecord(current) ||
        current.enabled !== true ||
        !hostId ||
        current.hostId !== hostId
      )
        throw new Error(
          "Fleet Host changed; refresh settings and review sharing again",
        );
      const candidates = fleetInvitationEndpoints(config.hosting, current);
      if (!candidates.includes(endpoint))
        throw new Error(
          "Invitation endpoint must match an existing configured direct Host or connected relay",
        );
      if (this.options.manager() !== manager)
        throw new Error(
          "Fleet Host changed; refresh before creating an invitation",
        );
      assertFleetInvitationConsent(await this.config(), hostId, expected);
      const issued = await manager.fleetControl("invitation", {
        endpoint,
        label,
        confirmed: true,
        expected: {
          hostId: expected.hostId,
          access: expected.access,
          shellEnabled: expected.shellEnabled,
          relayEndpoint: expected.relayEndpoint,
        },
      });
      if (
        !fleetRecord(issued) ||
        issued.hostId !== hostId ||
        issued.endpoint !== endpoint ||
        issued.label !== label ||
        issued.access !== expected.access ||
        issued.shellEnabled !== expected.shellEnabled ||
        this.options.manager() !== manager
      )
        throw new Error(
          "Fleet invitation scope changed; refresh settings and review sharing again",
        );
      const invitation = issued as unknown as FleetInvitation;
      const serialized = encodeFleetInvitation(invitation);
      return { invitation, serialized };
    });
  }
  async revoke(deviceId: string) {
    ++this.#sourceGeneration;
    if (typeof deviceId !== "string" || !deviceId)
      throw new Error("Device required");
    return await this.options.manager().fleetControl("revoke", deviceId);
  }

  async #peer(device: string): Promise<FleetDevice> {
    if (typeof device !== "string" || !device || device === "local")
      throw new Error("Choose a configured remote Fleet source device");
    const peer = (await this.config()).devices.find(
      (entry) => entry.id === device,
    );
    if (!peer) throw new Error(`Unknown Fleet source device: ${device}`);
    return peer;
  }

  async #assertPeer(peer: FleetDevice): Promise<void> {
    const current = (await this.config()).devices.find(
      (entry) => entry.id === peer.id,
    );
    if (
      !current ||
      fleetObservationIdentity(current) !== fleetObservationIdentity(peer)
    )
      throw new Error(
        "Fleet source device was removed or retargeted; observation stopped. Review the source before resuming.",
      );
  }

  async #observeRead(
    peer: FleetDevice,
    name: string,
    args: Record<string, unknown>,
    signal = AbortSignal.timeout(40_000),
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    await this.#assertPeer(peer);
    const request = {
      version: 1 as const,
      name,
      arguments: args,
      callId: randomUUID(),
    };
    const result =
      peer.transport === "https"
        ? await this.native.invoke(peer, request, signal)
        : await this.router.transport(peer, request, signal);
    signal.throwIfAborted();
    await this.#assertPeer(peer);
    if (!fleetRecord(result)) throw new Error("Invalid Fleet source response");
    return result;
  }

  async resolveRemoteThread(
    device: string,
    workspace: string | undefined,
    target: string,
  ): Promise<{ threadId: string; workspace: string }> {
    const peer = await this.#peer(device);
    const result = await this.#observeRead(peer, "zenx_threads_read", {
      target: fleetSourceString(target, "Thread target"),
      ...(workspace === undefined
        ? {}
        : { workspace: fleetSourceString(workspace, "workspace") }),
      granularity: "turns",
      maxTurns: 1,
      maxItemsPerTurn: 1,
    });
    if (result.status === "ambiguous" || result.status === "not_found")
      throw new Error(
        `Remote Thread target is ${result.status}; choose one exact source Thread`,
      );
    return {
      threadId: fleetSourceString(result.threadId, "resolved Thread ID"),
      workspace: fleetSourceString(result.cwd, "resolved workspace"),
    };
  }

  async readRemoteThread(
    device: string,
    workspace: string | undefined,
    threadId: string,
    turnId?: string,
  ): ReturnType<NonNullable<ZenXTriggerAppServerPort["readRemoteThread"]>> {
    const peer = await this.#peer(device);
    const target = fleetSourceString(threadId, "source Thread ID");
    const args = {
      target,
      ...(workspace === undefined
        ? {}
        : { workspace: fleetSourceString(workspace, "source workspace") }),
    };
    const read = await this.#observeRead(peer, "zenx_threads_read", {
      ...args,
      granularity: turnId === undefined ? "turns" : "items",
      ...(turnId === undefined
        ? { maxTurns: 20 }
        : { turnId: fleetSourceString(turnId, "source Turn ID") }),
      maxItemsPerTurn: 25,
    });
    if (
      read.threadId !== target ||
      (workspace !== undefined && read.cwd !== workspace)
    )
      throw new Error(
        "Fleet source Thread or workspace identity changed; result was not read",
      );
    if (turnId !== undefined) {
      const status = await this.#observeRead(
        peer,
        "zenx_self_control_threads_wait",
        { ...args, turnId, timeoutSeconds: 1 },
      );
      if (
        status.threadId !== target ||
        status.turnId !== turnId ||
        (workspace !== undefined &&
          status.cwd !== undefined &&
          status.cwd !== workspace)
      )
        throw new Error(
          "Fleet source Turn identity changed; result was not read",
        );
      return {
        threadId: target,
        turns: [
          {
            id: turnId,
            status: fleetTurnStatus(status.status),
            preview: fleetTurnPreview(
              target,
              turnId,
              fleetTurnStatus(status.status),
              read.items,
              read.truncated === true,
            ),
          },
        ],
      };
    }
    if (!Array.isArray(read.turns) || read.turns.length > 20)
      throw new Error("Invalid Fleet source Turn preview");
    return {
      threadId: target,
      turns: read.turns.map((turn) => {
        if (!fleetRecord(turn))
          throw new Error("Invalid Fleet source Turn preview");
        const id = fleetSourceString(turn.turnId, "source Turn ID");
        const status = fleetTurnStatus(turn.status);
        return {
          id,
          status,
          preview: fleetTurnPreview(
            target,
            id,
            status,
            turn.items,
            turn.itemsTruncated === true,
          ),
        };
      }),
    };
  }

  async subscribeRemoteThread(
    device: string,
    workspace: string | undefined,
    threadId: string,
    options: RemoteSubscriptionOptions,
    signal: AbortSignal,
  ): Promise<() => void> {
    signal.throwIfAborted();
    const peer = await this.#peer(device);
    const controller = new AbortController();
    const bounded = AbortSignal.any([signal, controller.signal]);
    let stopped = false;
    const observation: FleetObservation = {
      peer,
      controller,
      options,
      stop: () => {
        if (stopped) return;
        stopped = true;
        this.#observations.delete(observation);
        signal.removeEventListener("abort", observation.stop);
        controller.abort();
        try {
          observation.dispose?.();
        } catch {
          console.warn("Could not close Fleet source observation");
        }
      },
    };
    this.#observations.add(observation);
    signal.addEventListener("abort", observation.stop, { once: true });
    const current = () =>
      this.#observations.has(observation) && !bounded.aborted;
    const callbacks: RemoteSubscriptionOptions = {
      includeCurrentTerminal: options.includeCurrentTerminal,
      onTurn: (turn) => {
        if (current()) options.onTurn(turn);
      },
      onError: (error) => {
        if (current()) options.onError(error);
      },
      onReady: () => {
        if (current()) options.onReady?.();
      },
    };
    try {
      await this.#assertPeer(peer);
      bounded.throwIfAborted();
      const target = fleetSourceString(threadId, "source Thread ID");
      const dispose =
        peer.transport === "https"
          ? await this.native.subscribeThread(
              peer,
              workspace,
              target,
              callbacks,
              bounded,
            )
          : subscribeSshFleetThread(
              peer,
              workspace,
              target,
              callbacks,
              bounded,
              this.options.sshWatchLaunch,
            );
      observation.dispose = dispose;
      if (!current()) {
        dispose();
        return observation.stop;
      }
      await this.#assertPeer(peer);
      bounded.throwIfAborted();
      return observation.stop;
    } catch (error) {
      observation.stop();
      throw error;
    }
  }

  #invalidateObservations(config: FleetConfig): void {
    for (const observation of this.#observations) {
      const peer = config.devices.find(
        (entry) => entry.id === observation.peer.id,
      );
      if (
        peer &&
        fleetObservationIdentity(peer) ===
          fleetObservationIdentity(observation.peer)
      )
        continue;
      this.#retireObservation(
        observation,
        "Fleet source device was removed or its identity, access or workspace changed; observation stopped. Review it before resuming the Trigger.",
      );
    }
  }
  #stopDeviceObservations(device: string, message: string): void {
    for (const observation of this.#observations)
      if (observation.peer.id === device)
        this.#retireObservation(observation, message);
  }
  #retireObservation(observation: FleetObservation, message: string): void {
    this.#observations.delete(observation);
    try {
      observation.options.onError(new Error(message));
    } catch {
      console.warn("Fleet source error listener failed");
    } finally {
      observation.stop();
    }
  }
}

function fleetObservationIdentity(peer: FleetDevice): string {
  return JSON.stringify(
    peer.transport === "https"
      ? [
          peer.id,
          peer.transport,
          peer.hostId,
          peer.endpoint,
          peer.access,
          peer.workspace ?? null,
        ]
      : [peer.id, "ssh", peer.sshHost, peer.command, peer.access],
  );
}
function fleetRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertFleetInvitationConsent(
  config: FleetConfig,
  hostId: string | undefined,
  expected: FleetInvitationConsent,
): void {
  if (
    expected.revision !== (config.revision ?? 0) ||
    expected.hostId !== hostId ||
    expected.access !== config.hosting?.access ||
    expected.shellEnabled !==
      (config.hosting?.access === "control" &&
        config.hosting.shellEnabled === true) ||
    expected.relayEndpoint !== (config.hosting?.relayEndpoint ?? null)
  )
    throw new Error(
      "Fleet Host or invitation scope changed; refresh settings and review sharing again",
    );
}
function fleetSourceString(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    /[\x00-\x1f\x7f]/u.test(value)
  )
    throw new Error(`Invalid Fleet ${field}`);
  return value;
}
function fleetTurnStatus(
  value: unknown,
): "inProgress" | "completed" | "failed" | "interrupted" {
  if (
    value !== "inProgress" &&
    value !== "completed" &&
    value !== "failed" &&
    value !== "interrupted"
  )
    throw new Error("Invalid Fleet source Turn status");
  return value;
}
function fleetTurnPreview(
  threadId: string,
  turnId: string,
  status: string,
  items: unknown,
  truncated: boolean,
): string {
  if (!Array.isArray(items) || items.length > 25)
    throw new Error("Invalid Fleet source Item preview");
  const text = items
    .map((item) => {
      if (!fleetRecord(item))
        throw new Error("Invalid Fleet source Item preview");
      return `${typeof item.type === "string" ? item.type : "Item"}: ${typeof item.text === "string" ? item.text : typeof item.preview === "string" ? item.preview : JSON.stringify(item.item ?? item)}`;
    })
    .join("\n");
  return [
    `Thread: ${threadId}`,
    `Turn: ${turnId}`,
    `Status: ${status}`,
    ...(truncated
      ? [
          "Bounded public Item preview; read the exact source Turn through Fleet for more.",
        ]
      : []),
    text,
  ]
    .join("\n")
    .slice(0, 6000);
}

export interface FleetMessageSourceRequest {
  threadId: string;
  itemId: string;
}
export interface FleetMessageSourceView {
  receipt: FleetMessageSourceRequest;
  locator: import("./fleet-product.js").FleetThreadLocator;
  history: Record<string, unknown>;
}
