export interface RemoteRoomsPort {
  request(
    operation: "list" | "read" | "post",
    params: {
      workspaceId: string;
      workspaceCwd: string;
      deviceId: string;
      roomId?: string;
      text?: string;
      clientId?: string;
    },
  ): Promise<unknown>;
  subscribe(
    listener: (event: { roomId: string; threadId: string }) => void,
  ): () => void;
}
import { RemoteGrantFile } from "./remote-grants.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { ZenAppServer, ThreadSnapshot } from "../../app-server.js";
import { AppServerError } from "../../app-server.js";
import type { CanonicalItem } from "../../item.js";
import {
  REMOTE_HOST_VERSION,
  REMOTE_UNARCHIVED_SEND_CAPABILITY,
  REMOTE_SHELL_MAX_COMMAND_BYTES,
  REMOTE_SHELL_MAX_TIMEOUT_MS,
  REMOTE_SHELL_MAX_OUTPUT_BYTES,
  type RemoteShellRequest,
  type RemoteShellResult,
} from "./remote-wire.js";
import type {
  RemoteWorkspaceView,
  RemotePairRequest,
  RemotePairResult,
  RemoteSend,
  RemoteItemView,
  RemoteThreadView,
  RemoteThreadSummary,
  RemoteEventView,
  RemoteRecoveryPage,
  RemoteRecoveryEntry,
  RemoteErrorCode,
} from "./remote-wire.js";
export { REMOTE_HOST_VERSION } from "./remote-wire.js";
export type {
  RemoteWorkspaceView,
  RemotePairRequest,
  RemotePairResult,
  RemoteSend,
  RemoteItemView,
  RemoteThreadView,
  RemoteThreadSummary,
  RemoteEventView,
  RemoteRecoveryPage,
  RemoteRecoveryEntry,
  RemoteErrorCode,
} from "./remote-wire.js";
/** Host-only allowlist entry; cwd never appears in the mobile wire. */
export interface RemoteWorkspace extends RemoteWorkspaceView {
  cwd: string;
}
import {
  NativeRecoveryProjection,
  type NativeProjectedThreadEvent,
} from "./recovery.js";

/** Allowlist rather than a recursive clone: never serialize raw provider/tool/reasoning/configuration items. */
export function projectRemoteItem(item: CanonicalItem): RemoteItemView | null {
  const base = {
    id: item.id,
    threadId: item.threadId,
    ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
    createdAt: item.createdAt,
  };
  if (item.type === "user_message")
    return {
      ...base,
      type: item.type,
      text:
        item.text ??
        item.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
    };
  if (item.type === "agent_message")
    return { ...base, type: item.type, text: item.text };
  if (
    item.type === "turn_started" ||
    item.type === "turn_completed" ||
    item.type === "turn_aborted"
  )
    return { ...base, type: item.type };
  return null;
}
function publicThread(thread: ThreadSnapshot): RemoteThreadView {
  return {
    id: thread.id,
    ...(thread.name === undefined ? {} : { name: thread.name }),
    archived: thread.archived,
    items: thread.items
      .map(projectRemoteItem)
      .filter((item): item is RemoteItemView => item !== null),
    turns: thread.turns.map(({ id, status }) => ({ id, status })),
  };
}
function publicEvent(projected: NativeProjectedThreadEvent): RemoteEventView {
  const event = projected.event;
  let safe: RemoteEventView["event"] = { type: "redacted" };
  if (event.type === "item_completed") {
    const item = projectRemoteItem(event.item);
    if (item !== null) safe = { type: "item_completed", item };
  } else if (event.type === "turn_started")
    safe = { type: "turn_started", turnId: event.turnId };
  else if (event.type === "turn_completed")
    safe = {
      type: "turn_completed",
      turnId: event.turnId,
      status: event.status,
    };
  return {
    processEpoch: projected.processEpoch,
    threadId: projected.threadId,
    watermark: projected.watermark,
    event: safe,
  };
}

export class RemoteHostError extends Error {
  constructor(
    readonly code: RemoteErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "RemoteHostError";
  }
}

export interface RemoteRecoveryPosition {
  itemIndex: number;
  textOffset: number;
}
export interface RemoteRecoveryBoundary {
  processEpoch: string;
  threadId: string;
  watermark: number;
  itemCount: number;
}
/** Response body is below the transport's 2 MiB cap even with a 64 KiB request id. */
export const REMOTE_RECOVERY_PAGE_BYTES = 256 * 1024;
/** Only a position and recent page, never a second complete ItemList, survive between requests. */
export function projectRemoteRecoveryPage(
  thread: ThreadSnapshot,
  boundary: RemoteRecoveryBoundary,
  position: RemoteRecoveryPosition,
): { page: RemoteRecoveryPage; next: RemoteRecoveryPosition | null } {
  if (
    thread.id !== boundary.threadId ||
    thread.items.length < boundary.itemCount ||
    !Number.isSafeInteger(position.itemIndex) ||
    position.itemIndex < 0 ||
    position.itemIndex > boundary.itemCount ||
    !Number.isSafeInteger(position.textOffset) ||
    position.textOffset < 0
  )
    throw new RemoteHostError("resync_required");
  const page: RemoteRecoveryPage = {
    processEpoch: boundary.processEpoch,
    threadId: boundary.threadId,
    watermark: boundary.watermark,
    thread: {
      id: thread.id,
      ...(thread.name === undefined ? {} : { name: thread.name }),
      archived: thread.archived,
    },
    entries: [],
    nextCursor: null,
  };
  const fits = (entry?: RemoteRecoveryEntry) =>
    Buffer.byteLength(
      JSON.stringify({
        ...page,
        entries: entry === undefined ? page.entries : [...page.entries, entry],
        nextCursor: "x".repeat(64),
      }),
    ) <= REMOTE_RECOVERY_PAGE_BYTES;
  if (!fits()) throw new RemoteHostError("entry_too_large");
  let { itemIndex, textOffset } = position;
  while (itemIndex < boundary.itemCount) {
    const publicItem = projectRemoteItem(thread.items[itemIndex]!);
    if (publicItem === null) {
      if (textOffset !== 0) throw new RemoteHostError("resync_required");
      itemIndex += 1;
      continue;
    }
    const turn =
      publicItem.type === "turn_started"
        ? thread.turns.find(({ id }) => id === publicItem.turnId)
        : undefined;
    const attachedTurn =
      turn === undefined ? {} : { turn: { id: turn.id, status: turn.status } };
    if (textOffset === 0) {
      const full: RemoteRecoveryEntry = {
        kind: "item",
        item: publicItem,
        ...attachedTurn,
      };
      if (fits(full)) {
        page.entries.push(full);
        itemIndex += 1;
        continue;
      }
    }
    const text = publicItem.text;
    if (text === undefined || textOffset >= text.length) {
      if (page.entries.length > 0 && textOffset === 0) break;
      throw new RemoteHostError("entry_too_large");
    }
    const { text: _text, ...metadata } = publicItem;
    let low = 1,
      high = text.length - textOffset,
      best = 0;
    const fragment = (count: number): RemoteRecoveryEntry => ({
      kind: "text_fragment",
      item: metadata,
      offset: textOffset,
      text: text.slice(textOffset, textOffset + count),
      complete: textOffset + count === text.length,
    });
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (fits(fragment(mid))) {
        best = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    if (best === 0) {
      if (page.entries.length > 0) break;
      throw new RemoteHostError("entry_too_large");
    }
    page.entries.push(fragment(best));
    textOffset += best;
    if (textOffset === text.length) {
      textOffset = 0;
      itemIndex += 1;
    }
  }
  return {
    page,
    next: itemIndex >= boundary.itemCount ? null : { itemIndex, textOffset },
  };
}

/** Target Host execution boundary, not a general tool-forwarding port. */
export interface RemoteShellPort {
  execute(
    request: RemoteShellRequest,
    resolveTarget: () => Promise<ThreadSnapshot>,
    signal: AbortSignal,
  ): Promise<RemoteShellResult>;
}
interface Device {
  digest: Buffer;
  revoked: boolean;
  access?: "read" | "control" | undefined;
  workspaceIds: readonly string[] | null;
  shellEnabled?: boolean;
}
/** Host-external grants; an explicit private state file preserves authorization across restarts. */
export class RemoteHostAccess {
  readonly #appServer: ZenAppServer;
  readonly #grantFile: RemoteGrantFile | undefined;
  readonly #accessMode: "read" | "control" | undefined;
  readonly #rooms: RemoteRoomsPort | undefined;
  readonly #shell: RemoteShellPort | undefined;
  readonly #shellEnabled: boolean;
  readonly #shellRequests = new Map<AbortController, string>();
  readonly #hostId: string;
  readonly #workspaces: () =>
    readonly RemoteWorkspace[] | Promise<readonly RemoteWorkspace[]>;
  readonly #devices = new Map<string, Device>();
  readonly #projection: NativeRecoveryProjection;
  #pair:
    | { digest: Buffer; until: number; workspaceIds: readonly string[] | null }
    | undefined;
  #closed = false;
  readonly #revocationListeners = new Set<(id: string) => void>();

  constructor(options: {
    appServer: ZenAppServer;
    hostId: string;
    grantFile?: string;
    access?: "read" | "control" | undefined;
    rooms?: RemoteRoomsPort;
    shell?: RemoteShellPort;
    shellEnabled?: boolean;
    workspaces: () =>
      readonly RemoteWorkspace[] | Promise<readonly RemoteWorkspace[]>;
  }) {
    if (!options.hostId.trim()) throw new Error("Host ID required");
    this.#appServer = options.appServer;
    this.#hostId = options.hostId;
    this.#accessMode = options.access;
    this.#rooms = options.rooms;
    this.#shell = options.shell;
    this.#shellEnabled = options.shellEnabled === true;
    this.#grantFile = options.grantFile
      ? new RemoteGrantFile(options.grantFile, options.hostId)
      : undefined;
    for (const grant of this.#grantFile?.read() ?? [])
      this.#devices.set(grant.deviceId, {
        digest: Buffer.from(grant.digest, "hex"),
        revoked: grant.revoked,
        workspaceIds: grant.workspaceIds,
        access: grant.access,
        shellEnabled: grant.shellEnabled === true,
      });
    this.#workspaces = options.workspaces;
    this.#projection = new NativeRecoveryProjection(options.appServer);
  }
  get hostId() {
    return this.#hostId;
  }
  createPairingCode(workspaceIds: readonly string[] | null = null): string {
    if (this.#closed) throw new RemoteHostError("unauthorized");
    const code = randomBytes(32).toString("base64url");
    this.#pair = {
      digest: digest(code),
      until: Date.now() + 5 * 60_000,
      workspaceIds,
    };
    return code;
  }
  async pair(input: RemotePairRequest): Promise<RemotePairResult> {
    if (input.hostId !== this.#hostId) throw new RemoteHostError("wrong_host");
    if (
      !validId(input.deviceId) ||
      !validToken(input.code) ||
      (input.access !== undefined &&
        input.access !== "read" &&
        input.access !== "control") ||
      (input.shellEnabled !== undefined &&
        typeof input.shellEnabled !== "boolean")
    )
      throw new RemoteHostError("invalid_request");
    const pair = this.#pair;
    if (
      !pair ||
      Date.now() > pair.until ||
      !timingSafeEqual(pair.digest, digest(input.code))
    )
      throw new RemoteHostError("unauthorized");
    this.#pair = undefined;
    const token = randomBytes(32).toString("base64url");
    const device = {
      digest: digest(token),
      revoked: false,
      workspaceIds: pair.workspaceIds,
      access: input.access === "read" ? ("read" as const) : this.#accessMode,
      shellEnabled:
        this.#shellEnabled &&
        input.shellEnabled === true &&
        input.access !== "read" &&
        this.#accessMode === "control",
    };
    this.#saveGrants(new Map([...this.#devices, [input.deviceId, device]]));
    this.#devices.set(input.deviceId, device);
    return { hostId: this.#hostId, deviceId: input.deviceId, token };
  }
  revoke(deviceId: string): void {
    const device = this.#devices.get(deviceId);
    if (device) {
      this.#saveGrants(
        new Map([...this.#devices, [deviceId, { ...device, revoked: true }]]),
      );
      device.revoked = true;
      for (const [controller, owner] of this.#shellRequests)
        if (owner === deviceId) controller.abort();
      for (const listener of this.#revocationListeners) listener(deviceId);
    }
  }
  devices(): Array<{
    deviceId: string;
    revoked: boolean;
    workspaceIds: readonly string[] | null;
    access?: "read" | "control" | undefined;
    shellEnabled: boolean;
  }> {
    return [...this.#devices].map(([deviceId, device]) => ({
      deviceId,
      revoked: device.revoked,
      workspaceIds: device.workspaceIds,
      access: device.access,
      shellEnabled: device.shellEnabled === true,
    }));
  }
  #saveGrants(devices: Map<string, Device>): void {
    this.#grantFile?.write(
      [...devices].map(([deviceId, device]) => ({
        deviceId,
        digest: device.digest.toString("hex"),
        revoked: device.revoked,
        access: device.access,
        shellEnabled: device.shellEnabled === true,
        workspaceIds:
          device.workspaceIds === null ? null : [...device.workspaceIds],
      })),
    );
  }
  onRevocation(listener: (id: string) => void): () => void {
    this.#revocationListeners.add(listener);
    return () => this.#revocationListeners.delete(listener);
  }
  authenticate(deviceId: string, token: string): void {
    if (this.#closed || !validId(deviceId) || !validToken(token))
      throw new RemoteHostError("unauthorized");
    const device = this.#devices.get(deviceId);
    if (!device || !timingSafeEqual(device.digest, digest(token)))
      throw new RemoteHostError("unauthorized");
    if (device.revoked) throw new RemoteHostError("revoked");
  }
  async hello(
    deviceId: string,
    token: string,
    hostId: string,
    version: number,
  ) {
    this.authenticate(deviceId, token);
    if (hostId !== this.#hostId) throw new RemoteHostError("wrong_host");
    if (version !== REMOTE_HOST_VERSION)
      throw new RemoteHostError("unsupported_version");
    return {
      version: REMOTE_HOST_VERSION,
      hostId: this.#hostId,
      processEpoch: this.#projection.processEpoch,
      capabilities: [
        "workspaces",
        "models",
        ...(this.#rooms ? ["rooms"] : []),
        "threads",
        "create",
        "resume",
        "resumePage",
        "send",
        REMOTE_UNARCHIVED_SEND_CAPABILITY,
        "interrupt",
        ...(this.#shell && this.#shellAllowed(deviceId) ? ["shell"] : []),
      ],
    };
  }
  async workspaces(
    deviceId: string,
    token: string,
  ): Promise<RemoteWorkspaceView[]> {
    this.authenticate(deviceId, token);
    const entries = await this.#workspaces();
    const grant = this.#devices.get(deviceId)?.workspaceIds;
    return entries
      .filter(({ id }) => grant === null || grant?.includes(id))
      .map(({ id, label }) => ({ id, label }));
  }
  async #workspace(
    deviceId: string,
    token: string,
    id: string,
  ): Promise<string> {
    this.authenticate(deviceId, token);
    const entries = await this.#workspaces();
    const grant = this.#devices.get(deviceId)?.workspaceIds;
    const matching = entries.filter(
      (entry) =>
        entry.id === id &&
        validId(entry.id) &&
        (grant === null || grant?.includes(id)),
    );
    if (matching.length !== 1) throw new RemoteHostError("wrong_workspace");
    try {
      return await realpath(matching[0]!.cwd);
    } catch {
      throw new RemoteHostError("wrong_workspace");
    }
  }
  async #thread(
    deviceId: string,
    token: string,
    workspaceId: string,
    threadId: string,
  ): Promise<ThreadSnapshot> {
    const cwd = await this.#workspace(deviceId, token, workspaceId);
    let thread: ThreadSnapshot;
    try {
      thread = await this.#appServer.readThread(threadId);
    } catch {
      throw new RemoteHostError("thread_not_found");
    }
    try {
      if ((await realpath(thread.cwd)) !== cwd)
        throw new RemoteHostError("wrong_workspace");
    } catch (error) {
      if (error instanceof RemoteHostError) throw error;
      throw new RemoteHostError("wrong_workspace");
    }
    this.authenticate(deviceId, token);
    if (thread.archived) throw new RemoteHostError("stale_thread");
    return thread;
  }
  async threads(
    deviceId: string,
    token: string,
    workspaceId: string,
  ): Promise<RemoteThreadSummary[]> {
    const cwd = await this.#workspace(deviceId, token, workspaceId);
    const summaries = await this.#appServer.listThreadSummaries();
    const allowed: RemoteThreadSummary[] = [];
    for (const summary of summaries) {
      if (summary.status === "systemError") continue;
      try {
        if ((await realpath(summary.currentMetadata.cwd)) === cwd)
          allowed.push({
            threadId: summary.threadId,
            ...(summary.name === undefined ? {} : { name: summary.name }),
            status: summary.status,
          });
      } catch {
        /* inaccessible workspace is not advertised */
      }
    }
    this.authenticate(deviceId, token);
    return allowed;
  }
  async create(
    deviceId: string,
    token: string,
    workspaceId: string,
    settings: { model?: string; effort?: string } = {},
  ): Promise<RemoteThreadView> {
    const control = this.#writeAccess(deviceId, token);
    const cwd = await this.#workspace(deviceId, token, workspaceId);
    this.authenticate(deviceId, token);
    // Until mobile approval policy is designed, remote commands may not
    // silently inherit the local Full Access default or approve tool calls.
    const choices = this.#appServer.listModels();
    const selected =
      settings.model === undefined
        ? undefined
        : choices.filter(
            (entry) =>
              `${entry.providerProfileId}::${entry.model.id}` ===
                settings.model || entry.model.id === settings.model,
          );
    if (selected && selected.length !== 1)
      throw new RemoteHostError("invalid_request");
    return publicThread(
      await this.#appServer.startThread({
        cwd,
        ...(control
          ? {}
          : {
              sandbox: "read-only" as const,
              approvalPolicy: "always" as const,
            }),
        ...(selected?.[0]
          ? {
              providerProfileId: selected[0].providerProfileId,
              modelId: selected[0].model.id,
            }
          : {}),
        ...(settings.effort ? { reasoningEffort: settings.effort } : {}),
      }),
    );
  }
  async beginRecovery(
    deviceId: string,
    token: string,
    workspaceId: string,
    threadId: string,
  ): Promise<{ boundary: RemoteRecoveryBoundary; thread: ThreadSnapshot }> {
    await this.#thread(deviceId, token, workspaceId, threadId);
    const snapshot = await this.#projection.resume(threadId);
    await this.#thread(deviceId, token, workspaceId, threadId);
    return {
      boundary: {
        processEpoch: snapshot.processEpoch,
        threadId: snapshot.threadId,
        watermark: snapshot.watermark,
        itemCount: snapshot.thread.items.length,
      },
      thread: snapshot.thread,
    };
  }
  async recoveryThread(
    deviceId: string,
    token: string,
    workspaceId: string,
    boundary: RemoteRecoveryBoundary,
  ): Promise<ThreadSnapshot> {
    if (boundary.processEpoch !== this.#projection.processEpoch)
      throw new RemoteHostError("resync_required");
    const thread = await this.#thread(
      deviceId,
      token,
      workspaceId,
      boundary.threadId,
    );
    // The allowlist callback is deliberately dynamic. A slow journal read may
    // overlap removal/remapping of a workspace after #thread's first lookup;
    // re-evaluate the current mapping before either a fresh or cached reply.
    const currentCwd = await this.#workspace(deviceId, token, workspaceId);
    try {
      if ((await realpath(thread.cwd)) !== currentCwd)
        throw new RemoteHostError("wrong_workspace");
    } catch (error) {
      if (error instanceof RemoteHostError) throw error;
      throw new RemoteHostError("wrong_workspace");
    }
    this.authenticate(deviceId, token);
    if (boundary.processEpoch !== this.#projection.processEpoch)
      throw new RemoteHostError("resync_required");
    if (thread.items.length < boundary.itemCount)
      throw new RemoteHostError("resync_required");
    return thread;
  }
  #writeAccess(deviceId: string, token: string): boolean {
    this.authenticate(deviceId, token);
    const mode =
      this.#accessMode === "read"
        ? "read"
        : this.#devices.get(deviceId)?.access;
    if (mode === "read") throw new RemoteHostError("operation_forbidden");
    return mode === "control";
  }
  models(deviceId: string, token: string) {
    this.authenticate(deviceId, token);
    return this.#appServer.listModels().map((entry) => ({
      id: `${entry.providerProfileId}::${entry.model.id}`,
      model: entry.model.id,
      displayName: entry.model.displayName ?? entry.model.id,
      isDefault: entry.isDefault,
      supportedReasoningEfforts: (
        entry.model.supportedReasoningEfforts ?? []
      ).map((reasoningEffort) => ({
        reasoningEffort,
        description: reasoningEffort,
      })),
      defaultReasoningEffort: entry.model.defaultReasoningEffort ?? null,
    }));
  }
  async send(
    deviceId: string,
    token: string,
    input: RemoteSend,
  ): Promise<{ turnId?: string; queued?: boolean }> {
    const control = this.#writeAccess(deviceId, token);
    if (
      !validId(input.clientId) ||
      typeof input.text !== "string" ||
      !input.text ||
      input.text.length > 32768 ||
      (input.messageType !== undefined &&
        !["guidance", "follow_up", "replacement"].includes(input.messageType))
    )
      throw new RemoteHostError("invalid_request");
    for (let attempt = 0; attempt < 8; attempt++) {
      const thread = await this.#thread(
        deviceId,
        token,
        input.workspaceId,
        input.threadId,
      );
      if (
        !control &&
        (thread.sandbox !== "read-only" || thread.approvalPolicy !== "always")
      )
        throw new RemoteHostError("operation_forbidden");
      this.#writeAccess(deviceId, token);
      const options = {
        clientId: input.clientId,
        requireUnarchived: true,
        ...(control
          ? {}
          : {
              requirePermissions: {
                sandbox: "read-only" as const,
                approvalPolicy: "always" as const,
              },
            }),
      };
      try {
        if (input.messageType === "follow_up") {
          if (!control) throw new RemoteHostError("operation_forbidden");
          await this.#appServer.queueMessage(
            input.threadId,
            input.text,
            input.clientId,
            { requireUnarchived: true },
          );
          return { queued: true };
        }
        const active = control
          ? publicThread(thread).turns.find(
              (turn) => turn.status === "inProgress",
            )?.id
          : undefined;
        if (active && input.messageType === "replacement") {
          const result = await this.#appServer.replaceTurn(
            input.threadId,
            active,
            input.text,
            options,
          );
          void result.turn.done.catch(() => undefined);
          return { turnId: result.turn.id };
        }
        const handle = active
          ? await this.#appServer.steerTurn(
              input.threadId,
              active,
              input.text,
              options,
            )
          : await this.#appServer.startTurn(
              input.threadId,
              input.text,
              options,
            );
        void handle.done.catch(() => undefined);
        return { turnId: handle.id };
      } catch (error) {
        if (
          error instanceof AppServerError &&
          ["thread_busy", "turn_not_running"].includes(error.code) &&
          attempt < 7
        )
          continue;
        throw fromAppServer(error);
      }
    }
    throw new RemoteHostError("thread_busy");
  }
  #shellAllowed(deviceId: string): boolean {
    return (
      this.#shellEnabled &&
      this.#accessMode === "control" &&
      this.#devices.get(deviceId)?.access === "control" &&
      this.#devices.get(deviceId)?.shellEnabled === true
    );
  }
  async shell(
    deviceId: string,
    token: string,
    input: RemoteShellRequest,
    signal: AbortSignal,
  ): Promise<RemoteShellResult> {
    this.authenticate(deviceId, token);
    if (!this.#shell || !this.#shellAllowed(deviceId))
      throw new RemoteHostError("operation_forbidden");
    if (
      !validId(input.workspaceId) ||
      !validId(input.targetThreadId) ||
      typeof input.command !== "string" ||
      !input.command.trim() ||
      input.command.includes("\0") ||
      Buffer.byteLength(input.command) > REMOTE_SHELL_MAX_COMMAND_BYTES ||
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.timeoutMs > REMOTE_SHELL_MAX_TIMEOUT_MS ||
      !Number.isSafeInteger(input.maxOutputBytes) ||
      input.maxOutputBytes < 1 ||
      input.maxOutputBytes > REMOTE_SHELL_MAX_OUTPUT_BYTES
    )
      throw new RemoteHostError("invalid_request");
    const controller = new AbortController();
    const bounded = AbortSignal.any([signal, controller.signal]);
    const resolveTarget = async () => {
      bounded.throwIfAborted();
      const thread = await this.#thread(
        deviceId,
        token,
        input.workspaceId,
        input.targetThreadId,
      );
      const cwd = await this.#workspace(deviceId, token, input.workspaceId);
      if (thread.archived) throw new RemoteHostError("stale_thread");
      if ((await realpath(thread.cwd)) !== cwd)
        throw new RemoteHostError("wrong_workspace");
      this.authenticate(deviceId, token);
      if (!this.#shellAllowed(deviceId))
        throw new RemoteHostError("operation_forbidden");
      bounded.throwIfAborted();
      return thread;
    };
    this.#shellRequests.set(controller, deviceId);
    try {
      return await this.#shell.execute(input, resolveTarget, bounded);
    } finally {
      this.#shellRequests.delete(controller);
    }
  }
  async roomRequest(
    deviceId: string,
    token: string,
    operation: "list" | "read" | "post",
    params: {
      workspaceId: string;
      roomId?: string;
      text?: string;
      clientId?: string;
    },
  ): Promise<unknown> {
    if (!this.#rooms) throw new RemoteHostError("operation_forbidden");
    if (operation === "post" && !this.#writeAccess(deviceId, token))
      throw new RemoteHostError("operation_forbidden");
    const workspaceCwd = await this.#workspace(
      deviceId,
      token,
      params.workspaceId,
    );
    const result = await this.#rooms.request(operation, {
      ...params,
      workspaceCwd,
      deviceId,
    });
    this.authenticate(deviceId, token);
    return result;
  }
  onRoomChange(
    deviceId: string,
    token: string,
    workspaceId: string,
    listener: (event: { roomId: string; workspaceId: string }) => void,
  ): () => void {
    if (!this.#rooms) return () => {};
    let active = true;
    const dispose = this.#rooms.subscribe((event) => {
      void this.#thread(deviceId, token, workspaceId, event.threadId)
        .then(() => {
          if (active) listener({ roomId: event.roomId, workspaceId });
        })
        .catch(() => {});
    });
    return () => {
      active = false;
      dispose();
    };
  }
  async interrupt(
    deviceId: string,
    token: string,
    workspaceId: string,
    threadId: string,
    expectedTurnId: string,
  ): Promise<{}> {
    this.#writeAccess(deviceId, token);
    if (!validId(expectedTurnId)) throw new RemoteHostError("invalid_request");
    await this.#thread(deviceId, token, workspaceId, threadId);
    try {
      await this.#appServer.interruptTurn(threadId, expectedTurnId);
      return {};
    } catch (error) {
      throw fromAppServer(error);
    }
  }
  subscribe(
    deviceId: string,
    token: string,
    workspaceId: string,
    threadId: string,
    listener: (event: RemoteEventView | null) => void,
  ): () => void {
    let disposed = false;
    let inFlight = 0;
    let chain = Promise.resolve();
    const unsubscribe = this.#projection.subscribe((projected) => {
      if (
        projected.type !== "thread_event" ||
        projected.event.threadId !== threadId
      )
        return;
      if (inFlight >= 256) {
        disposed = true;
        unsubscribe();
        listener(null); // canonical restart, not a silent event gap
        return;
      }
      inFlight += 1;
      const event = projected.event;
      chain = chain.then(async () => {
        try {
          if (disposed) return;
          // Validation after the asynchronous read is just as important for
          // live events as it is for paged replies. A failed read or a scope
          // gap poisons this subscription; regrant requires a new resume.
          await this.recoveryThread(deviceId, token, workspaceId, {
            processEpoch: event.processEpoch,
            threadId,
            watermark: event.watermark,
            itemCount: 0,
          });
          if (!disposed) listener(publicEvent(event));
        } catch {
          if (!disposed) {
            disposed = true;
            unsubscribe();
            listener(null);
          }
        } finally {
          inFlight -= 1;
        }
      });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }
  close(): void {
    this.#closed = true;
    for (const controller of this.#shellRequests.keys()) controller.abort();
    this.#pair = undefined;
    this.#devices.clear();
    this.#projection.close();
    this.#revocationListeners.clear();
  }
}
function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
function validId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 256 &&
    !/[\u0000-\u001f]/u.test(id)
  );
}
function validToken(token: unknown): token is string {
  return typeof token === "string" && token.length > 0 && token.length < 512;
}
function fromAppServer(error: unknown): RemoteHostError {
  if (
    error instanceof AppServerError &&
    (error.code === "thread_busy" || error.code === "idempotency_conflict")
  )
    return new RemoteHostError(error.code);
  if (error instanceof AppServerError && error.code === "turn_not_running")
    return new RemoteHostError("stale_turn");
  if (error instanceof AppServerError && error.code === "operation_forbidden")
    return new RemoteHostError("operation_forbidden");
  return new RemoteHostError("operation_unknown");
}
