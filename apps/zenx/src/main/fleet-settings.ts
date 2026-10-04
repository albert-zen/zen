import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  FleetRouter,
  parseFleetConfig,
  readFleetConfig,
  type FleetConfig,
  type FleetDevice,
  type FleetTransport,
  type NativeFleetDevice,
} from "./fleet.js";
import { NativeFleetClient } from "./fleet-native.js";
import {
  ZenXCredentialVault,
  type LocalEncryption,
} from "./credential-vault.js";
import type { AppServerManager } from "./app-server-manager.js";
import type { FleetHostConfig } from "./fleet-host.js";
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
  #error: string | undefined;
  readonly #observations = new Set<FleetObservation>();
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
    );
  }
  #relayKey(endpoint: string): string {
    return `relay:${createHash("sha256").update(endpoint).digest("hex")}`;
  }
  async #identity(): Promise<string> {
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
        JSON.stringify(config.hosting) === this.#restoredHosting
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
      this.#restoredHosting = JSON.stringify(config.hosting);
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
      config.revision = (current.revision ?? 0) + 1;
      await this.#write(config);
      this.#invalidateObservations(config);
      if (
        JSON.stringify(current.hosting) !== JSON.stringify(config.hosting) ||
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
  async test(id: string) {
    const peer = (await this.config()).devices.find((d) => d.id === id);
    if (!peer) throw new Error("Device not found");
    if (peer.transport === "https") return await this.native.test(peer);
    return await this.invoke({
      device: id,
      name: "zenx_threads_list",
      arguments: { limit: 1 },
    });
  }
  async invoke(input: {
    device: string;
    name: string;
    arguments: Record<string, unknown>;
  }) {
    if (
      !input ||
      typeof input.device !== "string" ||
      typeof input.name !== "string" ||
      !input.arguments ||
      typeof input.arguments !== "object" ||
      Array.isArray(input.arguments)
    )
      throw new Error("Invalid Fleet operation");
    return await this.router.invoke(input.device, {
      name: input.name,
      arguments: input.arguments,
      callId: randomUUID(),
      canonicalToolCallId: randomUUID(),
      cwd: this.options.directory,
      signal: AbortSignal.timeout(40000),
    });
  }
  async hostPair() {
    return await this.options.manager().fleetControl("pair");
  }
  async revoke(deviceId: string) {
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
