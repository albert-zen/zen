import {
  BrowserAppServerTransportClient,
  WebUiClient
} from "../dist/web-ui-client.js";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3000";
const params = new URLSearchParams(window.location.search);
const initialMode = params.get("mode") === "demo" ? "demo" : "real";
const initialServerUrl =
  params.get("server") ??
  window.localStorage.getItem("zen-app-server-url") ??
  DEFAULT_SERVER_URL;

const els = {
  newThread: document.querySelector("#new-thread"),
  connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"),
  mode: document.querySelector("#runtime-mode"),
  serverUrl: document.querySelector("#server-url"),
  connectionStatus: document.querySelector("#connection-status"),
  composer: document.querySelector("#composer"),
  send: document.querySelector("#send-message"),
  message: document.querySelector("#message"),
  timeline: document.querySelector("#timeline"),
  threadId: document.querySelector("#thread-id"),
  threadStatus: document.querySelector("#thread-status"),
  turnCount: document.querySelector("#turn-count"),
  itemCount: document.querySelector("#item-count")
};

let streamStatus = "disconnected";
let streamError = "";
let controller = createController(initialMode, initialServerUrl);

els.mode.value = initialMode;
els.serverUrl.value = initialServerUrl;
controller.subscribe(render);

els.mode.addEventListener("change", () => {
  const next = new URL(window.location.href);
  next.searchParams.set("mode", els.mode.value);
  if (els.mode.value === "real") {
    next.searchParams.set("server", els.serverUrl.value.trim() || DEFAULT_SERVER_URL);
  } else {
    next.searchParams.delete("server");
  }
  window.location.assign(next.toString());
});

els.serverUrl.addEventListener("change", () => {
  const value = els.serverUrl.value.trim() || DEFAULT_SERVER_URL;
  window.localStorage.setItem("zen-app-server-url", value);
});

els.connect.addEventListener("click", async () => {
  await connect().catch(() => undefined);
});

els.disconnect.addEventListener("click", () => {
  controller.disconnect();
});

els.newThread.addEventListener("click", async () => {
  await controller.startThread().catch(showFailure);
});

els.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = els.message.value.trim();

  if (!input) {
    return;
  }

  els.message.value = "";
  await controller.submitMessage(input).catch(showFailure);
});

window.addEventListener("beforeunload", () => {
  controller.disconnect();
});

await connect().catch(() => undefined);

function createController(mode, serverUrl) {
  streamStatus = "disconnected";
  streamError = "";

  if (mode === "demo") {
    return new WebUiClient({
      client: createBrowserDemoAppServer(),
      mode: "demo"
    });
  }

  return new WebUiClient({
    mode: "real",
    client: new BrowserAppServerTransportClient({
      baseUrl: serverUrl,
      onSubscriptionStatus(status, error) {
        streamStatus = status;
        streamError = error ? "event stream failed" : "";
        render();
      }
    })
  });
}

async function connect() {
  const mode = els.mode.value === "demo" ? "demo" : "real";
  const serverUrl = els.serverUrl.value.trim() || DEFAULT_SERVER_URL;
  window.localStorage.setItem("zen-app-server-url", serverUrl);

  controller.disconnect();
  controller = createController(mode, serverUrl);
  controller.subscribe(render);
  await controller.connect({
    threadId: params.get("thread") ?? undefined
  });
}

function showFailure(cause) {
  streamStatus = "failed";
  streamError = cause instanceof Error ? cause.message : String(cause);
  render();
}

function render() {
  const { connection, state } = controller.getSnapshot();
  const thread = state.currentThread;
  const statusText = connection.message ?? streamError;

  els.threadId.textContent = thread?.id ?? "not started";
  els.threadStatus.textContent = `status: ${thread?.status ?? "idle"}`;
  els.turnCount.textContent = `turns: ${thread?.turns.length ?? 0}`;
  els.itemCount.textContent = `items: ${state.items.length}`;
  els.connectionStatus.textContent = [
    connection.mode === "demo" ? "Demo mode" : "Real transport",
    `client: ${connection.status}`,
    connection.mode === "real" ? `stream: ${streamStatus}` : undefined,
    statusText
  ]
    .filter(Boolean)
    .join(" | ");

  const connected = connection.status === "connected" || connection.status === "running";
  const running = connection.status === "running";
  els.connect.disabled = connection.status === "connecting" || connected;
  els.disconnect.disabled = connection.status === "disconnected";
  els.newThread.disabled = connection.status !== "connected";
  els.send.disabled = connection.status !== "connected";
  els.message.disabled = connection.status !== "connected";
  els.serverUrl.disabled = connection.mode === "demo" || connected;

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
  outer.className = `row row-${row.type}`;

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
  if (row.type === "tool-call") {
    return row.toolName === "shell"
      ? renderShellCommand(row.input)
      : renderToolBox(row.toolName ?? "tool", row.input);
  }

  if (row.type === "tool-result") {
    return row.toolName === "shell"
      ? renderShellResult(row.content)
      : renderToolBox(row.toolName ?? "tool result", row.content);
  }

  if (row.type === "tool-error") {
    const text = document.createElement("div");
    text.className = "row-text danger";
    text.textContent =
      row.toolName === "shell"
        ? `Shell failed: ${row.message ?? "command failed"}`
        : row.message ?? "tool failed";
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
      controller.resolveApproval(row.approvalId, "approve").catch(showFailure)
    );
    const decline = document.createElement("button");
    decline.type = "button";
    decline.textContent = "Decline";
    decline.addEventListener("click", () =>
      controller.resolveApproval(row.approvalId, "decline").catch(showFailure)
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

function renderShellCommand(input) {
  const box = document.createElement("div");
  box.className = "tool-box shell-box";
  const label = document.createElement("div");
  label.className = "tool-label";
  label.textContent = "Shell command";
  const command = document.createElement("pre");
  command.className = "tool-code";
  command.textContent = readCommand(input);
  box.append(label, command);
  return box;
}

function renderShellResult(content) {
  const result = readShellResult(content);
  const box = document.createElement("div");
  box.className = "tool-box shell-box";
  const label = document.createElement("div");
  label.className = result.exitCode === 0 ? "tool-label" : "tool-label danger";
  label.textContent =
    result.exitCode === undefined ? "Shell result" : `Shell exit ${result.exitCode}`;
  box.append(label);

  if (result.stdout) {
    box.append(renderOutputBlock("stdout", result.stdout));
  }

  if (result.stderr) {
    box.append(renderOutputBlock("stderr", result.stderr, "danger"));
  }

  if (!result.stdout && !result.stderr) {
    box.append(renderOutputBlock("output", stringify(content)));
  }

  return box;
}

function renderOutputBlock(label, value, className = "") {
  const wrapper = document.createElement("div");
  const title = document.createElement("div");
  title.className = `tool-output-label ${className}`.trim();
  title.textContent = label;
  const body = document.createElement("pre");
  body.className = "tool-code";
  body.textContent = value;
  wrapper.append(title, body);
  return wrapper;
}

function renderToolBox(labelText, value) {
  const box = document.createElement("div");
  box.className = "tool-box";
  const label = document.createElement("div");
  label.className = "tool-label";
  label.textContent = labelText;
  const body = document.createElement("pre");
  body.className = "tool-code";
  body.textContent = stringify(value);
  box.append(label, body);
  return box;
}

function readCommand(input) {
  if (typeof input === "object" && input !== null && "command" in input) {
    return stringify(input.command);
  }

  return stringify(input);
}

function readShellResult(content) {
  if (typeof content === "object" && content !== null && !Array.isArray(content)) {
    return {
      exitCode: typeof content.exitCode === "number" ? content.exitCode : undefined,
      stdout: typeof content.stdout === "string" ? content.stdout.trimEnd() : "",
      stderr: typeof content.stderr === "string" ? content.stderr.trimEnd() : ""
    };
  }

  return {
    exitCode: undefined,
    stdout: typeof content === "string" ? content : "",
    stderr: ""
  };
}

function createBrowserDemoAppServer() {
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

      if (request.method === "approval/resolve") {
        resolveApproval(request.params.approvalId, request.params.decision);
        return {
          method: "approval/resolve",
          ok: true,
          result: {
            approvalId: request.params.approvalId,
            decision: request.params.decision
          }
        };
      }

      return {
        method: request.method,
        ok: false,
        error: { code: "UNKNOWN_METHOD", message: `Unknown method ${request.method}` }
      };
    }
  };

  function startThread() {
    thread = { id: `demo-thread-${nextThread++}`, status: "idle", turns: [], items: [] };
    emit({ type: "thread/started", thread: snapshot() });
  }

  async function runTurn(input) {
    if (!thread) {
      startThread();
    }

    const turn = {
      id: `demo-turn-${nextTurn++}`,
      runId: `demo-run-${nextRun++}`,
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

    const lower = String(input).toLowerCase();

    if (lower.includes("shell")) {
      append("assistant.message.completed", turn, {
        content: "Running a demo shell command.",
        toolCalls: [{ id: "demo-shell", name: "shell", input: { command: "echo zen" } }]
      });
      append("model.request.completed", turn, { status: "completed" });
      append("tool.call.started", turn, {
        toolCallId: "demo-shell",
        toolName: "shell",
        input: { command: "echo zen" }
      });
      append("tool.result.completed", turn, {
        toolCallId: "demo-shell",
        toolName: "shell",
        content: { exitCode: 0, stdout: "zen\n", stderr: "" }
      });
      append("assistant.message.completed", turn, {
        content: "The demo shell command completed."
      });
      completeTurn(turn);
      return;
    }

    if (lower.includes("approval")) {
      const approvalId = `demo-approval-${nextItem}`;
      append("assistant.message.completed", turn, {
        content: "I need approval before continuing."
      });
      const approvalItem = append("approval.requested", turn, {
        approvalId,
        toolCallId: "demo-shell",
        reason: "Demo approval request"
      });
      pendingApprovals.set(approvalId, { turn, toolCallId: "demo-shell" });
      emit({
        type: "approval/requested",
        threadId: thread.id,
        turnId: turn.id,
        approvalId,
        item: approvalItem
      });
      return;
    }

    append("assistant.message.completed", turn, {
      content: `Demo response to: ${input}`
    });
    append("model.request.completed", turn, { status: "completed" });
    completeTurn(turn);
  }

  function resolveApproval(approvalId, decision) {
    const pending = pendingApprovals.get(approvalId);
    if (!pending) {
      return;
    }

    pendingApprovals.delete(approvalId);
    append("approval.resolved", pending.turn, {
      approvalId,
      decision
    });
    append("assistant.message.completed", pending.turn, {
      content: `Demo approval ${decision}.`
    });
    completeTurn(pending.turn);
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
      id: `demo-item-${nextItem++}`,
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

function stringify(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  return typeof value === "string" ? value : JSON.stringify(value);
}
