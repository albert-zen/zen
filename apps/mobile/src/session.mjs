// Local navigation state only. The Host, never this projection, owns threads and turns.
export function createSession(transport, publish) {
  let generation = 0;
  let unsubscribe = () => {};
  let host = null;
  let workspace = null;
  let state = {
    hosts: [],
    host: null,
    workspace: null,
    workspaces: [],
    threads: [],
    items: [],
    thread: null,
    status: "unpaired",
    error: null,
    command: null,
  };
  const emit = (patch) => {
    state = { ...state, ...patch };
    publish({ ...state });
  };
  const current = (epoch, h, w) =>
    epoch === generation && host === h && workspace === w;
  function reset(nextHost, nextWorkspace) {
    ++generation;
    unsubscribe();
    unsubscribe = () => {};
    transport.disconnect?.();
    host = nextHost;
    workspace = nextWorkspace;
    emit({
      host,
      workspace,
      workspaces: [],
      threads: [],
      items: [],
      thread: null,
      status: host ? "connecting" : "unpaired",
      command: null,
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
        if (event.type === "offline")
          emit({
            status: "offline",
            command: null,
            error:
              "Disconnected. Unconfirmed commands may have been received; check Host before retrying.",
          });
        if (event.type === "snapshot")
          emit({
            threads: event.threads,
            status: "connected",
            error: state.command === "uncertain" ? state.error : null,
            items: state.thread ? (event.items[state.thread] ?? []) : [],
          });
      });
    } catch (e) {
      if (current(epoch, h, w)) emit({ status: "offline", error: String(e) });
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
      emit({ thread: id, items: [] });
      const epoch = generation,
        h = host,
        w = workspace;
      if (!h || !w) return;
      transport
        .read(h, w, id)
        .then((items) => {
          if (current(epoch, h, w) && state.thread === id) emit({ items });
        })
        .catch((e) => {
          if (current(epoch, h, w)) emit({ error: String(e) });
        });
    },
    async command(kind, payload) {
      if (state.command === "pending") return;
      if (!host || !workspace || state.status !== "connected") {
        emit({ error: "Not connected to a selected Host workspace." });
        return;
      }
      const epoch = generation,
        h = host,
        w = workspace;
      emit({ command: "pending", error: null });
      try {
        const result = await transport.command(h, w, kind, payload);
        if (!current(epoch, h, w)) return;
        emit({
          command: result.accepted ? "accepted" : null,
          error: result.accepted
            ? null
            : (result.error ?? "Host rejected command."),
        });
        if (result.accepted) await refresh(epoch, h, w);
      } catch (e) {
        if (current(epoch, h, w))
          emit({
            command: "uncertain",
            error: `Delivery unconfirmed: ${String(e)}. Do not retry without checking Host.`,
          });
      }
    },
    dispose() {
      reset(null, null);
    },
  };
}
