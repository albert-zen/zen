import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { ZenAppServer, ThreadSnapshot } from "../../app-server.js";
import { AppServerError } from "../../app-server.js";
import type { CanonicalItem } from "../../item.js";
import { REMOTE_HOST_VERSION } from "./remote-wire.js";
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
  constructor(readonly code: RemoteErrorCode) {
    super(code);
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

interface Device {
  digest: Buffer;
  revoked: boolean;
  workspaceIds: readonly string[] | null;
}
/** Host-external, process-local device grants: losing the process invalidates every token. */
export class RemoteHostAccess {
  readonly #appServer: ZenAppServer;
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
    workspaces: () =>
      readonly RemoteWorkspace[] | Promise<readonly RemoteWorkspace[]>;
  }) {
    if (!options.hostId.trim()) throw new Error("Host ID required");
    this.#appServer = options.appServer;
    this.#hostId = options.hostId;
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
    if (!validId(input.deviceId) || !validToken(input.code))
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
    this.#devices.set(input.deviceId, {
      digest: digest(token),
      revoked: false,
      workspaceIds: pair.workspaceIds,
    });
    return { hostId: this.#hostId, deviceId: input.deviceId, token };
  }
  revoke(deviceId: string): void {
    const device = this.#devices.get(deviceId);
    if (device) {
      device.revoked = true;
      for (const listener of this.#revocationListeners) listener(deviceId);
    }
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
        "threads",
        "create",
        "resume",
        "resumePage",
        "send",
        "interrupt",
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
  ): Promise<RemoteThreadView> {
    const cwd = await this.#workspace(deviceId, token, workspaceId);
    this.authenticate(deviceId, token);
    // Until mobile approval policy is designed, remote commands may not
    // silently inherit the local Full Access default or approve tool calls.
    return publicThread(
      await this.#appServer.startThread({
        cwd,
        sandbox: "read-only",
        approvalPolicy: "always",
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
  async send(
    deviceId: string,
    token: string,
    input: RemoteSend,
  ): Promise<{ turnId: string }> {
    if (
      !validId(input.clientId) ||
      typeof input.text !== "string" ||
      input.text.length < 1 ||
      input.text.length > 32_768
    )
      throw new RemoteHostError("invalid_request");
    const thread = await this.#thread(
      deviceId,
      token,
      input.workspaceId,
      input.threadId,
    );
    if (thread.sandbox !== "read-only" || thread.approvalPolicy !== "always")
      throw new RemoteHostError("operation_forbidden");
    this.authenticate(deviceId, token);
    try {
      const handle = await this.#appServer.startTurn(
        input.threadId,
        input.text,
        {
          clientId: input.clientId,
          requirePermissions: {
            sandbox: "read-only",
            approvalPolicy: "always",
          },
        },
      );
      void handle.done.catch(() => undefined);
      return { turnId: handle.id };
    } catch (error) {
      throw fromAppServer(error);
    }
  }
  async interrupt(
    deviceId: string,
    token: string,
    workspaceId: string,
    threadId: string,
    expectedTurnId: string,
  ): Promise<{}> {
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
          await this.#thread(deviceId, token, workspaceId, threadId);
          if (!disposed) listener(publicEvent(event));
        } catch {
          /* authorization changed; never publish */
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
  return new RemoteHostError("invalid_request");
}
