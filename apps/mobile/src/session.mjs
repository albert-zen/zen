// Ephemeral UI projection only. Host owns canonical Items and Turn outcomes.
export function createSession(transport, publish) {
  let generation = 0;
  let readIdentity = 0;
  let operation = 0;
  let unsubscribe = () => {};
  let host = null;
  let workspace = null;
  // Never transfer a possibly dispatched operation's unknown result to a different Thread.
  // This bounded in-process fence is not a second journal or automatic retry queue.
  const operations = new Map();
  const key = (h, w, t) => JSON.stringify([h, w, t]);
  let state = {
    hosts: [],
    host: null,
    workspace: null,
    workspaces: [],
    threads: [],
    items: [],
    turns: [],
    thread: null,
    rooms: [],
    supportsRooms: false,
    roomsError: null,
    room: null,
    roomMessages: [],
    roomLoading: false,
    roomReady: false,
    models: [],
    modelsError: null,
    status: "unpaired",
    error: null,
    command: null,
    lastRequest: null,
  };
  const emit = (patch) => {
    state = { ...state, ...patch };
    publish({ ...state });
  };
  const current = (epoch, h, w) =>
    epoch === generation && host === h && workspace === w;
  const sameRead = (epoch, h, w, t, identity) =>
    current(epoch, h, w) && state.thread === t && readIdentity === identity;
  const visibleOperation = (h, w, t) =>
    operations.get(key(h, w, t))?.status ?? null;
  function reset(nextHost, nextWorkspace) {
    ++generation;
    ++readIdentity;
    unsubscribe();
    unsubscribe = () => {};
    transport.disconnect?.();
    host = nextHost;
    workspace = nextWorkspace;
    for (const [k, value] of operations)
      if (value.status !== "pending" && value.status !== "uncertain")
        operations.delete(k);
    emit({
      host,
      workspace,
      workspaces: [],
      threads: [],
      items: [],
      turns: [],
      thread: null,
      rooms: [],
      supportsRooms: false,
      roomsError: null,
      room: null,
      roomMessages: [],
      roomLoading: false,
      roomReady: false,
      models: [],
      modelsError: null,
      status: host ? "connecting" : "unpaired",
      command: null,
      lastRequest: null,
      error: null,
    });
    return generation;
  }
  async function refresh(epoch, h, w, stillOwned = () => true) {
    try {
      const result = await transport.snapshot(h, w);
      if (!current(epoch, h, w) || !stillOwned()) return;
      const createKey = key(h, w, null),
        create = operations.get(createKey);
      if (w && create?.status === "uncertain" && create.generation < generation)
        operations.delete(createKey);
      emit({
        workspaces: result.workspaces,
        threads: result.threads,
        status: "connected",
        error: null,
        rooms: result.rooms ?? [],
        supportsRooms: result.supportsRooms === true,
        roomsError: result.roomsError ?? null,
        models: result.models ?? [],
        modelsError: result.modelsError ?? null,
      });
      unsubscribe();
      unsubscribe = transport.subscribe(h, w, (event) => {
        if (!current(epoch, h, w)) return;
        if (event.type === "offline" || event.type === "resync") {
          if (event.type === "offline") ++generation; // fence old RPCs/refreshes
          ++readIdentity;
          emit({
            status: "offline",
            items: [],
            turns: [],
            threads: [],
            rooms: [],
            roomMessages: [],
            roomLoading: false,
            roomReady: false,
            command: state.command === "uncertain" ? "uncertain" : null,
            lastRequest: null,
            error:
              event.type === "resync"
                ? "Host invalidated this Thread view. Wait for fresh resume; do not resend uncertain commands."
                : event.revoked
                  ? "Host revoked this device grant. Pair again. Unconfirmed commands require checking Host."
                  : "Disconnected. Reconnect and read Host state; unconfirmed commands may have arrived.",
          });
        }
        if (event.type === "room" && event.roomId === state.room)
          void readRoom();
        if (event.type === "snapshot")
          emit({
            threads: event.threads,
            status: "connected",
            error: state.command === "uncertain" ? state.error : null,
            items: state.thread ? (event.items[state.thread] ?? []) : [],
            turns: state.thread ? (event.turns?.[state.thread] ?? []) : [],
          });
      });
    } catch (e) {
      if (current(epoch, h, w) && stillOwned()) {
        ++generation;
        ++readIdentity;
        emit({
          status: "offline",
          items: [],
          turns: [],
          threads: [],
          rooms: [],
          roomMessages: [],
          roomLoading: false,
          roomReady: false,
          lastRequest: null,
          command: state.command === "uncertain" ? "uncertain" : null,
          error: String(e),
        });
      }
    }
  }
  async function readRoom() {
    const epoch = generation,
      h = host,
      w = workspace,
      room = state.room,
      identity = readIdentity;
    if (
      !h ||
      !w ||
      !room ||
      state.status !== "connected" ||
      !transport.readRoom ||
      state.roomLoading
    )
      return;
    const owned = () =>
      current(epoch, h, w) && readIdentity === identity && state.room === room;
    emit({ roomLoading: true });
    try {
      const view = await transport.readRoom(h, w, room);
      if (!owned()) return;
      const roomKey = key(h, w, ["room", room]);
      const record = operations.get(roomKey);
      if (record?.status === "uncertain" && record.generation < generation)
        operations.delete(roomKey);
      emit({
        roomMessages: view.messages,
        roomLoading: false,
        roomReady: true,
        command: visibleOperation(h, w, ["room", room]),
        error: null,
      });
    } catch (error) {
      if (owned())
        emit({ roomLoading: false, roomReady: false, error: String(error) });
    }
  }
  return {
    get: () => state,
    setHosts(hosts) {
      emit({ hosts });
    },
    selectHost(h) {
      const epoch = reset(h, null);
      if (h) void refresh(epoch, h, null);
    },
    async reconnect() {
      const h = host,
        w = workspace,
        thread = state.thread,
        room = state.room;
      const epoch = reset(h, w);
      if (!h) return;
      await refresh(epoch, h, w);
      if (!current(epoch, h, w) || state.status !== "connected") return;
      if (thread) this.openThread(thread);
      else if (room) this.openRoom(room);
    },
    preparePair() {
      reset(host, null);
      emit({ status: "pairing" });
    },
    pairFailed(error) {
      emit({ status: "offline", error: String(error) });
    },
    selectWorkspace(w) {
      const epoch = reset(host, w);
      if (host) void refresh(epoch, host, w);
    },
    openThread(id) {
      const identity = ++readIdentity;
      const epoch = generation,
        h = host,
        w = workspace;
      emit({
        thread: id,
        room: null,
        roomMessages: [],
        roomLoading: false,
        roomReady: false,
        items: [],
        turns: [],
        lastRequest: null,
        command: visibleOperation(h, w, id),
        error: null,
      });
      if (!h || !w) return;
      if (state.status !== "connected") {
        emit({
          error: "Reconnect and read Host state before opening a Thread.",
        });
        return;
      }
      transport
        .read(h, w, id)
        .then((items) => {
          if (!sameRead(epoch, h, w, id, identity)) return;
          const record = operations.get(key(h, w, id));
          // Only a new connection's completed canonical read can release an unknown fence.
          if (record?.status === "uncertain" && record.generation < generation)
            operations.delete(key(h, w, id));
          emit({ items, command: visibleOperation(h, w, id) });
        })
        .catch((e) => {
          if (sameRead(epoch, h, w, id, identity)) emit({ error: String(e) });
        });
    },
    openRoom(id) {
      ++readIdentity;
      transport.clearThread?.();
      emit({
        room: id,
        thread: null,
        items: [],
        turns: [],
        roomMessages: [],
        roomLoading: false,
        roomReady: false,
        lastRequest: null,
        command: visibleOperation(host, workspace, ["room", id]),
        error: null,
      });
      void readRoom();
    },
    refreshRoom: readRoom,
    async postRoom(text) {
      const epoch = generation,
        h = host,
        w = workspace,
        room = state.room;
      if (
        !h ||
        !w ||
        !room ||
        !state.roomReady ||
        state.status !== "connected" ||
        !transport.postRoom
      ) {
        emit({
          error: "Connect to the selected device and open a Room first.",
        });
        return;
      }
      const k = key(h, w, ["room", room]),
        previous = operations.get(k);
      if (previous?.status === "pending" || previous?.status === "uncertain")
        return;
      if (!previous && operations.size >= 32)
        for (const [oldKey, old] of operations)
          if (old.status !== "pending" && old.status !== "uncertain")
            operations.delete(oldKey);
      if (!previous && operations.size >= 32) {
        emit({
          error:
            "Too many unresolved commands; reconnect and inspect Host state.",
        });
        return;
      }
      const op = ++operation;
      const record = { op, status: "pending", generation: epoch };
      operations.set(k, record);
      emit({ command: "pending", lastRequest: null, error: null });
      const owned = () =>
        current(epoch, h, w) &&
        state.room === room &&
        operations.get(k)?.op === op;
      try {
        const result = await transport.postRoom(h, w, room, text);
        record.clientId = result?.clientId ?? null;
        if (!result?.messageId)
          throw Error("Room post receipt missing; delivery unconfirmed.");
        record.status = "accepted";
        if (owned()) {
          emit({
            command: "accepted",
            lastRequest: {
              kind: "room",
              messageId: result.messageId,
              turnId: result.turnId ?? null,
            },
            error: null,
          });
          void readRoom();
        }
        return { accepted: true, ...result };
      } catch (error) {
        record.clientId = error?.clientId ?? null;
        record.status = error?.confirmedRejection === true ? null : "uncertain";
        if (owned())
          emit({
            command: record.status,
            error:
              record.status === "uncertain"
                ? `Delivery unconfirmed: ${String(error)}. Reconnect and read the Room before posting again.`
                : String(error),
          });
      }
    },
    async command(kind, payload) {
      const t = kind === "create" ? null : (payload.threadId ?? null);
      if (t && t !== state.thread) {
        emit({ error: "Command Thread does not match open Thread." });
        return;
      }
      const h = host,
        w = workspace,
        epoch = generation,
        identity = readIdentity,
        displayedThread = state.thread,
        displayedRoom = state.room;
      const k = key(h, w, t);
      const previous = operations.get(k);
      if (previous?.status === "pending" || previous?.status === "uncertain")
        return;
      if (!h || !w || state.status !== "connected") {
        emit({ error: "Not connected to a selected Host workspace." });
        return;
      }
      if (!previous && operations.size >= 32) {
        for (const [oldKey, old] of operations)
          if (old.status !== "pending" && old.status !== "uncertain")
            operations.delete(oldKey);
      }
      if (!previous && operations.size >= 32) {
        emit({
          error:
            "Too many unresolved commands; reconnect and inspect Host state.",
        });
        return;
      }
      const op = ++operation;
      const record = { op, status: "pending", generation: epoch };
      operations.set(k, record);
      emit({ command: "pending", lastRequest: null, error: null });
      // A settled command still belongs to A after A→B→A; its read/refresh
      // projection belongs only to the view that initiated that command.
      const visibleCommand = () =>
        current(epoch, h, w) &&
        state.thread === displayedThread &&
        state.room === displayedRoom &&
        operations.get(k)?.op === op;
      const sameView = () => visibleCommand() && readIdentity === identity;
      try {
        const result = await transport.command(h, w, kind, payload);
        if (operations.get(k)?.op !== op) return result;
        record.status = result.accepted ? "accepted" : null;
        if (visibleCommand())
          emit({
            command: record.status,
            lastRequest:
              result.accepted &&
              (result.turnId || result.queued) &&
              (kind === "send" || kind === "stop")
                ? {
                    kind,
                    turnId: result.turnId ?? null,
                    ...(result.queued ? { queued: true } : {}),
                  }
                : null,
            error: result.accepted
              ? null
              : (result.error ?? "Host rejected command."),
          });
        // Admission is independent of optional workspace-summary refresh;
        if (
          kind === "create" &&
          result.accepted &&
          result.threadId &&
          sameView() &&
          !state.threads.some((thread) => thread.id === result.threadId)
        )
          emit({
            threads: [
              ...state.threads,
              { id: result.threadId, title: result.threadId, status: "idle" },
            ],
          });
        // a slow snapshot must not hold the unchanged submitted draft hostage.
        if (result.accepted && sameView()) void refresh(epoch, h, w, sameView);
        return result;
      } catch (e) {
        if (operations.get(k)?.op !== op) return;
        record.status = e?.confirmedRejection === true ? null : "uncertain";
        if (visibleCommand())
          emit(
            e?.confirmedRejection === true
              ? { command: null, error: String(e) }
              : {
                  command: "uncertain",
                  error: `Delivery unconfirmed: ${String(e)}. Do not retry without checking Host.`,
                },
          );
      }
    },
    dispose() {
      reset(null, null);
    },
  };
}
