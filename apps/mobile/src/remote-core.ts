import {
  REMOTE_HOST_VERSION,
  REMOTE_METHODS,
  isConfirmedRemoteRejection,
  type RemoteEventView,
  type RemoteItemView,
  type RemotePairResult,
  type RemoteRecoveryEntry,
  type RemoteRecoveryPage,
  type RemoteThreadSummary,
  type RemoteThreadView,
  type RemoteWorkspaceView,
  type RemoteRoomSummary,
  type RemoteRoomView,
  type RemoteRoomPostResult,
  type RemoteModelView,
} from "../../../src/protocol/native/remote-wire";
import { hostEndpoint } from "./fleet.mjs";

type Host = { id: string; endpoint: string; name: string };
type Credential = {
  hostId: string;
  endpoint: string;
  deviceId: string;
  token: string;
};
type Notification =
  | { type: "offline"; revoked?: boolean }
  | { type: "resync" }
  | { type: "room"; roomId: string }
  | {
      type: "snapshot";
      threads: { id: string; title: string; status: string }[];
      turns: Record<string, { id: string; status: string }[]>;
      items: Record<
        string,
        { id: string; role: string; text: string; status: string }[]
      >;
    };
const secureKey = (hostId: string) =>
  `zenx-host-${hostId.replace(/[^a-zA-Z0-9-]/gu, "_").slice(0, 80)}`;
const mapItem = (item: RemoteItemView) => ({
  id: item.id,
  role: item.type,
  text: item.text ?? "",
  status: item.type.startsWith("turn_") ? "recorded" : "completed",
});
const mapThreads = (threads: RemoteThreadSummary[]) =>
  threads.map((t) => ({
    id: t.threadId,
    title: t.name ?? t.threadId,
    status: t.status,
  }));

export class RemoteRejectedError extends Error {
  readonly confirmedRejection = true;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`Host ${code}: ${message}`);
  }
}
// Android uses OS TLS verification. No skipTLSverify and no plaintext fallback.
export type RemoteDependencies = {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  uuid(): string;
  fetch: typeof fetch;
  openSocket(url: string, headers: Record<string, string>): WebSocket;
  /** Bounded waits only; a timed-out mutation may already have been admitted. */
  timeoutMs?: number;
};
export class RemoteHostTransport {
  private socket: WebSocket | null = null;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 0;
  private epoch: string | null = null;
  private watermark = -1;
  private activeThread: string | null = null;
  private activeWorkspace: string | null = null;
  private observer: ((event: Notification) => void) | null = null;
  private items = new Map<string, ReturnType<typeof mapItem>>();
  private turns = new Map<string, string>();
  private summaries: RemoteThreadSummary[] = [];
  private bound: string | null = null;
  private generation = 0;
  private recovering = false;
  private recoveryGeneration = 0;
  private recovered = false;
  private eventBuffer: RemoteEventView[] = [];
  private restartRecovery = false;
  private revokedHosts = new Set<string>();
  private staleCursorRetries = 0;
  private selectedWorkspace: string | null = null;
  private capabilities = new Set<string>();
  private secretWrites = new Map<string, Promise<void>>();
  private secretRevisions = new Map<string, number>();
  private pairingHost: string | null = null;
  private connectingHost: string | null = null;
  private roomEpochs = new Map<string, string>();
  private roomReads = new Map<string, number>();
  constructor(
    private readonly hosts: () => Host[],
    private readonly deps: RemoteDependencies,
  ) {}
  private host(id: string) {
    const host = this.hosts().find((h) => h.id === id);
    if (!host) throw Error("Unknown host");
    hostEndpoint(host.endpoint);
    return host;
  }
  private async credential(id: string): Promise<Credential> {
    const host = this.host(id);
    if (this.revokedHosts.has(id))
      throw Error(
        "Host revoked this device grant. Pair again with a new code.",
      );
    const saved = await this.deps.getSecret(secureKey(id));
    if (!saved) throw Error("Unpaired Host. Pair using a fresh Host code.");
    const credential = JSON.parse(saved) as Credential;
    if (
      credential.hostId !== id ||
      credential.endpoint !== host.endpoint ||
      typeof credential.deviceId !== "string" ||
      !credential.deviceId ||
      typeof credential.token !== "string" ||
      !credential.token
    )
      throw Error("Host address/identity changed; re-pair required.");
    return credential;
  }
  async pairingStatus(
    id: string,
  ): Promise<"paired" | "unpaired" | "invalid" | "revoked"> {
    if (this.revokedHosts.has(id)) return "revoked";
    const saved = await this.deps.getSecret(secureKey(id));
    if (!saved) return "unpaired";
    try {
      await this.credential(id);
      return "paired";
    } catch {
      return "invalid";
    }
  }
  private writeSecret(id: string, write: () => Promise<void>): Promise<void> {
    const previous = this.secretWrites.get(id) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(write);
    this.secretWrites.set(id, result);
    void result
      .finally(() => {
        if (this.secretWrites.get(id) === result) this.secretWrites.delete(id);
      })
      .catch(() => {});
    return result;
  }
  async pair(id: string, code: string): Promise<void> {
    this.pairingHost = id;
    try {
      await this.performPair(id, code);
    } finally {
      if (this.pairingHost === id) this.pairingHost = null;
    }
  }
  private async performPair(id: string, code: string): Promise<void> {
    const host = this.host(id);
    if (!code.trim()) throw Error("Pair code required");
    this.disconnect();
    const generation = this.generation;
    const revision = (this.secretRevisions.get(id) ?? 0) + 1;
    this.secretRevisions.set(id, revision);
    const deviceId = this.deps.uuid();
    const abort = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        abort.abort();
        reject(
          Error(
            "Pairing timed out; the code may have been consumed. Pair again explicitly.",
          ),
        );
      }, this.deps.timeoutMs ?? 15_000);
    });
    let result: RemotePairResult;
    try {
      const response = await Promise.race([
        this.deps.fetch(`${host.endpoint.replace(/\/$/u, "")}/pair`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-zen-host-id": id },
          body: JSON.stringify({ hostId: id, deviceId, code: code.trim() }),
          signal: abort.signal,
        }),
        deadline,
      ]);
      if (!response.ok)
        throw Error(
          `Pairing rejected (${response.status}); check TLS identity and code.`,
        );
      result = (await Promise.race([
        response.json(),
        deadline,
      ])) as RemotePairResult;
    } finally {
      clearTimeout(timeout!);
    }
    if (
      result.hostId !== id ||
      result.deviceId !== deviceId ||
      typeof result.token !== "string" ||
      !result.token
    )
      throw Error("Pair response identity mismatch");
    if (
      generation !== this.generation ||
      this.host(id).endpoint !== host.endpoint
    )
      throw Error(
        "Selection changed during pairing; code may be consumed. Re-pair explicitly.",
      );
    await this.writeSecret(id, async () => {
      if (
        generation !== this.generation ||
        this.secretRevisions.get(id) !== revision
      )
        throw Error("Selection changed during pairing; pair again explicitly.");
      const previous = await this.deps.getSecret(secureKey(id));
      await this.deps.setSecret(
        secureKey(id),
        JSON.stringify({
          hostId: id,
          endpoint: host.endpoint,
          deviceId,
          token: result.token,
        } satisfies Credential),
      );
      if (
        generation !== this.generation ||
        this.secretRevisions.get(id) !== revision
      ) {
        if (previous) await this.deps.setSecret(secureKey(id), previous);
        else await this.deps.deleteSecret(secureKey(id));
        throw Error(
          "Selection changed while saving pairing; pair again explicitly.",
        );
      }
    });
    if (generation === this.generation) this.revokedHosts.delete(id);
  }
  async forget(id: string) {
    this.secretRevisions.set(id, (this.secretRevisions.get(id) ?? 0) + 1);
    // Forgetting another saved device must not interrupt the selected device.
    if (
      this.bound === id ||
      this.connectingHost === id ||
      this.pairingHost === id
    )
      this.disconnect();
    await this.writeSecret(id, () => this.deps.deleteSecret(secureKey(id)));
    this.revokedHosts.delete(id);
  }
  disconnect() {
    this.generation++;
    this.recovering = false;
    this.recovered = false;
    this.recoveryGeneration++;
    this.eventBuffer = [];
    this.restartRecovery = false;
    this.staleCursorRetries = 0;
    this.observer = null;
    this.activeThread = null;
    this.activeWorkspace = null;
    this.epoch = null;
    this.watermark = -1;
    this.items.clear();
    this.turns.clear();
    this.summaries = [];
    this.selectedWorkspace = null;
    this.capabilities.clear();
    this.roomEpochs.clear();
    this.roomReads.clear();
    const socket = this.socket;
    this.socket = null;
    this.bound = null;
    this.connectingHost = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(Error("Connection closed; delivery unconfirmed."));
    }
    this.pending.clear();
    socket?.close();
  }
  private async connect(id: string): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN && this.bound === id) return;
    this.disconnect();
    this.connectingHost = id;
    const generation = this.generation;
    const host = this.host(id),
      grant = await this.credential(id);
    if (generation !== this.generation)
      throw Error("Connection selection changed");
    const url =
      host.endpoint.replace(/^https:/u, "wss:").replace(/\/$/u, "") + "/remote";
    // React Native WebSocket supports handshake headers on Android; browser WebSocket does not.
    const socket = this.deps.openSocket(url, {
      Authorization: `Bearer ${grant.token}`,
      "x-zen-device-id": grant.deviceId,
      "x-zen-host-id": id,
    });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Error("Connection timed out. Reconnect to check Host state."));
        if (this.socket === socket) this.disconnect();
      }, this.deps.timeoutMs ?? 15_000);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(
          Error(
            "TLS/Host connection failed. Check trusted certificate, listener and grant.",
          ),
        );
        if (this.socket === socket) {
          const observer = this.observer;
          this.disconnect();
          observer?.({ type: "offline", revoked: false });
        }
      };
      socket.onclose = (event) => {
        clearTimeout(timer);
        reject(Error("Host closed the connection before it was ready."));
        if (this.socket !== socket) return;
        const revoked = event.code === 4003;
        if (revoked) this.revokedHosts.add(id);
        this.generation++;
        this.recoveryGeneration++;
        this.recovering = false;
        this.recovered = false;
        this.restartRecovery = false;
        this.eventBuffer = [];
        this.items.clear();
        this.turns.clear();
        this.summaries = [];
        this.epoch = null;
        this.watermark = -1;
        this.activeThread = null;
        this.activeWorkspace = null;
        this.bound = null;
        this.connectingHost = null;
        this.selectedWorkspace = null;
        this.capabilities.clear();
        this.roomEpochs.clear();
        this.roomReads.clear();
        this.socket = null;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(Error("Host disconnected; delivery unconfirmed."));
        }
        this.pending.clear();
        this.observer?.({ type: "offline", revoked });
      };
      socket.onmessage = (message) =>
        this.message(socket, String(message.data));
    });
    if (this.socket !== socket || generation !== this.generation)
      throw Error("Connection replaced");
    this.bound = id;
    this.connectingHost = null;
    const hello = await this.request<{
      hostId: string;
      version: number;
      processEpoch: string;
      capabilities?: string[];
    }>(REMOTE_METHODS.hello, { hostId: id, version: REMOTE_HOST_VERSION });
    if (
      hello.hostId !== id ||
      hello.version !== REMOTE_HOST_VERSION ||
      !hello.processEpoch
    ) {
      this.disconnect();
      throw Error("Wrong Host identity/version");
    }
    this.epoch = hello.processEpoch;
    this.capabilities = new Set(hello.capabilities ?? []);
  }
  private message(socket: WebSocket, raw: string) {
    if (socket !== this.socket) return;
    let data: any;
    try {
      data = JSON.parse(raw);
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw Error("Invalid native message envelope");
    } catch {
      const observer = this.observer;
      this.disconnect();
      observer?.({ type: "offline", revoked: false });
      return;
    }
    if (data.method === REMOTE_METHODS.reset) {
      if (data.params?.threadId === this.activeThread)
        this.invalidateRecovery();
      return;
    }
    if (data.method === REMOTE_METHODS.event) {
      try {
        this.event(data.params as RemoteEventView);
      } catch {
        const observer = this.observer;
        this.disconnect();
        observer?.({ type: "offline", revoked: false });
      }
      return;
    }
    if (data.method === REMOTE_METHODS.roomEvent) {
      if (
        typeof data.params?.roomId === "string" &&
        (!data.params.workspaceId ||
          data.params.workspaceId === this.selectedWorkspace)
      )
        this.observer?.({ type: "room", roomId: data.params.roomId });
      return;
    }
    const pending = this.pending.get(data.id);
    if (!pending) return;
    this.pending.delete(data.id);
    clearTimeout(pending.timer);
    if (data.error) {
      const code = data.error?.data?.code;
      pending.reject(
        isConfirmedRemoteRejection(code)
          ? new RemoteRejectedError(
              String(code),
              String(data.error?.message ?? "rejected"),
            )
          : new Error(
              "Remote operation outcome unknown. Reconnect and inspect before a new send; do not replay.",
            ),
      );
    } else pending.resolve(data.result);
  }
  private request<T>(method: string, params: object): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(Error("Host offline"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(
          Error(
            "Host response timed out; delivery unconfirmed. Reconnect and read Host state.",
          ),
        );
      }, this.deps.timeoutMs ?? 15_000);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  async snapshot(id: string, workspace: string | null) {
    await this.connect(id);
    const generation = this.generation;
    const { workspaces } = await this.request<{
      workspaces: RemoteWorkspaceView[];
    }>(REMOTE_METHODS.workspaces, {});
    this.assertConnection(id, generation);
    const { threads } = workspace
      ? await this.request<{ threads: RemoteThreadSummary[] }>(
          REMOTE_METHODS.threads,
          { workspaceId: workspace },
        )
      : { threads: [] };
    this.assertConnection(id, generation);
    this.summaries = threads;
    this.selectedWorkspace = workspace;
    const supportsRooms = this.capabilities.has("rooms");
    let rooms: RemoteRoomSummary[] = [];
    let roomsError: string | null = null;
    let models: RemoteModelView[] = [];
    let modelsError: string | null = null;
    if (workspace && this.capabilities.has("models")) {
      try {
        models = (
          await this.request<{ models: RemoteModelView[] }>(
            REMOTE_METHODS.models,
            {},
          )
        ).models;
      } catch (error) {
        modelsError = String(error);
      }
      this.assertConnection(id, generation);
    }
    if (workspace && supportsRooms) {
      try {
        rooms = (
          await this.request<{ rooms: RemoteRoomSummary[] }>(
            REMOTE_METHODS.rooms,
            { workspaceId: workspace },
          )
        ).rooms;
      } catch (error) {
        roomsError = String(error);
      }
      this.assertConnection(id, generation);
    }
    return {
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.label })),
      threads: mapThreads(threads),
      rooms,
      supportsRooms,
      roomsError,
      models,
      modelsError,
    };
  }
  subscribe(
    host: string,
    workspace: string | null,
    observer: (event: Notification) => void,
  ) {
    this.assertScope(host, workspace);
    this.observer = observer;
    return () => {
      if (this.observer === observer) this.observer = null;
    };
  }
  private assertConnection(id: string, generation = this.generation) {
    if (
      this.bound !== id ||
      generation !== this.generation ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      throw new RemoteRejectedError(
        "wrong_host",
        "The selected device connection changed. Reconnect before continuing.",
      );
  }
  private assertScope(id: string, workspace: string | null) {
    this.assertConnection(id);
    if (this.selectedWorkspace !== workspace)
      throw new RemoteRejectedError(
        "wrong_workspace",
        "The selected workspace connection changed.",
      );
  }
  private notify() {
    if (!this.activeThread) return;
    this.observer?.({
      type: "snapshot",
      threads: mapThreads(this.summaries),
      items: { [this.activeThread]: [...this.items.values()] },
      turns: {
        [this.activeThread]: [...this.turns].map(([id, status]) => ({
          id,
          status,
        })),
      },
    });
  }
  private invalidateRecovery() {
    this.recovered = false;
    this.recoveryGeneration++;
    this.eventBuffer = [];
    this.items.clear();
    this.turns.clear();
    this.watermark = -1;
    this.observer?.({ type: "resync" });
    if (this.recovering) this.restartRecovery = true;
    else void this.recover().catch(() => {});
  }
  private event(e: RemoteEventView) {
    // Validate at ingress, before the recovery barrier can buffer this object.
    // Replay happens later, outside the socket callback's failure guard.
    if (
      !e ||
      typeof e.threadId !== "string" ||
      !e.threadId ||
      typeof e.processEpoch !== "string" ||
      !e.processEpoch ||
      !Number.isSafeInteger(e.watermark) ||
      e.watermark < 0 ||
      !e.event ||
      ![
        "item_completed",
        "turn_started",
        "turn_completed",
        "redacted",
      ].includes(e.event.type)
    )
      throw Error("Invalid remote canonical event");
    if (
      (e.event.type === "turn_started" || e.event.type === "turn_completed") &&
      (typeof e.event.turnId !== "string" || !e.event.turnId)
    )
      throw Error("Invalid remote Turn event");
    if (
      e.event.type === "turn_completed" &&
      !["inProgress", "completed", "failed", "interrupted"].includes(
        e.event.status,
      )
    )
      throw Error("Invalid remote Turn status");
    if (e.event.type === "item_completed") {
      const item = e.event.item;
      if (
        !item ||
        typeof item.id !== "string" ||
        !item.id ||
        item.threadId !== e.threadId ||
        ![
          "user_message",
          "agent_message",
          "turn_started",
          "turn_completed",
          "turn_aborted",
        ].includes(item.type) ||
        (item.text !== undefined && typeof item.text !== "string")
      )
        throw Error("Invalid remote public Item event");
    }
    if (!this.activeThread || e.threadId !== this.activeThread) return;
    if (this.recovering) {
      // The Host has its own bounded barrier. Never treat a partial page set as synced.
      if (this.eventBuffer.length >= 2048) {
        this.invalidateRecovery();
        return;
      }
      this.eventBuffer.push(e);
      return;
    }
    if (
      !this.recovered ||
      e.processEpoch !== this.epoch ||
      e.watermark !== this.watermark + 1
    ) {
      this.invalidateRecovery();
      return;
    }
    this.watermark = e.watermark;
    if (e.event.type === "item_completed")
      this.items.set(e.event.item.id, mapItem(e.event.item));
    if (e.event.type === "turn_started")
      this.turns.set(e.event.turnId, "inProgress");
    if (e.event.type === "turn_completed")
      this.turns.set(e.event.turnId, e.event.status);
    const current = this.summaries.find((t) => t.threadId === e.threadId);
    if (current && e.event.type === "turn_started") current.status = "active";
    if (current && e.event.type === "turn_completed") current.status = "idle";
    this.notify();
  }
  private async recover() {
    if (!this.activeWorkspace || !this.activeThread) return;
    if (this.recovering) {
      this.restartRecovery = true;
      return;
    }
    this.recovering = true;
    this.recovered = false;
    this.restartRecovery = false;
    const generation = ++this.recoveryGeneration;
    const connectionGeneration = this.generation;
    const workspaceId = this.activeWorkspace,
      threadId = this.activeThread;
    this.eventBuffer = [];
    const items = new Map<string, ReturnType<typeof mapItem>>();
    const turns = new Map<string, string>();
    let fragment: { id: string; text: string } | null = null;
    const append = (entry: RemoteRecoveryEntry) => {
      if (entry.kind === "item") {
        if (fragment) throw Error("Incomplete Host text fragment");
        items.set(entry.item.id, mapItem(entry.item));
        if (entry.turn) turns.set(entry.turn.id, entry.turn.status);
        return;
      }
      if (fragment && fragment.id !== entry.item.id)
        throw Error("Fragment changed item");
      if (entry.offset !== (fragment?.text.length ?? 0))
        throw Error("Non-contiguous Host text fragment");
      fragment = {
        id: entry.item.id,
        text: (fragment?.text ?? "") + entry.text,
      };
      if (entry.complete) {
        items.set(
          entry.item.id,
          mapItem({ ...entry.item, text: fragment.text }),
        );
        fragment = null;
      }
    };
    try {
      let page = await this.request<RemoteRecoveryPage>(REMOTE_METHODS.resume, {
        workspaceId,
        threadId,
      });
      const epoch = page.processEpoch,
        watermark = page.watermark;
      let previousCursor: string | null = null;
      for (let count = 0; ; count++) {
        if (
          generation !== this.recoveryGeneration ||
          this.activeWorkspace !== workspaceId ||
          this.activeThread !== threadId
        )
          return;
        if (
          page.threadId !== threadId ||
          page.thread.id !== threadId ||
          page.processEpoch !== epoch ||
          page.watermark !== watermark ||
          !Array.isArray(page.entries)
        )
          throw Error("Host recovery boundary changed");
        for (const entry of page.entries) append(entry);
        if (page.nextCursor === null) break;
        if (
          typeof page.nextCursor !== "string" ||
          !page.nextCursor ||
          page.nextCursor === previousCursor ||
          count > 10000
        )
          throw Error("Invalid Host recovery cursor");
        previousCursor = page.nextCursor;
        page = await this.request<RemoteRecoveryPage>(
          REMOTE_METHODS.resumePage,
          { cursor: page.nextCursor },
        );
      }
      if (fragment)
        throw Error("Incomplete Host text fragment at terminal page");
      if (generation !== this.recoveryGeneration) return;
      this.epoch = epoch;
      this.watermark = watermark;
      this.items = items;
      this.turns = turns;
      this.recovered = true;
      this.staleCursorRetries = 0;
      this.notify();
    } catch (error) {
      if (
        connectionGeneration !== this.generation ||
        generation !== this.recoveryGeneration
      )
        throw error;
      if (
        error instanceof RemoteRejectedError &&
        (error.code === "stale_cursor" || error.code === "resync_required") &&
        generation === this.recoveryGeneration &&
        this.staleCursorRetries < 1
      ) {
        this.staleCursorRetries++;
        this.invalidateRecovery();
      } else {
        this.recovered = false;
        this.observer?.({ type: "offline" });
      }
      throw error;
    } finally {
      // A rejected old page may settle after a different Host's new recovery.
      // It must never clear the new Host's busy state or publish to its observer.
      if (connectionGeneration === this.generation) {
        this.recovering = false;
        if (this.restartRecovery && this.activeThread && this.activeWorkspace)
          void this.recover().catch(() => {});
        else if (this.recovered) {
          const pending = this.eventBuffer;
          this.eventBuffer = [];
          for (const event of pending) {
            if (
              event.watermark <= this.watermark &&
              event.processEpoch === this.epoch
            )
              continue;
            this.event(event);
          }
        }
      }
    }
  }
  async read(host: string, workspace: string, id: string) {
    this.assertScope(host, workspace);
    const generation = this.generation;
    this.recoveryGeneration++;
    this.staleCursorRetries = 0;
    this.activeWorkspace = workspace;
    this.activeThread = id;
    this.items.clear();
    this.turns.clear();
    this.watermark = -1;
    this.recovered = false;
    await this.recover();
    this.assertConnection(host, generation);
    if (!this.recovered)
      throw Error("Thread recovery incomplete; do not send commands");
    return [...this.items.values()];
  }
  async command(
    host: string,
    workspace: string,
    kind: string,
    payload: {
      threadId?: string;
      text?: string;
      model?: string;
      effort?: string;
    },
  ) {
    if (!this.socket || !this.bound)
      return {
        accepted: false,
        error: "Open a Thread and verify its current Turn first.",
      };
    this.assertScope(host, workspace);
    if (kind === "create") {
      const thread = await this.request<RemoteThreadView>(
        REMOTE_METHODS.create,
        {
          workspaceId: workspace,
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.effort ? { effort: payload.effort } : {}),
        },
      );
      return { accepted: !!thread.id, threadId: thread.id };
    }
    if (
      !this.recovered ||
      !payload.threadId ||
      this.activeThread !== payload.threadId
    )
      return {
        accepted: false,
        error: "Open a Thread and verify its current Turn first.",
      };
    if (kind === "send") {
      if (!payload.text?.trim())
        return { accepted: false, error: "Empty message" };
      const result = await this.request<{ turnId?: string; queued?: boolean }>(
        REMOTE_METHODS.send,
        {
          workspaceId: workspace,
          threadId: payload.threadId,
          text: payload.text,
          clientId: this.deps.uuid(),
        },
      );
      return {
        accepted: !!result.turnId || result.queued === true,
        ...(result.turnId ? { turnId: result.turnId } : {}),
        ...(result.queued ? { queued: true } : {}),
      };
    }
    if (kind === "stop") {
      const current = [...this.turns]
        .filter(([, status]) => status === "inProgress")
        .at(-1)?.[0];
      if (!current)
        return {
          accepted: false,
          error: "No observed active Turn. Refresh before stopping.",
        };
      await this.request(REMOTE_METHODS.interrupt, {
        workspaceId: workspace,
        threadId: payload.threadId,
        expectedTurnId: current,
      });
      return { accepted: true, turnId: current };
    }
    return { accepted: false, error: "Unsupported command" };
  }
  clearThread() {
    this.recoveryGeneration++;
    this.activeThread = null;
    this.activeWorkspace = null;
    this.recovered = false;
    this.restartRecovery = false;
    this.items.clear();
    this.turns.clear();
    this.eventBuffer = [];
  }
  async readRoom(
    host: string,
    workspace: string,
    roomId: string,
  ): Promise<RemoteRoomView> {
    this.assertScope(host, workspace);
    const generation = this.generation;
    const key = JSON.stringify([workspace, roomId]);
    const identity = (this.roomReads.get(key) ?? 0) + 1;
    this.roomReads.set(key, identity);
    if (!this.capabilities.has("rooms"))
      throw new RemoteRejectedError(
        "operation_forbidden",
        "This Host does not expose Rooms.",
      );
    try {
      const view = await this.request<RemoteRoomView>(
        REMOTE_METHODS.roomsRead,
        { workspaceId: workspace, roomId },
      );
      this.assertConnection(host, generation);
      if (this.roomReads.get(key) !== identity)
        throw new RemoteRejectedError(
          "invalid_request",
          "A newer Room read replaced this view.",
        );
      if (view.room.id !== roomId)
        throw Error("Host returned the wrong Room identity.");
      if (
        typeof view.room.operationEpoch !== "string" ||
        !view.room.operationEpoch
      )
        throw Error(
          "Host Room operation epoch missing; refresh before posting.",
        );
      // A poll may overlap a post from the last complete view. Keep that epoch
      // until the newer view completes; the Host rejects an expired epoch.
      this.roomEpochs.set(key, view.room.operationEpoch);
      return view;
    } catch (error) {
      if (
        generation === this.generation &&
        this.roomReads.get(key) === identity
      )
        this.roomEpochs.delete(key);
      throw error;
    }
  }
  async postRoom(
    host: string,
    workspace: string,
    roomId: string,
    text: string,
  ): Promise<RemoteRoomPostResult & { clientId: string }> {
    this.assertScope(host, workspace);
    if (!this.capabilities.has("rooms"))
      throw new RemoteRejectedError(
        "operation_forbidden",
        "This Host does not expose Rooms.",
      );
    if (!text.trim())
      throw new RemoteRejectedError("invalid_request", "Empty Room message.");
    const epoch = this.roomEpochs.get(JSON.stringify([workspace, roomId]));
    if (!epoch)
      throw new RemoteRejectedError(
        "invalid_request",
        "Read the current Room before posting.",
      );
    // Retain this exact operation identity on receipt/error. No mutation is replayed.
    const clientId = `${epoch}:${this.deps.uuid()}`;
    try {
      const result = await this.request<RemoteRoomPostResult>(
        REMOTE_METHODS.roomsPost,
        { workspaceId: workspace, roomId, text, clientId },
      );
      return { ...result, clientId };
    } catch (error) {
      if (error instanceof Error) Object.assign(error, { clientId });
      throw error;
    }
  }
}
