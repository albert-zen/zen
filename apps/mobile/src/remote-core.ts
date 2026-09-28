import {
  REMOTE_HOST_VERSION,
  REMOTE_METHODS,
  type RemoteEventView,
  type RemoteItemView,
  type RemotePairResult,
  type RemoteRecoveryEntry,
  type RemoteRecoveryPage,
  type RemoteThreadSummary,
  type RemoteThreadView,
  type RemoteWorkspaceView,
} from "../../../src/protocol/native/remote-wire";

type Host = { id: string; endpoint: string; name: string };
type Credential = {
  hostId: string;
  endpoint: string;
  deviceId: string;
  token: string;
};
type Notification =
  | { type: "offline" }
  | {
      type: "snapshot";
      threads: { id: string; title: string; status: string }[];
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
  status: item.type.startsWith("turn_") ? item.type.slice(5) : "completed",
});
const mapThreads = (threads: RemoteThreadSummary[]) =>
  threads.map((t) => ({
    id: t.threadId,
    title: t.name ?? t.threadId,
    status: t.status,
  }));

// Android uses OS TLS verification. No skipTLSverify and no plaintext fallback.
export type RemoteDependencies = {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  uuid(): string;
  fetch: typeof fetch;
  openSocket(url: string, headers: Record<string, string>): WebSocket;
};
export class RemoteHostTransport {
  private socket: WebSocket | null = null;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
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
  constructor(
    private readonly hosts: () => Host[],
    private readonly deps: RemoteDependencies,
  ) {}
  private host(id: string) {
    const host = this.hosts().find((h) => h.id === id);
    if (!host) throw Error("Unknown host");
    if (!/^https:\/\/[^\s/]+(?::\d+)?\/?$/u.test(host.endpoint))
      throw Error("HTTPS Host required");
    return host;
  }
  private async credential(id: string): Promise<Credential> {
    const host = this.host(id);
    const saved = await this.deps.getSecret(secureKey(id));
    if (!saved) throw Error("Unpaired Host. Pair using a fresh Host code.");
    const credential = JSON.parse(saved) as Credential;
    if (
      credential.hostId !== id ||
      credential.endpoint !== host.endpoint ||
      !credential.deviceId ||
      !credential.token
    )
      throw Error("Host address/identity changed; re-pair required.");
    return credential;
  }
  async pair(id: string, code: string): Promise<void> {
    const host = this.host(id);
    if (!code.trim()) throw Error("Pair code required");
    this.disconnect();
    const generation = this.generation;
    const deviceId = this.deps.uuid();
    const response = await this.deps.fetch(
      `${host.endpoint.replace(/\/$/u, "")}/pair`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostId: id, deviceId, code: code.trim() }),
      },
    );
    if (!response.ok)
      throw Error(
        `Pairing rejected (${response.status}); check TLS identity and code.`,
      );
    const result = (await response.json()) as RemotePairResult;
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
    await this.deps.setSecret(
      secureKey(id),
      JSON.stringify({
        hostId: id,
        endpoint: host.endpoint,
        deviceId,
        token: result.token,
      } satisfies Credential),
    );
  }
  async forget(id: string) {
    this.disconnect();
    await this.deps.deleteSecret(secureKey(id));
  }
  disconnect() {
    this.generation++;
    this.recovering = false;
    this.recovered = false;
    this.recoveryGeneration++;
    this.eventBuffer = [];
    this.restartRecovery = false;
    this.observer = null;
    this.activeThread = null;
    this.activeWorkspace = null;
    this.epoch = null;
    this.watermark = -1;
    this.items.clear();
    this.turns.clear();
    this.summaries = [];
    const socket = this.socket;
    this.socket = null;
    this.bound = null;
    for (const [, p] of this.pending)
      p.reject(Error("Connection closed; delivery unconfirmed."));
    this.pending.clear();
    socket?.close();
  }
  private async connect(id: string): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN && this.bound === id) return;
    this.disconnect();
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
    });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => {
        reject(
          Error(
            "TLS/Host connection failed. Check trusted certificate, listener and grant.",
          ),
        );
        if (this.socket === socket) this.disconnect();
      };
      socket.onclose = () => {
        if (this.socket === socket) {
          for (const [, p] of this.pending)
            p.reject(Error("Host disconnected; delivery unconfirmed."));
          this.pending.clear();
          this.socket = null;
          this.observer?.({ type: "offline" });
        }
      };
      socket.onmessage = (message) =>
        this.message(socket, String(message.data));
    });
    if (this.socket !== socket || generation !== this.generation)
      throw Error("Connection replaced");
    this.bound = id;
    const hello = await this.request<{
      hostId: string;
      version: number;
      processEpoch: string;
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
  }
  private message(socket: WebSocket, raw: string) {
    if (socket !== this.socket) return;
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      this.disconnect();
      return;
    }
    if (data.method === REMOTE_METHODS.reset) {
      if (data.params?.threadId === this.activeThread)
        this.invalidateRecovery();
      return;
    }
    if (data.method === REMOTE_METHODS.event) {
      this.event(data.params as RemoteEventView);
      return;
    }
    const pending = this.pending.get(data.id);
    if (!pending) return;
    this.pending.delete(data.id);
    if (data.error)
      pending.reject(
        Error(
          `Host ${String(data.error?.data?.code ?? "error")}: ${String(data.error?.message ?? "rejected")}`,
        ),
      );
    else pending.resolve(data.result);
  }
  private request<T>(method: string, params: object): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(Error("Host offline"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async snapshot(id: string, workspace: string | null) {
    await this.connect(id);
    const { workspaces } = await this.request<{
      workspaces: RemoteWorkspaceView[];
    }>(REMOTE_METHODS.workspaces, {});
    const { threads } = workspace
      ? await this.request<{ threads: RemoteThreadSummary[] }>(
          REMOTE_METHODS.threads,
          { workspaceId: workspace },
        )
      : { threads: [] };
    this.summaries = threads;
    return {
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.label })),
      threads: mapThreads(threads),
    };
  }
  subscribe(
    _host: string,
    workspace: string | null,
    observer: (event: Notification) => void,
  ) {
    this.observer = observer;
    return () => {
      if (this.observer === observer) this.observer = null;
    };
  }
  private notify() {
    if (!this.activeThread) return;
    this.observer?.({
      type: "snapshot",
      threads: mapThreads(this.summaries),
      items: { [this.activeThread]: [...this.items.values()] },
    });
  }
  private invalidateRecovery() {
    this.recovered = false;
    this.recoveryGeneration++;
    this.eventBuffer = [];
    if (this.recovering) this.restartRecovery = true;
    else void this.recover().catch(() => {});
  }
  private event(e: RemoteEventView) {
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
    if (!this.activeWorkspace || !this.activeThread || this.recovering) return;
    this.recovering = true;
    this.recovered = false;
    this.restartRecovery = false;
    const generation = ++this.recoveryGeneration;
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
      this.notify();
    } catch (error) {
      this.recovered = false;
      this.observer?.({ type: "offline" });
      throw error;
    } finally {
      this.recovering = false;
      if (this.restartRecovery && this.activeThread === threadId)
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
  async read(_host: string, workspace: string, id: string) {
    this.recoveryGeneration++;
    this.activeWorkspace = workspace;
    this.activeThread = id;
    this.items.clear();
    this.turns.clear();
    this.watermark = -1;
    this.recovered = false;
    await this.recover();
    if (!this.recovered)
      throw Error("Thread recovery incomplete; do not send commands");
    return [...this.items.values()];
  }
  async command(
    _host: string,
    workspace: string,
    kind: string,
    payload: { threadId?: string; text?: string },
  ) {
    if (kind === "create") {
      const thread = await this.request<RemoteThreadView>(
        REMOTE_METHODS.create,
        { workspaceId: workspace },
      );
      return { accepted: !!thread.id };
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
      const result = await this.request<{ turnId: string }>(
        REMOTE_METHODS.send,
        {
          workspaceId: workspace,
          threadId: payload.threadId,
          text: payload.text,
          clientId: this.deps.uuid(),
        },
      );
      return { accepted: !!result.turnId };
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
      return { accepted: true };
    }
    return { accepted: false, error: "Unsupported command" };
  }
}
