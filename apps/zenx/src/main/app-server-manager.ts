import { fork, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

import {
  ZenXProtocolClient,
  type ClientRequestMethod,
  type ClientRequestParams,
  type ClientRequestResults,
  type ServerNotificationMethod,
  type ServerNotificationParams,
  type ServerRequestParams,
  type ServerRequestResults,
} from "../protocol-client/index.js";
import {
  isHostEvent,
  type HostCommand,
  type ZenXHostConfig,
} from "./host-messages.js";
import type {
  ZenXCapabilityHost,
  ZenXCapabilityHostSnapshot,
  ZenXCapabilityGenerationSnapshot,
  ZenXPostCommitCapabilityRefresh,
} from "./capabilities/types.js";
import type {
  NativeThreadSummary,
  ThreadSummaryListOptions,
} from "../../../../src/thread-summary.js";
import type { ZenXThreadAttachmentProjection } from "./image-attachments.js";
import type { ModelUsageProjection } from "../../../../src/model-usage.js";
import type { CanonicalItem, UserInput } from "../../../../src/item.js";
import { AppServerConnectionPublisher } from "./app-server-connection.js";
import {
  observeOwnedChild,
  type OwnedChildObservation,
} from "./owned-child-process.js";

export type AppServerHostStatus =
  | { type: "starting" }
  | { type: "ready"; reconnected: boolean }
  | { type: "reconnecting"; attempt: number; delayMs: number }
  | { type: "error"; message: string }
  | { type: "stopped" };

export interface AppServerManagerOptions {
  entryPath: string;
  tokenFile: string;
  descriptorFile?: string;
  reclaimStaleConnectionDescriptor?: boolean;
  hostConfig: ZenXHostConfig;
  execPath?: string;
  execArgv?: string[];
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  recoveryDelaysMs?: readonly number[];
  capabilityHost?: ZenXCapabilityHost;
  capabilityReplacementTimeoutMs?: number;
  shutdownGraceMs?: number;
  terminationGraceMs?: number;
}

type NotificationListener = (
  method: ServerNotificationMethod,
  params: ServerNotificationParams[ServerNotificationMethod],
) => void;

export type ApprovalDecision =
  ServerRequestResults["item/commandExecution/requestApproval"]["decision"];

export interface ApprovalRequestEvent {
  requestId: string;
  params: ServerRequestParams["item/commandExecution/requestApproval"];
}

export interface ApprovalResolvedEvent {
  requestId: string;
  threadId: string;
  decision: ApprovalDecision | null;
}

interface PendingApproval {
  event: ApprovalRequestEvent;
  decision: ApprovalDecision | null;
  client: ZenXProtocolClient;
  connectionGeneration: number;
  wireRequestId: string;
  resolve(result: { decision: ApprovalDecision }): void;
}

interface UncertainCapabilityReplacement {
  requestId: string;
  previousGenerationToken: string | undefined;
  snapshot: ZenXCapabilityGenerationSnapshot;
}

export class AppServerManager {
  readonly #options: AppServerManagerOptions;
  readonly #statusListeners = new Set<(status: AppServerHostStatus) => void>();
  readonly #notificationListeners = new Set<NotificationListener>();
  readonly #approvalListeners = new Set<
    (event: ApprovalRequestEvent) => void
  >();
  readonly #approvalResolvedListeners = new Set<
    (event: ApprovalResolvedEvent) => void
  >();
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #activeCapabilityInvocations = new Map<
    string,
    {
      controller: AbortController;
      execution: Promise<void>;
      generationToken: string;
    }
  >();
  readonly #heldCapabilityGenerations = new Set<string>();
  readonly #pendingThreadSummaryRequests = new Map<
    string,
    {
      resolve(summaries: NativeThreadSummary[]): void;
      reject(error: Error): void;
    }
  >();
  readonly #pendingThreadAttachmentRequests = new Map<
    string,
    {
      resolve(attachments: ZenXThreadAttachmentProjection): void;
      reject(error: Error): void;
    }
  >();
  readonly #pendingThreadUsageRequests = new Map<
    string,
    {
      resolve(usage: ModelUsageProjection): void;
      reject(error: Error): void;
    }
  >();
  readonly #pendingCapabilityReplacements = new Map<
    string,
    {
      generationToken: string;
      resolve(): void;
      reject(error: Error): void;
    }
  >();
  readonly #pendingCapabilityCurrentRequests = new Map<
    string,
    { resolve(generationToken: string): void; reject(error: Error): void }
  >();
  readonly #pendingPluginTurns = new Map<
    string,
    {
      resolve(result: {
        threadId: string;
        turnId: string;
        items: readonly CanonicalItem[];
      }): void;
      reject(error: Error): void;
    }
  >();
  #status: AppServerHostStatus = { type: "stopped" };
  #child: ChildProcess | undefined;
  #childObservation: OwnedChildObservation | undefined;
  #client: ZenXProtocolClient | undefined;
  #acceptingCapabilityInvocations = false;
  #stopping = false;
  #recoverUnexpectedExits = false;
  #hasReachedReady = false;
  #stopPromise: Promise<void> | undefined;
  #recoveryPromise: Promise<void> | undefined;
  #lifecycle = 0;
  #nextThreadSummaryRequest = 1;
  #nextThreadAttachmentRequest = 1;
  #nextThreadUsageRequest = 1;
  #nextCapabilityReplacementRequest = 1;
  #nextCapabilityCurrentRequest = 1;
  #nextPluginTurnRequest = 1;
  #capabilityRestartTail: Promise<void> = Promise.resolve();
  #pluginRefreshTail: Promise<void> = Promise.resolve();
  #uncertainCapabilityReplacement: UncertainCapabilityReplacement | undefined;
  #connectionPublisher: AppServerConnectionPublisher | undefined;
  #bearerToken: string | undefined;
  #authorityUrl: string | undefined;
  #publishedCapabilitySnapshot: ZenXCapabilityGenerationSnapshot | undefined;

  constructor(options: AppServerManagerOptions) {
    this.#options = options;
  }

  get status(): AppServerHostStatus {
    return this.#status;
  }

  get processId(): number | undefined {
    return this.#child?.pid;
  }

  reportStartupError(error: unknown): void {
    if (this.#child !== undefined) {
      throw new Error("Cannot replace the status of a running App Server host");
    }
    this.#setStatus({ type: "error", message: asError(error).message });
  }

  async start(): Promise<void> {
    if (this.#child !== undefined || this.#recoveryPromise !== undefined) {
      throw new Error("ZenX App Server host is already running");
    }
    this.#stopping = false;
    this.#recoverUnexpectedExits = false;
    const lifecycle = ++this.#lifecycle;
    this.#setStatus({ type: "starting" });
    try {
      if (
        this.#options.descriptorFile !== undefined &&
        this.#connectionPublisher === undefined
      ) {
        const publisher = new AppServerConnectionPublisher(
          this.#options.descriptorFile,
        );
        await publisher.acquire({
          reclaimStale: this.#options.reclaimStaleConnectionDescriptor,
        });
        this.#connectionPublisher = publisher;
      }
      await this.#startHost(lifecycle);
      const reconnected = this.#hasReachedReady;
      this.#hasReachedReady = true;
      this.#setStatus({ type: "ready", reconnected });
    } catch (error) {
      const failure = asError(error);
      const failures = [failure];
      if (
        this.#options.descriptorFile === undefined ||
        this.#connectionPublisher !== undefined
      ) {
        this.#bearerToken = undefined;
        this.#authorityUrl = undefined;
      }
      const cleanup = await Promise.allSettled([
        this.#options.descriptorFile === undefined ||
        this.#connectionPublisher !== undefined
          ? removeTokenFile(this.#options.tokenFile)
          : Promise.resolve(),
        this.#releaseConnectionPublisher(),
      ]);
      for (const result of cleanup) {
        if (result.status === "rejected") failures.push(asError(result.reason));
      }
      if (lifecycle === this.#lifecycle && !this.#stopping) {
        this.#setStatus({ type: "error", message: failure.message });
      }
      if (failures.length === 1) throw failure;
      throw new AggregateError(failures, "Zen App Server startup failed");
    }
  }

  async #startHost(lifecycle: number): Promise<void> {
    this.#acceptingCapabilityInvocations = false;
    const bearerToken =
      this.#bearerToken ??
      (await createPrivateTokenFile(this.#options.tokenFile));
    this.#bearerToken = bearerToken;
    if (lifecycle !== this.#lifecycle || this.#stopping) {
      await removeTokenFile(this.#options.tokenFile);
      throw new Error("Zen App Server startup was cancelled");
    }
    const child = fork(this.#options.entryPath, [], {
      cwd: process.cwd(),
      env: {
        ...(this.#options.environment ?? process.env),
        ...(this.#options.execPath === undefined
          ? {}
          : { ELECTRON_RUN_AS_NODE: "1" }),
      },
      execPath: this.#options.execPath,
      execArgv: this.#options.execArgv,
      silent: true,
    });
    this.#child = child;
    const childObservation = observeOwnedChild(child);
    this.#childObservation = childObservation;
    child.stderr?.on("data", (chunk: Buffer | string) => {
      console.error(`[ZenX App Server] ${chunk.toString().trimEnd()}`);
    });
    child.once("exit", (code, signal) => {
      this.#handleChildExit(child, code, signal);
    });

    let capabilities: ZenXCapabilityGenerationSnapshot | undefined;
    try {
      capabilities = this.#captureCapabilitySnapshot();
      const url = await waitForReady(
        child,
        this.#options.startupTimeoutMs ?? 10_000,
        {
          type: "start",
          config: this.#options.hostConfig,
          bearerToken,
          listen: this.#authorityUrl ?? "ws://127.0.0.1:0",
          capabilities,
        },
      );
      if (this.#authorityUrl !== undefined && url !== this.#authorityUrl) {
        throw new Error("Zen App Server changed its published authority");
      }
      this.#authorityUrl = url;
      this.#installCapabilityBridge(child);
      const client = await ZenXProtocolClient.connect({
        url,
        clientInfo: { name: "zenx", title: "ZenX", version: "0.1.0" },
        bearerTokenFile: this.#options.tokenFile,
      });
      if (lifecycle !== this.#lifecycle || this.#stopping) {
        client.close();
        throw new Error("Zen App Server startup was cancelled");
      }
      this.#client = client;
      this.#publishedCapabilitySnapshot = structuredClone(capabilities);
      this.#forwardNotifications(client);
      await this.#connectionPublisher?.publish({
        version: 1,
        transport: "websocket",
        url,
        authentication: {
          type: "bearer-file",
          tokenFile: path.resolve(this.#options.tokenFile),
        },
      });
      this.#acceptingCapabilityInvocations = true;
      this.#recoverUnexpectedExits = true;
    } catch (error) {
      this.#acceptingCapabilityInvocations = false;
      const failures = [asError(error)];
      const client = this.#client;
      this.#client = undefined;
      this.#publishedCapabilitySnapshot = undefined;
      const cleanup = await Promise.allSettled([
        Promise.resolve().then(() => client?.close()),
        stopOwnedAppServerChild(child, childObservation, {
          shutdownGraceMs: this.#options.shutdownGraceMs ?? 3_000,
          terminationGraceMs: this.#options.terminationGraceMs ?? 3_000,
        }),
      ]);
      for (const result of cleanup) {
        if (result.status === "rejected") failures.push(asError(result.reason));
      }
      if (this.#child === child) this.#child = undefined;
      if (this.#childObservation === childObservation) {
        this.#childObservation = undefined;
      }
      if (capabilities !== undefined) {
        try {
          this.#releaseCapabilityGeneration(capabilities.generationToken);
        } catch (releaseError) {
          failures.push(asError(releaseError));
        }
      }
      if (failures.length === 1) throw failures[0]!;
      throw new AggregateError(failures, "Zen App Server startup failed");
    }
  }

  async restart(hostConfig: ZenXHostConfig): Promise<void> {
    if (this.#status.type !== "stopped" || this.#child !== undefined) {
      await this.stop({ preserveConnectionAuthority: true });
    }
    this.#options.hostConfig = hostConfig;
    await this.start();
  }

  async restartCapabilities(): Promise<void> {
    const restart = this.#capabilityRestartTail.then(
      async () => await this.restart(this.#options.hostConfig),
    );
    this.#capabilityRestartTail = restart.then(
      () => undefined,
      () => undefined,
    );
    await restart;
  }

  async refreshCapabilitiesAfterCommit(): Promise<ZenXPostCommitCapabilityRefresh> {
    const result = await this.#enqueueCapabilityRefresh();
    return result.status === "reloaded" ? { status: "refreshed" } : result;
  }

  async refreshPluginAfterCommit(
    targetPluginId: string,
  ): Promise<{ status: "reloaded" } | { status: "failed"; message: string }> {
    return await this.#enqueueCapabilityRefresh(targetPluginId);
  }

  async #enqueueCapabilityRefresh(
    targetPluginId?: string,
  ): Promise<{ status: "reloaded" } | { status: "failed"; message: string }> {
    const refresh = this.#pluginRefreshTail.then(
      async () => await this.#refreshPluginAfterCommit(targetPluginId),
    );
    this.#pluginRefreshTail = refresh.then(
      () => undefined,
      () => undefined,
    );
    return await refresh;
  }

  async #refreshPluginAfterCommit(
    targetPluginId?: string,
  ): Promise<{ status: "reloaded" } | { status: "failed"; message: string }> {
    let capturedGenerationToken: string | undefined;
    let replacementSent = false;
    try {
      if (
        targetPluginId !== undefined &&
        !/^[a-z][a-z0-9-]{1,62}$/u.test(targetPluginId)
      ) {
        throw new Error(`Invalid target plugin id: ${targetPluginId}`);
      }
      const child = this.#child;
      const capabilityHost = this.#options.capabilityHost;
      if (
        this.#status.type !== "ready" ||
        child === undefined ||
        !child.connected ||
        capabilityHost === undefined
      ) {
        throw new Error("Zen App Server is not ready for plugin reload");
      }
      if (this.#uncertainCapabilityReplacement !== undefined) {
        const reconciliation = await this.#reconcileCapabilityReplacement();
        if (reconciliation.status === "pending") {
          return { status: "failed", message: reconciliation.message };
        }
      }
      const requestId = `capability-replace-${String(this.#nextCapabilityReplacementRequest++)}`;
      const capabilities = this.#captureCapabilitySnapshot();
      capturedGenerationToken = capabilities.generationToken;
      if (
        targetPluginId !== undefined &&
        this.#publishedCapabilitySnapshot !== undefined
      ) {
        assertTargetOnlyCapabilityChange(
          this.#publishedCapabilitySnapshot,
          capabilities,
          targetPluginId,
        );
      }
      const timeoutMs = this.#capabilityReplacementTimeout();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!this.#pendingCapabilityReplacements.delete(requestId)) return;
          reject(
            new Error(
              `${targetPluginId === undefined ? "Capability" : `Plugin ${targetPluginId} capability`} replacement timed out after ${String(timeoutMs)}ms`,
            ),
          );
        }, timeoutMs);
        const pending = {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (error: Error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        this.#uncertainCapabilityReplacement = {
          requestId,
          previousGenerationToken:
            this.#publishedCapabilitySnapshot?.generationToken,
          snapshot: structuredClone(capabilities),
        };
        this.#pendingCapabilityReplacements.set(requestId, {
          ...pending,
          generationToken: capabilities.generationToken,
        });
        replacementSent = true;
        child.send(
          {
            type: "capabilities/replace",
            requestId,
            ...(targetPluginId === undefined ? {} : { targetPluginId }),
            capabilities,
          } satisfies HostCommand,
          (error) => {
            if (error === null) return;
            if (!this.#pendingCapabilityReplacements.delete(requestId)) return;
            pending.reject(error);
          },
        );
      });
      return { status: "reloaded" };
    } catch (error) {
      const failure = asError(error);
      if (
        replacementSent &&
        this.#uncertainCapabilityReplacement?.snapshot.generationToken ===
          capturedGenerationToken
      ) {
        const reconciliation = await this.#reconcileCapabilityReplacement();
        if (reconciliation.status === "confirmed-new") {
          return { status: "reloaded" };
        }
        if (reconciliation.status === "pending") {
          return {
            status: "failed",
            message: `${failure.message}; ${reconciliation.message}`,
          };
        }
      } else if (capturedGenerationToken !== undefined) {
        try {
          this.#releaseCapabilityGeneration(capturedGenerationToken);
        } catch (releaseError) {
          return {
            status: "failed",
            message: `${failure.message}; capability generation cleanup failed: ${asError(releaseError).message}`,
          };
        }
      }
      return { status: "failed", message: failure.message };
    }
  }

  async request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequestParams[M],
  ): Promise<ClientRequestResults[M]> {
    if (this.#status.type !== "ready" || this.#client === undefined) {
      const detail =
        this.#status.type === "error" ? `: ${this.#status.message}` : "";
      throw new Error(`Zen App Server is not ready${detail}`);
    }
    return await this.#client.request(method, params);
  }

  async listThreadSummaries(
    options: ThreadSummaryListOptions = {},
  ): Promise<NativeThreadSummary[]> {
    if (
      this.#status.type !== "ready" ||
      this.#child === undefined ||
      !this.#child.connected
    ) {
      const detail =
        this.#status.type === "error" ? `: ${this.#status.message}` : "";
      throw new Error(`Zen App Server is not ready${detail}`);
    }
    const requestId = `thread-summary-${String(this.#nextThreadSummaryRequest++)}`;
    return await new Promise<NativeThreadSummary[]>((resolve, reject) => {
      this.#pendingThreadSummaryRequests.set(requestId, { resolve, reject });
      this.#child!.send(
        {
          type: "thread-summary/list",
          requestId,
          options,
        } satisfies HostCommand,
        (error) => {
          if (error === null) return;
          this.#pendingThreadSummaryRequests.delete(requestId);
          reject(error);
        },
      );
    });
  }

  async readThreadAttachments(
    threadId: string,
  ): Promise<ZenXThreadAttachmentProjection> {
    if (
      this.#status.type !== "ready" ||
      this.#child === undefined ||
      !this.#child.connected
    ) {
      const detail =
        this.#status.type === "error" ? `: ${this.#status.message}` : "";
      throw new Error(`Zen App Server is not ready${detail}`);
    }
    const requestId = `thread-attachments-${String(this.#nextThreadAttachmentRequest++)}`;
    return await new Promise<ZenXThreadAttachmentProjection>(
      (resolve, reject) => {
        this.#pendingThreadAttachmentRequests.set(requestId, {
          resolve,
          reject,
        });
        this.#child!.send(
          {
            type: "thread-attachments/read",
            requestId,
            threadId,
          } satisfies HostCommand,
          (error) => {
            if (error === null) return;
            this.#pendingThreadAttachmentRequests.delete(requestId);
            reject(error);
          },
        );
      },
    );
  }

  async readThreadUsage(threadId: string): Promise<ModelUsageProjection> {
    if (
      this.#status.type !== "ready" ||
      this.#child === undefined ||
      !this.#child.connected
    ) {
      const detail =
        this.#status.type === "error" ? `: ${this.#status.message}` : "";
      throw new Error(`Zen App Server is not ready${detail}`);
    }
    const requestId = `thread-usage-${String(this.#nextThreadUsageRequest++)}`;
    return await new Promise<ModelUsageProjection>((resolve, reject) => {
      this.#pendingThreadUsageRequests.set(requestId, { resolve, reject });
      this.#child!.send(
        {
          type: "thread-usage/read",
          requestId,
          threadId,
        } satisfies HostCommand,
        (error) => {
          if (error === null) return;
          this.#pendingThreadUsageRequests.delete(requestId);
          reject(error);
        },
      );
    });
  }

  async completePluginTurn(
    threadId: string,
    input: string | UserInput,
  ): Promise<{
    threadId: string;
    turnId: string;
    items: readonly CanonicalItem[];
  }> {
    if (
      this.#status.type !== "ready" ||
      this.#child === undefined ||
      !this.#child.connected
    ) {
      const detail =
        this.#status.type === "error" ? `: ${this.#status.message}` : "";
      throw new Error(`Zen App Server is not ready${detail}`);
    }
    const requestId = `plugin-turn-${String(this.#nextPluginTurnRequest++)}`;
    return await new Promise((resolve, reject) => {
      this.#pendingPluginTurns.set(requestId, { resolve, reject });
      this.#child!.send(
        {
          type: "plugin-turn/start",
          requestId,
          threadId,
          input,
        } satisfies HostCommand,
        (error) => {
          if (error === null) return;
          this.#pendingPluginTurns.delete(requestId);
          reject(error);
        },
      );
    });
  }

  onStatus(listener: (status: AppServerHostStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onNotification(listener: NotificationListener): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  onApprovalRequest(
    listener: (event: ApprovalRequestEvent) => void,
  ): () => void {
    this.#approvalListeners.add(listener);
    return () => this.#approvalListeners.delete(listener);
  }

  get pendingApprovalRequests(): readonly ApprovalRequestEvent[] {
    return [...this.#pendingApprovals.values()].map((pending) => pending.event);
  }

  onApprovalResolved(
    listener: (event: ApprovalResolvedEvent) => void,
  ): () => void {
    this.#approvalResolvedListeners.add(listener);
    return () => this.#approvalResolvedListeners.delete(listener);
  }

  respondToApproval(requestId: string, decision: ApprovalDecision): void {
    const pending = this.#pendingApprovals.get(requestId);
    if (pending === undefined) {
      throw new Error(`Approval request ${requestId} is no longer pending`);
    }
    if (pending.decision !== null) {
      throw new Error(`Approval request ${requestId} already has a response`);
    }
    pending.decision = decision;
    pending.resolve({ decision });
  }

  async stop(
    options: { preserveConnectionAuthority?: boolean } = {},
  ): Promise<void> {
    if (this.#stopPromise !== undefined) {
      await this.#stopPromise;
      if (
        options.preserveConnectionAuthority !== true &&
        this.#connectionPublisher !== undefined
      ) {
        await this.stop();
      }
      return;
    }
    this.#stopping = true;
    this.#recoverUnexpectedExits = false;
    ++this.#lifecycle;
    this.#acceptingCapabilityInvocations = false;
    const stopping = this.#performStop(
      options.preserveConnectionAuthority === true,
    );
    this.#stopPromise = stopping;
    try {
      await stopping;
    } finally {
      if (this.#stopPromise === stopping) this.#stopPromise = undefined;
    }
  }

  async #performStop(preserveConnectionAuthority: boolean): Promise<void> {
    const failures: Error[] = [];
    if (!preserveConnectionAuthority) {
      try {
        await this.#connectionPublisher?.revoke();
      } catch (error) {
        failures.push(asError(error));
      }
    }
    this.#cancelPendingApprovals();
    this.#rejectPendingThreadSummaryRequests(
      new Error("Zen App Server host stopped"),
    );
    this.#rejectPendingThreadAttachmentRequests(
      new Error("Zen App Server host stopped"),
    );
    this.#rejectPendingThreadUsageRequests(
      new Error("Zen App Server host stopped"),
    );
    this.#rejectPendingCapabilityReplacements(
      new Error("Zen App Server host stopped"),
    );
    this.#rejectPendingCapabilityCurrentRequests(
      new Error("Zen App Server host stopped"),
    );
    this.#uncertainCapabilityReplacement = undefined;
    this.#rejectPendingPluginTurns(new Error("Zen App Server host stopped"));
    await this.#cancelAndSettleCapabilityInvocations();
    try {
      this.#client?.close();
    } catch (error) {
      failures.push(asError(error));
    }
    this.#client = undefined;
    this.#publishedCapabilitySnapshot = undefined;
    const child = this.#child;
    const observation = this.#childObservation;
    if (child !== undefined && observation !== undefined) {
      try {
        await stopOwnedAppServerChild(child, observation, {
          shutdownGraceMs: this.#options.shutdownGraceMs ?? 3_000,
          terminationGraceMs: this.#options.terminationGraceMs ?? 3_000,
        });
      } catch (error) {
        failures.push(asError(error));
      }
    }
    this.#child = undefined;
    this.#childObservation = undefined;
    failures.push(...this.#releaseAllCapabilityGenerations());
    try {
      await this.#recoveryPromise;
    } catch (error) {
      failures.push(asError(error));
    }
    if (!preserveConnectionAuthority) {
      this.#bearerToken = undefined;
      this.#authorityUrl = undefined;
      const cleanup = await Promise.allSettled([
        removeTokenFile(this.#options.tokenFile),
        this.#releaseConnectionPublisher(),
      ]);
      for (const result of cleanup) {
        if (result.status === "rejected") failures.push(asError(result.reason));
      }
    }
    this.#setStatus({ type: "stopped" });
    if (failures.length > 0) {
      throw new AggregateError(failures, "Zen App Server shutdown failed");
    }
  }

  async #releaseConnectionPublisher(): Promise<void> {
    const publisher = this.#connectionPublisher;
    this.#connectionPublisher = undefined;
    await publisher?.release();
  }

  #forwardNotifications(client: ZenXProtocolClient): void {
    client.onStatus((status) => {
      if (client !== this.#client || this.#stopping) return;
      if (status.type === "reconnecting") {
        this.#cancelPendingApprovals((pending) => pending.client === client);
        this.#setStatus({
          type: "reconnecting",
          attempt: status.attempt,
          delayMs: status.delayMs,
        });
      } else if (status.type === "ready" && status.reconnected) {
        this.#setStatus({ type: "ready", reconnected: true });
      } else if (status.type === "protocolError") {
        this.#setStatus({ type: "error", message: status.error.message });
      }
    });
    client.onServerRequest(
      "item/commandExecution/requestApproval",
      async (params, context) => {
        const wireRequestId = String(context.requestId);
        if (
          [...this.#pendingApprovals.values()].some(
            (pending) =>
              pending.client === client &&
              pending.connectionGeneration === context.connectionGeneration &&
              pending.wireRequestId === wireRequestId,
          )
        ) {
          throw new Error(`Duplicate approval request ${wireRequestId}`);
        }
        return await new Promise<{ decision: ApprovalDecision }>((resolve) => {
          const requestId = randomUUID();
          const event = { requestId, params };
          this.#pendingApprovals.set(requestId, {
            event,
            decision: null,
            client,
            connectionGeneration: context.connectionGeneration,
            wireRequestId,
            resolve,
          });
          for (const listener of this.#approvalListeners) listener(event);
        });
      },
    );
    for (const method of [
      "thread/started",
      "thread/name/updated",
      "thread/archived",
      "thread/unarchived",
      "thread/settings/updated",
      "turn/started",
      "item/started",
      "item/agentMessage/delta",
      "item/reasoning/summaryPartAdded",
      "item/reasoning/summaryTextDelta",
      "item/reasoning/textDelta",
      "item/commandExecution/outputDelta",
      "item/completed",
      "serverRequest/resolved",
      "turn/completed",
      "error",
    ] as const) {
      client.onNotification(method, (params) => {
        if (method === "serverRequest/resolved") {
          this.#resolveApproval(
            client,
            client.connectionGeneration,
            params as ServerNotificationParams["serverRequest/resolved"],
          );
        }
        for (const listener of this.#notificationListeners) {
          listener(method, params);
        }
      });
    }
  }

  #resolveApproval(
    client: ZenXProtocolClient,
    connectionGeneration: number,
    params: ServerNotificationParams["serverRequest/resolved"],
  ): void {
    const pending = [...this.#pendingApprovals.values()].find(
      (candidate) =>
        candidate.client === client &&
        candidate.connectionGeneration === connectionGeneration &&
        candidate.wireRequestId === params.requestId,
    );
    if (pending === undefined) return;
    if (pending.decision === null) {
      pending.decision = "cancel";
      pending.resolve({ decision: "cancel" });
    }
    const event = {
      requestId: pending.event.requestId,
      threadId: params.threadId,
      decision: pending.decision,
    } satisfies ApprovalResolvedEvent;
    this.#pendingApprovals.delete(pending.event.requestId);
    for (const listener of this.#approvalResolvedListeners) listener(event);
  }

  #handleChildExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.#child !== child) return;
    this.#child = undefined;
    this.#childObservation = undefined;
    this.#acceptingCapabilityInvocations = false;
    this.#cancelPendingApprovals();
    this.#abortCapabilityInvocations();
    this.#rejectPendingThreadSummaryRequests(
      new Error("Zen App Server stopped before returning Thread summaries"),
    );
    this.#rejectPendingThreadAttachmentRequests(
      new Error("Zen App Server stopped before returning Thread attachments"),
    );
    this.#rejectPendingThreadUsageRequests(
      new Error("Zen App Server stopped before returning Thread usage"),
    );
    this.#rejectPendingCapabilityReplacements(
      new Error("Zen App Server stopped before replacing capabilities"),
    );
    this.#rejectPendingCapabilityCurrentRequests(
      new Error("Zen App Server stopped before confirming capabilities"),
    );
    this.#uncertainCapabilityReplacement = undefined;
    this.#rejectPendingPluginTurns(
      new Error("Zen App Server stopped before completing plugin Turn"),
    );
    this.#client?.close();
    this.#client = undefined;
    for (const failure of this.#releaseAllCapabilityGenerations()) {
      console.error(
        `[ZenX App Server] Failed to release a capability generation: ${failure.message}`,
      );
    }
    if (!this.#stopping && this.#recoverUnexpectedExits) {
      const reason =
        signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
      this.#beginRecovery(reason);
    }
  }

  #beginRecovery(reason: string): void {
    if (this.#recoveryPromise !== undefined || this.#stopping) return;
    const lifecycle = this.#lifecycle;
    const delays = this.#options.recoveryDelaysMs ?? [100, 500, 1_000];
    const recovery = (async () => {
      let lastError = new Error(
        `Zen App Server stopped unexpectedly (${reason})`,
      );
      for (const [index, delayMs] of delays.entries()) {
        const attempt = index + 1;
        this.#setStatus({ type: "reconnecting", attempt, delayMs });
        await delay(delayMs);
        if (lifecycle !== this.#lifecycle || this.#stopping) return;
        try {
          await this.#startHost(lifecycle);
          this.#recoveryPromise = undefined;
          this.#setStatus({ type: "ready", reconnected: true });
          return;
        } catch (error) {
          lastError = asError(error);
        }
      }
      if (lifecycle === this.#lifecycle && !this.#stopping) {
        this.#recoverUnexpectedExits = false;
        await this.#connectionPublisher?.revoke();
        await removeTokenFile(this.#options.tokenFile);
        this.#bearerToken = undefined;
        this.#authorityUrl = undefined;
        this.#setStatus({
          type: "error",
          message: `Zen App Server recovery failed after ${String(delays.length)} attempts: ${lastError.message}`,
        });
      }
    })();
    this.#recoveryPromise = recovery;
    void recovery.finally(() => {
      if (this.#recoveryPromise === recovery) {
        this.#recoveryPromise = undefined;
      }
    });
  }

  #setStatus(status: AppServerHostStatus): void {
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }

  #cancelPendingApprovals(
    matches: (pending: PendingApproval) => boolean = () => true,
  ): void {
    for (const [requestId, pending] of this.#pendingApprovals) {
      if (!matches(pending)) continue;
      const decision = pending.decision ?? "cancel";
      if (pending.decision === null) pending.resolve({ decision: "cancel" });
      this.#pendingApprovals.delete(requestId);
      const event = {
        requestId,
        threadId: pending.event.params.threadId,
        decision,
      } satisfies ApprovalResolvedEvent;
      for (const listener of this.#approvalResolvedListeners) listener(event);
    }
  }

  #installCapabilityBridge(child: ChildProcess): void {
    child.on("message", (message: unknown) => {
      if (this.#child !== child) return;
      const hostEvent = isHostEvent(message) ? message : undefined;
      if (hostEvent?.type === "thread-summary/result") {
        const pending = this.#pendingThreadSummaryRequests.get(
          hostEvent.requestId,
        );
        if (pending !== undefined) {
          this.#pendingThreadSummaryRequests.delete(hostEvent.requestId);
          if (hostEvent.error !== undefined)
            pending.reject(new Error(hostEvent.error));
          else pending.resolve(hostEvent.summaries);
        }
        return;
      }
      if (hostEvent?.type === "thread-attachments/result") {
        const pending = this.#pendingThreadAttachmentRequests.get(
          hostEvent.requestId,
        );
        if (pending !== undefined) {
          this.#pendingThreadAttachmentRequests.delete(hostEvent.requestId);
          if (hostEvent.error !== undefined)
            pending.reject(new Error(hostEvent.error));
          else pending.resolve(hostEvent.attachments);
        }
        return;
      }
      if (hostEvent?.type === "thread-usage/result") {
        const pending = this.#pendingThreadUsageRequests.get(
          hostEvent.requestId,
        );
        if (pending !== undefined) {
          this.#pendingThreadUsageRequests.delete(hostEvent.requestId);
          if (hostEvent.error !== undefined)
            pending.reject(new Error(hostEvent.error));
          else pending.resolve(hostEvent.usage);
        }
        return;
      }
      if (hostEvent?.type === "capabilities/replaced") {
        const pending = this.#pendingCapabilityReplacements.get(
          hostEvent.requestId,
        );
        if (pending !== undefined) {
          this.#pendingCapabilityReplacements.delete(hostEvent.requestId);
          if (pending.generationToken !== hostEvent.generationToken) {
            pending.reject(
              new Error("Capability replacement ACK token mismatch"),
            );
            return;
          }
        }
        if (hostEvent.error === undefined) {
          this.#confirmCapabilityReplacement(
            hostEvent.requestId,
            hostEvent.generationToken,
          );
          pending?.resolve();
        } else {
          const uncertain = this.#uncertainCapabilityReplacement;
          if (
            uncertain?.requestId === hostEvent.requestId &&
            uncertain.snapshot.generationToken === hostEvent.generationToken
          ) {
            this.#uncertainCapabilityReplacement = undefined;
            this.#releaseCapabilityGeneration(hostEvent.generationToken);
          }
          pending?.reject(new Error(hostEvent.error));
        }
        return;
      }
      if (hostEvent?.type === "capabilities/current") {
        const pending = this.#pendingCapabilityCurrentRequests.get(
          hostEvent.requestId,
        );
        if (pending !== undefined) {
          this.#pendingCapabilityCurrentRequests.delete(hostEvent.requestId);
          if (hostEvent.error !== undefined) {
            pending.reject(new Error(hostEvent.error));
          } else {
            pending.resolve(hostEvent.generationToken);
          }
        }
        return;
      }
      if (hostEvent?.type === "plugin-turn/result") {
        const pending = this.#pendingPluginTurns.get(hostEvent.requestId);
        if (pending !== undefined) {
          this.#pendingPluginTurns.delete(hostEvent.requestId);
          if (hostEvent.error !== undefined) {
            pending.reject(new Error(hostEvent.error));
          } else {
            pending.resolve({
              threadId: hostEvent.threadId,
              turnId: hostEvent.turnId,
              items: structuredClone(hostEvent.items),
            });
          }
        }
        return;
      }
      if (hostEvent?.type === "capabilities/released") {
        this.#releaseCapabilityGeneration(hostEvent.generationToken);
        return;
      }
      if (hostEvent === undefined) {
        const threadSummaryRequestId = readHostMessageRequestId(message);
        if (threadSummaryRequestId !== undefined) {
          const pending = this.#pendingThreadSummaryRequests.get(
            threadSummaryRequestId,
          );
          if (pending !== undefined) {
            this.#pendingThreadSummaryRequests.delete(threadSummaryRequestId);
            pending.reject(
              new Error("Malformed native Thread summary response"),
            );
          }
          const attachmentPending = this.#pendingThreadAttachmentRequests.get(
            threadSummaryRequestId,
          );
          if (attachmentPending !== undefined) {
            this.#pendingThreadAttachmentRequests.delete(
              threadSummaryRequestId,
            );
            attachmentPending.reject(
              new Error("Malformed native Thread attachment response"),
            );
          }
          const usagePending = this.#pendingThreadUsageRequests.get(
            threadSummaryRequestId,
          );
          if (usagePending !== undefined) {
            this.#pendingThreadUsageRequests.delete(threadSummaryRequestId);
            usagePending.reject(
              new Error("Malformed native Thread usage response"),
            );
          }
          const replacementPending = this.#pendingCapabilityReplacements.get(
            threadSummaryRequestId,
          );
          if (replacementPending !== undefined) {
            this.#pendingCapabilityReplacements.delete(threadSummaryRequestId);
            replacementPending.reject(
              new Error("Malformed capability replacement response"),
            );
          }
        }
        return;
      }
      if (hostEvent.type === "capability/cancel") {
        const active = this.#activeCapabilityInvocations.get(
          hostEvent.invocationId,
        );
        if (active?.generationToken === hostEvent.generationToken) {
          active.controller.abort(
            new DOMException("Capability invocation cancelled", "AbortError"),
          );
        }
        return;
      }
      if (hostEvent.type !== "capability/invoke") return;
      if (!this.#acceptingCapabilityInvocations) {
        child.send({
          type: "capability/result",
          invocationId: hostEvent.invocationId,
          generationToken: hostEvent.generationToken,
          error: "ZenX capability host is stopping",
        } satisfies HostCommand);
        return;
      }
      const host = this.#options.capabilityHost;
      if (host === undefined) {
        child.send({
          type: "capability/result",
          invocationId: hostEvent.invocationId,
          generationToken: hostEvent.generationToken,
          error: "ZenX capability host is unavailable",
        } satisfies HostCommand);
        return;
      }
      if (this.#activeCapabilityInvocations.has(hostEvent.invocationId)) {
        child.send({
          type: "capability/result",
          invocationId: hostEvent.invocationId,
          generationToken: hostEvent.generationToken,
          error: `Duplicate capability invocation ${hostEvent.invocationId}`,
        } satisfies HostCommand);
        return;
      }
      const controller = new AbortController();
      const execution = Promise.resolve()
        .then(
          async () =>
            await host.execute(
              {
                ...hostEvent.invocation,
                signal: controller.signal,
              },
              hostEvent.generationToken,
            ),
        )
        .then((result) => {
          if (this.#child === child && child.connected) {
            child.send({
              type: "capability/result",
              invocationId: hostEvent.invocationId,
              generationToken: hostEvent.generationToken,
              output: result.output,
              exitCode: result.exitCode,
              ...(result.contentType === undefined
                ? {}
                : {
                    contentType: result.contentType,
                    structuredContent: result.structuredContent,
                  }),
              ...(result.sourceTruncated === undefined
                ? {}
                : { sourceTruncated: result.sourceTruncated }),
            } satisfies HostCommand);
          }
        })
        .catch((error: unknown) => {
          if (this.#child === child && child.connected) {
            child.send({
              type: "capability/result",
              invocationId: hostEvent.invocationId,
              generationToken: hostEvent.generationToken,
              error: asError(error).message,
            } satisfies HostCommand);
          }
        })
        .finally(() => {
          if (
            this.#activeCapabilityInvocations.get(hostEvent.invocationId)
              ?.execution === execution
          ) {
            this.#activeCapabilityInvocations.delete(hostEvent.invocationId);
          }
        });
      this.#activeCapabilityInvocations.set(hostEvent.invocationId, {
        controller,
        execution,
        generationToken: hostEvent.generationToken,
      });
    });
  }

  #abortCapabilityInvocations(): Promise<void>[] {
    const executions: Promise<void>[] = [];
    for (const active of this.#activeCapabilityInvocations.values()) {
      active.controller.abort(
        new DOMException("ZenX App Server host stopped", "AbortError"),
      );
      executions.push(active.execution);
    }
    return executions;
  }

  async #cancelAndSettleCapabilityInvocations(): Promise<void> {
    await Promise.allSettled(this.#abortCapabilityInvocations());
  }

  #rejectPendingThreadSummaryRequests(error: Error): void {
    for (const pending of this.#pendingThreadSummaryRequests.values()) {
      pending.reject(error);
    }
    this.#pendingThreadSummaryRequests.clear();
  }

  #rejectPendingThreadAttachmentRequests(error: Error): void {
    for (const pending of this.#pendingThreadAttachmentRequests.values()) {
      pending.reject(error);
    }
    this.#pendingThreadAttachmentRequests.clear();
  }

  #rejectPendingThreadUsageRequests(error: Error): void {
    for (const pending of this.#pendingThreadUsageRequests.values()) {
      pending.reject(error);
    }
    this.#pendingThreadUsageRequests.clear();
  }

  #rejectPendingCapabilityReplacements(error: Error): void {
    for (const pending of this.#pendingCapabilityReplacements.values()) {
      pending.reject(error);
    }
    this.#pendingCapabilityReplacements.clear();
  }

  #rejectPendingPluginTurns(error: Error): void {
    for (const pending of this.#pendingPluginTurns.values()) {
      pending.reject(error);
    }
    this.#pendingPluginTurns.clear();
  }

  #capabilityReplacementTimeout(): number {
    const timeoutMs = this.#options.capabilityReplacementTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error(
        "Capability replacement timeout must be a positive integer",
      );
    }
    return timeoutMs;
  }

  async #reconcileCapabilityReplacement(): Promise<
    | { status: "confirmed-new" | "confirmed-previous" }
    | { status: "pending"; message: string }
  > {
    const uncertain = this.#uncertainCapabilityReplacement;
    if (uncertain === undefined) return { status: "confirmed-new" };
    let currentGenerationToken: string;
    try {
      currentGenerationToken = await this.#readCurrentCapabilityGeneration();
    } catch (error) {
      return {
        status: "pending",
        message: `capability generation confirmation remains pending: ${asError(error).message}`,
      };
    }
    if (currentGenerationToken === uncertain.snapshot.generationToken) {
      this.#confirmCapabilityReplacement(
        uncertain.requestId,
        currentGenerationToken,
      );
      return { status: "confirmed-new" };
    }
    if (currentGenerationToken === uncertain.previousGenerationToken) {
      this.#uncertainCapabilityReplacement = undefined;
      this.#releaseCapabilityGeneration(uncertain.snapshot.generationToken);
      return { status: "confirmed-previous" };
    }
    return {
      status: "pending",
      message: `capability generation confirmation returned unexpected token ${currentGenerationToken}`,
    };
  }

  async #readCurrentCapabilityGeneration(): Promise<string> {
    const child = this.#child;
    if (child === undefined || !child.connected) {
      throw new Error(
        "Zen App Server is not ready for capability confirmation",
      );
    }
    const requestId = `capability-current-${String(this.#nextCapabilityCurrentRequest++)}`;
    const timeoutMs = this.#capabilityReplacementTimeout();
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pendingCapabilityCurrentRequests.delete(requestId)) return;
        reject(
          new Error(
            `Capability generation confirmation timed out after ${String(timeoutMs)}ms`,
          ),
        );
      }, timeoutMs);
      const pending = {
        resolve: (generationToken: string) => {
          clearTimeout(timer);
          resolve(generationToken);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.#pendingCapabilityCurrentRequests.set(requestId, pending);
      child.send(
        { type: "capabilities/current", requestId } satisfies HostCommand,
        (error) => {
          if (error === null) return;
          if (!this.#pendingCapabilityCurrentRequests.delete(requestId)) return;
          pending.reject(error);
        },
      );
    });
  }

  #confirmCapabilityReplacement(
    requestId: string,
    generationToken: string,
  ): void {
    const uncertain = this.#uncertainCapabilityReplacement;
    if (
      uncertain?.requestId !== requestId ||
      uncertain.snapshot.generationToken !== generationToken
    ) {
      return;
    }
    this.#publishedCapabilitySnapshot = structuredClone(uncertain.snapshot);
    this.#uncertainCapabilityReplacement = undefined;
  }

  #rejectPendingCapabilityCurrentRequests(error: Error): void {
    for (const pending of this.#pendingCapabilityCurrentRequests.values()) {
      pending.reject(error);
    }
    this.#pendingCapabilityCurrentRequests.clear();
  }

  #captureCapabilitySnapshot(): ZenXCapabilityGenerationSnapshot {
    const host = this.#options.capabilityHost;
    if (host === undefined) {
      return { definitions: [], generationToken: `empty-${randomUUID()}` };
    }
    if (host.captureHostSnapshot !== undefined) {
      const snapshot = host.captureHostSnapshot();
      this.#heldCapabilityGenerations.add(snapshot.generationToken);
      return snapshot;
    }
    const snapshot = host.hostSnapshot?.() ?? { definitions: [] };
    return { ...snapshot, generationToken: `legacy-${randomUUID()}` };
  }

  #releaseCapabilityGeneration(generationToken: string): void {
    if (!this.#heldCapabilityGenerations.delete(generationToken)) return;
    this.#options.capabilityHost?.releaseHostGeneration?.(generationToken);
  }

  #releaseAllCapabilityGenerations(): Error[] {
    const failures: Error[] = [];
    for (const generationToken of [...this.#heldCapabilityGenerations]) {
      try {
        this.#releaseCapabilityGeneration(generationToken);
      } catch (error) {
        failures.push(asError(error));
      }
    }
    return failures;
  }
}

async function createPrivateTokenFile(filePath: string): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const handle = await open(filePath, "w", 0o600);
  try {
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await chmod(filePath, 0o600);
  return token;
}

function assertTargetOnlyCapabilityChange(
  previous: ZenXCapabilityHostSnapshot,
  next: ZenXCapabilityHostSnapshot,
  targetPluginId: string,
): void {
  const targetToolNames = new Set(
    [...(previous.plugins ?? []), ...(next.plugins ?? [])]
      .filter((plugin) => plugin.id === targetPluginId)
      .flatMap((plugin) => plugin.tools.map((tool) => tool.name)),
  );
  const withoutTarget = (snapshot: ZenXCapabilityHostSnapshot) => ({
    definitions: snapshot.definitions
      .filter((definition) => !targetToolNames.has(definition.name))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
    plugins: (snapshot.plugins ?? [])
      .filter((plugin) => plugin.id !== targetPluginId)
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  });
  if (
    JSON.stringify(withoutTarget(previous)) !==
    JSON.stringify(withoutTarget(next))
  ) {
    throw new Error(
      `Plugin reload for ${targetPluginId} changed a non-target capability projection`,
    );
  }
}

async function removeTokenFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForReady(
  child: ChildProcess,
  timeoutMs: number,
  command: HostCommand,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out starting Zen App Server")),
      timeoutMs,
    );
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onMessage = (message: unknown): void => {
      if (!isHostEvent(message)) return;
      if (message.type !== "ready" && message.type !== "error") return;
      cleanup();
      if (message.type === "ready") resolve(message.url);
      else reject(new Error(message.message));
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      cleanup();
      reject(
        new Error(
          `Zen App Server exited during startup (${signal ?? String(code)})`,
        ),
      );
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
    child.send(command);
  });
}

export async function stopOwnedAppServerChild(
  child: ChildProcess,
  observation: OwnedChildObservation,
  options: { shutdownGraceMs: number; terminationGraceMs: number },
): Promise<void> {
  if (observation.outcome() === undefined) {
    try {
      if (child.connected)
        child.send({ type: "shutdown" } satisfies HostCommand);
    } catch {
      // The exact child terminal observation decides whether escalation remains necessary.
    }
  }
  if (
    observation.outcome() === undefined &&
    !(await terminalWithin(observation, options.shutdownGraceMs))
  ) {
    child.kill("SIGTERM");
  }
  if (
    observation.outcome() === undefined &&
    !(await terminalWithin(observation, options.terminationGraceMs))
  ) {
    child.kill("SIGKILL");
  }
  const outcome = observation.outcome() ?? (await observation.terminal);
  if (outcome.type === "spawn_error") throw outcome.error;
}

async function terminalWithin(
  observation: OwnedChildObservation,
  timeoutMs: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Owned child shutdown deadline must be a positive integer");
  }
  if (observation.outcome() !== undefined) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void observation.terminal.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function readHostMessageRequestId(value: unknown): string | undefined {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      !("requestId" in value) ||
      typeof value.requestId !== "string"
    ) {
      return undefined;
    }
    return value.requestId;
  } catch {
    return undefined;
  }
}
