const server = createBrowserFakeAppServer();
let state = createState();

const els = {
  newThread: document.querySelector("#new-thread"),
  composer: document.querySelector("#composer"),
  message: document.querySelector("#message"),
  timeline: document.querySelector("#timeline"),
  threadId: document.querySelector("#thread-id"),
  threadStatus: document.querySelector("#thread-status"),
  turnCount: document.querySelector("#turn-count"),
  itemCount: document.querySelector("#item-count")
};

server.subscribe((notification) => {
  state = applyNotification(state, notification);
  render();
});

els.newThread.addEventListener("click", async () => {
  await server.request({ method: "thread/start" });
});

els.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = els.message.value.trim();

  if (!input) {
    return;
  }

  const thread = state.currentThread?.id
    ? state.currentThread
    : await ensureThread();

  els.message.value = "";
  await server.request({
    method: "turn/start",
    params: {
      threadId: thread.id,
      input
    }
  });
});

await ensureThread();
render();

async function ensureThread() {
  if (state.currentThread) {
    return state.currentThread;
  }

  const response = await server.request({ method: "thread/start" });

  if (!response.ok) {
    throw new Error(response.error.message);
  }

  return response.result.thread;
}

function render() {
  const thread = state.currentThread;
  els.threadId.textContent = thread?.id ?? "not started";
  els.threadStatus.textContent = `status: ${thread?.status ?? "idle"}`;
  els.turnCount.textContent = `turns: ${thread?.turns.length ?? 0}`;
  els.itemCount.textContent = `items: ${state.items.length}`;

  if (state.timelineRows.length === 0) {
    els.timeline.innerHTML = `<div class="empty">No items yet</div>`;
    return;
  }

  els.timeline.replaceChildren(
    ...state.timelineRows.map((row) => renderTimelineRow(row))
  );
  els.timeline.scrollTop = els.timeline.scrollHeight;
}

function renderTimelineRow(row) {
  const outer = document.createElement("article");
  outer.className = "row";

  const kind = document.createElement("div");
  kind.className = "row-kind";
  kind.textContent = row.type.replaceAll("-", " ");

  const body = document.createElement("div");
  body.className = "row-body";
  body.append(renderRowContent(row));

  const meta = document.createElement("div");
  meta.className = "row-meta";
  meta.textContent = `#${row.seq} ${row.itemId}`;
  body.append(meta);

  outer.append(kind, body);
  return outer;
}

function renderRowContent(row) {
  if (row.type === "tool-call" || row.type === "tool-result") {
    const box = document.createElement("div");
    box.className = "tool-box";
    box.textContent = `${row.toolName ?? "tool"} ${stringify(
      row.input ?? row.content ?? ""
    )}`;
    return box;
  }

  if (row.type === "tool-error") {
    const text = document.createElement("div");
    text.className = "row-text danger";
    text.textContent = row.message ?? "tool failed";
    return text;
  }

  if (row.type === "approval-pending") {
    const container = document.createElement("div");
    const text = document.createElement("div");
    text.className = "row-text warn";
    text.textContent = row.reason ?? "Approval requested";

    const actions = document.createElement("div");
    actions.className = "approval";
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "primary";
    approve.textContent = "Approve";
    approve.addEventListener("click", () =>
      server.resolveApproval(row.approvalId, "approve")
    );
    const decline = document.createElement("button");
    decline.type = "button";
    decline.textContent = "Decline";
    decline.addEventListener("click", () =>
      server.resolveApproval(row.approvalId, "decline")
    );

    actions.append(approve, decline);
    container.append(text, actions);
    return container;
  }

  if (row.type === "approval-resolved") {
    const text = document.createElement("div");
    text.className = "row-text";
    text.textContent = `approval ${row.decision ?? "resolved"}`;
    return text;
  }

  const text = document.createElement("div");
  text.className = "row-text";
  text.textContent = stringify(row.content ?? row.event ?? "");
  return text;
}

function createState(snapshot) {
  if (!snapshot) {
    return { currentThread: undefined, items: [], timelineRows: [] };
  }

  return {
    currentThread: {
      id: snapshot.id,
      status: snapshot.status,
      turns: snapshot.turns.map(cloneTurn)
    },
    items: [...snapshot.items].sort(compareItems),
    timelineRows: buildTimeline(snapshot.items)
  };
}

function applyNotification(current, notification) {
  if (notification.type === "thread/started") {
    return createState(notification.thread);
  }

  if (!notification.threadId || current.currentThread?.id !== notification.threadId) {
    return current;
  }

  if (notification.type === "item/appended" || notification.type === "approval/requested") {
    return rebuild(current, [...current.items, notification.item]);
  }

  if (notification.type === "approval/resolved" && notification.item) {
    return rebuild(current, [...current.items, notification.item]);
  }

  if (notification.turn) {
    const turns = [
      ...current.currentThread.turns.filter((turn) => turn.id !== notification.turn.id),
      cloneTurn(notification.turn)
    ];
    return {
      ...current,
      currentThread: {
        id: current.currentThread.id,
        status: turns.some((turn) => turn.status === "inProgress") ? "running" : "idle",
        turns
      }
    };
  }

  return current;
}

function rebuild(current, items) {
  const deduped = new Map(items.map((item) => [item.id, item]));
  const nextItems = [...deduped.values()].sort(compareItems);
  return {
    ...current,
    items: nextItems,
    timelineRows: buildTimeline(nextItems)
  };
}

function buildTimeline(items) {
  const sorted = [...items].sort(compareItems);
  const resolved = new Set(
    sorted
      .filter((item) => approvalEvent(item) === "approval.resolved")
      .map((item) => approvalPayload(item).approvalId)
      .filter(Boolean)
  );

  return sorted.flatMap((item) => {
    const event = approvalEvent(item);
    const payload = approvalPayload(item);

    if (event === "approval.requested" && resolved.has(payload.approvalId)) {
      return [];
    }

    if (event === "approval.requested") {
      return [{
        type: "approval-pending",
        itemId: item.id,
        seq: item.seq,
        turnId: item.turnId,
        approvalId: payload.approvalId,
        toolCallId: payload.toolCallId,
        reason: payload.reason
      }];
    }

    if (event === "approval.resolved") {
      return [{
        type: "approval-resolved",
        itemId: item.id,
        seq: item.seq,
        turnId: item.turnId,
        approvalId: payload.approvalId,
        decision: payload.decision
      }];
    }

    if (item.type === "assistant.message.delta") {
      return [];
    }

    if (item.type === "user.message.completed") {
      return [row("user", item, { content: item.payload.content })];
    }

    if (item.type === "assistant.message.completed") {
      return [row("assistant", item, { content: item.payload.content })];
    }

    if (item.type === "tool.call.started") {
      return [row("tool-call", item, item.payload)];
    }

    if (item.type === "tool.result.completed") {
      return [row("tool-result", item, item.payload)];
    }

    if (item.type === "tool.error") {
      return [row("tool-error", item, item.payload)];
    }

    return [row("trace", item, { event: item.type })];
  });
}

function row(type, item, extra) {
  return { type, itemId: item.id, seq: item.seq, turnId: item.turnId, ...extra };
}

function approvalEvent(item) {
  if (item.type === "approval.requested" || item.type === "approval.resolved") {
    return item.type;
  }

  const type = item.payload?.delta?.type;
  return type === "approval.requested" || type === "approval.resolved"
    ? type
    : undefined;
}

function approvalPayload(item) {
  return item.payload?.delta?.type ? item.payload.delta : item.payload;
}

function createBrowserFakeAppServer() {
  let thread;
  let nextThread = 1;
  let nextRun = 1;
  let nextTurn = 1;
  let nextItem = 1;
  const listeners = new Set();
  const pendingApprovals = new Map();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(request) {
      if (request.method === "thread/start") {
        startThread();
        return { method: "thread/start", ok: true, result: { thread: snapshot() } };
      }

      if (request.method === "thread/read") {
        return { method: "thread/read", ok: true, result: { thread: snapshot() } };
      }

      if (request.method === "turn/start") {
        await runTurn(request.params.input);
        return {
          method: "turn/start",
          ok: true,
          result: { turn: thread.turns.at(-1) }
        };
      }

      return {
        method: request.method,
        ok: false,
        error: { code: "UNKNOWN_METHOD", message: `Unknown method ${request.method}` }
      };
    },
    resolveApproval(approvalId, decision) {
      const pending = pendingApprovals.get(approvalId);
      if (!pending) return;
      pendingApprovals.delete(approvalId);
      append("approval.resolved", pending.turn, {
        approvalId,
        toolCallId: pending.toolCallId,
        decision
      });
      if (decision === "approve") {
        append("tool.result.completed", pending.turn, {
          toolCallId: pending.toolCallId,
          toolName: "shell",
          content: "approved fake command"
        });
        append("assistant.message.completed", pending.turn, {
          content: "The fake command was approved and completed."
        });
      } else {
        append("tool.error", pending.turn, {
          toolCallId: pending.toolCallId,
          toolName: "shell",
          message: "Approval declined"
        });
        append("assistant.message.completed", pending.turn, {
          content: "The requested action was declined."
        });
      }
      completeTurn(pending.turn);
    }
  };

  function startThread() {
    thread = { id: `thread-${nextThread++}`, status: "idle", turns: [], items: [] };
    emit({ type: "thread/started", thread: snapshot() });
  }

  async function runTurn(input) {
    if (!thread) {
      startThread();
    }

    const turn = {
      id: `turn-${nextTurn++}`,
      runId: `run-${nextRun++}`,
      status: "inProgress",
      itemIds: []
    };
    thread.status = "running";
    thread.turns.push(turn);
    emit({ type: "turn/started", threadId: thread.id, turn: cloneTurn(turn) });

    append("run.started", turn, {});
    append("turn.started", turn, {});
    append("user.message.completed", turn, { content: input });
    append("model.request.started", turn, { contextPartCount: thread.items.length });
    append("assistant.message.started", turn, {});

    const lower = String(input).toLowerCase();
    if (lower.includes("approval") || lower.includes("shell")) {
      const toolCallId = `call-${nextItem}`;
      const approvalId = `approval-${nextItem}`;
      append("assistant.message.completed", turn, {
        content: "I need approval before running the fake command.",
        toolCalls: [{ id: toolCallId, name: "shell", input: { command: "echo zen" } }]
      });
      append("model.request.completed", turn, { status: "completed" });
      append("tool.call.started", turn, {
        toolCallId,
        toolName: "shell",
        input: { command: "echo zen" }
      });
      const approvalItem = append("approval.requested", turn, {
        approvalId,
        toolCallId,
        reason: "Run fake shell command?"
      });
      pendingApprovals.set(approvalId, { turn, toolCallId });
      emit({
        type: "approval/requested",
        threadId: thread.id,
        turnId: turn.id,
        approvalId,
        item: approvalItem
      });
      return;
    }

    if (lower.includes("tool")) {
      append("assistant.message.completed", turn, {
        content: "Calling the fake lookup tool.",
        toolCalls: [{ id: "call-lookup", name: "lookup", input: { query: input } }]
      });
      append("model.request.completed", turn, { status: "completed" });
      append("tool.call.started", turn, {
        toolCallId: "call-lookup",
        toolName: "lookup",
        input: { query: input }
      });
      append("tool.result.completed", turn, {
        toolCallId: "call-lookup",
        toolName: "lookup",
        content: "fake lookup result"
      });
      append("assistant.message.completed", turn, {
        content: "The fake lookup returned a result."
      });
      completeTurn(turn);
      return;
    }

    append("assistant.message.completed", turn, {
      content: `Fake response to: ${input}`
    });
    append("model.request.completed", turn, { status: "completed" });
    completeTurn(turn);
  }

  function completeTurn(turn) {
    append("turn.completed", turn, { status: "completed" });
    append("run.completed", turn, { status: "completed" });
    turn.status = "completed";
    thread.status = "idle";
    emit({ type: "turn/completed", threadId: thread.id, turn: cloneTurn(turn) });
  }

  function append(type, turn, payload) {
    const item = {
      id: `item-${nextItem++}`,
      type,
      createdAtMs: Date.now(),
      seq: thread.items.length + 1,
      runId: turn.runId,
      turnId: turn.id,
      payload
    };
    thread.items.push(item);
    turn.itemIds.push(item.id);
    emit({ type: "item/appended", threadId: thread.id, turnId: turn.id, item });
    return item;
  }

  function snapshot() {
    return {
      id: thread.id,
      status: thread.status,
      turns: thread.turns.map(cloneTurn),
      items: thread.items.map((item) => structuredClone(item))
    };
  }

  function emit(notification) {
    listeners.forEach((listener) => listener(notification));
  }
}

function cloneTurn(turn) {
  return {
    ...turn,
    itemIds: [...turn.itemIds]
  };
}

function compareItems(left, right) {
  return left.seq - right.seq || left.createdAtMs - right.createdAtMs;
}

function stringify(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  return typeof value === "string" ? value : JSON.stringify(value);
}
