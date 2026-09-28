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
      status: host ? "connecting" : "unpaired",
      command: null,
      lastRequest: null,
      error: null,
    });
    return generation;
  }
  async function refresh(epoch, h, w) {
    try {
      const result = await transport.snapshot(h, w);
      if (!current(epoch, h, w)) return;
      emit({
        workspaces: result.workspaces,
        threads: result.threads,
        status: "connected",
        error: null,
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
      if (current(epoch, h, w)) {
        ++generation;
        ++readIdentity;
        emit({
          status: "offline",
          items: [],
          turns: [],
          threads: [],
          lastRequest: null,
          command: state.command === "uncertain" ? "uncertain" : null,
          error: String(e),
        });
      }
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
        displayedThread = state.thread;
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
      const visible = () =>
        current(epoch, h, w) &&
        readIdentity === identity &&
        state.thread === displayedThread &&
        operations.get(k)?.op === op;
      try {
        const result = await transport.command(h, w, kind, payload);
        if (operations.get(k)?.op !== op) return result;
        record.status = result.accepted ? "accepted" : null;
        if (visible())
          emit({
            command: record.status,
            lastRequest:
              result.accepted &&
              result.turnId &&
              (kind === "send" || kind === "stop")
                ? { kind, turnId: result.turnId ?? null }
                : null,
            error: result.accepted
              ? null
              : (result.error ?? "Host rejected command."),
          });
        if (result.accepted && visible()) await refresh(epoch, h, w);
        return result;
      } catch (e) {
        if (operations.get(k)?.op !== op) return;
        record.status = e?.confirmedRejection === true ? null : "uncertain";
        if (visible())
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
