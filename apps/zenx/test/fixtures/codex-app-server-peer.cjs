#!/usr/bin/env node
// Offline Codex App Server protocol peer for transport and Electron GUI tests.

const readline = require("node:readline");
const fs = require("node:fs");
let initialized = false;
let turnCounter = 0;
let activeTurn = null;
let turns = [];
let model = "test-model";
const scenario = process.env.PEER_SCENARIO ?? "gui";
const log = (message) => {
  if (process.env.PEER_LOG)
    fs.appendFileSync(process.env.PEER_LOG, JSON.stringify(message) + "\n");
};
const wire = (message) => {
  const line = JSON.stringify(message) + "\n";
  if (scenario === "split-wire") {
    const bytes = Buffer.from(line);
    // Deliberately split inside UTF-8, as well as between protocol records.
    const split = bytes.indexOf(Buffer.from("é")) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 2);
  } else process.stdout.write(line);
};
const notify = (method, params) => wire({ method, params });
const thread = (includeTurns = false) => ({
  id: "native-thread",
  sessionId: "native-thread",
  cwd: "/workspace/test",
  model,
  modelProvider: "openai",
  createdAt: 1,
  updatedAt: 2,
  preview: "Native history",
  name: "Native",
  historyMode:
    scenario === "paginated" || scenario === "repeated-history-cursor"
      ? "paginated"
      : "legacy",
  status: { type: activeTurn ? "active" : "idle" },
  turns: includeTurns ? turns : [],
});
const turn = (id, status = "inProgress", items = []) => ({
  id,
  status,
  items,
  error: null,
});
// Optional native mock storage exists only in this test peer. The product keeps
// its locator bindings; restoring history always requires this native process.
const stateFile = process.env.PEER_STATE_FILE;
const guiMode = scenario === "gui" || Boolean(stateFile);
const nativeSessions = new Map();
const guiApprovals = new Map();
const persistNative = () => {
  if (!stateFile) return;
  const path = require("node:path");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(
    temporary,
    JSON.stringify({ sessions: [...nativeSessions.values()] }),
    { mode: 0o600 },
  );
  fs.renameSync(temporary, stateFile);
};
if (stateFile && fs.existsSync(stateFile)) {
  const restored = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  for (const session of restored.sessions) {
    // A process restart cancels mock native execution and never revives approvals.
    for (const entry of session.turns) {
      if (entry.status === "inProgress") entry.status = "interrupted";
    }
    session.activeTurn = null;
    nativeSessions.set(session.id, session);
  }
  persistNative();
}
const guiThread = (session, includeTurns = false) => ({
  id: session.id,
  sessionId: session.id,
  cwd: session.cwd,
  model: session.model,
  modelProvider: "openai",
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  preview:
    session.turns[0]?.items.find((item) => item.type === "userMessage")
      ?.content[0]?.text ?? "Native history",
  name: "Native",
  historyMode: "legacy",
  status: { type: session.activeTurn ? "active" : "idle" },
  turns: includeTurns ? session.turns : [],
});
const finishGuiTurn = (session, current, status, output) => {
  if (session.activeTurn !== current.id) return;
  if (output !== undefined) {
    const item = {
      type: "agentMessage",
      id: `${current.id}:message`,
      text: output,
      phase: "final_answer",
    };
    current.items.push(item);
    notify("item/completed", {
      threadId: session.id,
      turnId: current.id,
      item,
    });
  }
  current.status = status;
  session.activeTurn = null;
  session.updatedAt = Date.now() / 1000;
  for (const [id, approval] of guiApprovals) {
    if (approval.session === session && approval.current === current) {
      guiApprovals.delete(id);
      notify("serverRequest/resolved", { threadId: session.id, requestId: id });
    }
  }
  persistNative();
  notify("turn/completed", { threadId: session.id, turn: current });
};
const handleGui = (request, respond, fail) => {
  if (!request.method) {
    const approval = guiApprovals.get(request.id);
    if (approval)
      finishGuiTurn(
        approval.session,
        approval.current,
        "completed",
        request.result?.decision ?? "declined",
      );
    return;
  }
  if (request.method === "thread/start") {
    const id = `native-${require("node:crypto").randomUUID()}`;
    const session = {
      id,
      cwd: request.params.cwd,
      model: request.params.model ?? "test-model",
      permissionMode: request.params.sandbox,
      createdAt: Date.now() / 1000,
      updatedAt: Date.now() / 1000,
      turns: [],
      activeTurn: null,
      turnCounter: 0,
    };
    nativeSessions.set(id, session);
    persistNative();
    respond({ thread: guiThread(session), model: session.model });
    return;
  }
  if (request.method === "thread/list") {
    respond({
      data: [...nativeSessions.values()].map((session) => guiThread(session)),
      nextCursor: null,
    });
    return;
  }
  const session = nativeSessions.get(request.params?.threadId);
  if (!session) {
    fail("Native session not found");
    return;
  }
  if (request.method === "thread/resume") {
    respond({
      thread: guiThread(session, !request.params.excludeTurns),
      model: session.model,
    });
    return;
  }
  if (request.method === "thread/read") {
    respond({
      thread: guiThread(session, request.params.includeTurns),
      model: session.model,
    });
    return;
  }
  if (request.method === "turn/start") {
    if (session.activeTurn) {
      fail("Native session already has an active turn");
      return;
    }
    session.model = request.params.model ?? session.model;
    const id = `${session.id}:turn-${++session.turnCounter}`;
    const current = turn(id, "inProgress", [
      { type: "userMessage", id: `${id}:input`, content: request.params.input },
    ]);
    session.activeTurn = id;
    session.turns.push(current);
    persistNative();
    notify("turn/started", { threadId: session.id, turn: current });
    respond({ turn: current });
    if (scenario === "approval" || scenario === "file-approval") {
      const requestId = `approval-${require("node:crypto").randomUUID()}`;
      guiApprovals.set(requestId, { session, current });
      wire({
        id: requestId,
        method:
          scenario === "file-approval"
            ? "item/fileChange/requestApproval"
            : "item/commandExecution/requestApproval",
        params: {
          threadId: session.id,
          turnId: id,
          itemId: `${id}:cmd`,
          command: "echo safe",
          reason: "Explicit permission needed",
          cwd: session.cwd,
        },
      });
    } else {
      const params = {
        threadId: session.id,
        turnId: id,
        itemId: `${id}:message`,
      };
      notify("item/started", {
        threadId: session.id,
        turnId: id,
        item: { type: "agentMessage", id: params.itemId, text: "" },
      });
      notify("item/agentMessage/delta", { ...params, delta: "Hello " });
      notify("item/agentMessage/delta", { ...params, delta: "world" });
      const configuredDelay = Number(process.env.PEER_GUI_TURN_DELAY_MS ?? 150);
      const delay = Number.isFinite(configuredDelay)
        ? Math.max(0, Math.min(configuredDelay, 60000))
        : 150;
      setTimeout(
        () => finishGuiTurn(session, current, "completed", "Hello world"),
        delay,
      );
    }
    return;
  }
  if (request.method === "turn/interrupt") {
    const current = session.turns.find(
      (entry) => entry.id === request.params.turnId,
    );
    if (!current || current.id !== session.activeTurn) {
      fail("Native turn is not active");
      return;
    }
    respond({});
    finishGuiTurn(session, current, "interrupted");
    return;
  }
  fail("Unsupported GUI native request " + request.method);
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  log(request);
  if (request.method === "initialized") {
    initialized = true;
    return;
  }
  if (!request.method) {
    if (guiMode) {
      handleGui(request);
      return;
    }
    if (scenario === "approval" || scenario === "file-approval") {
      turns = [
        turn(activeTurn, "completed", [
          {
            type: "agentMessage",
            id: "message",
            text: request.result?.decision,
            phase: "final_answer",
          },
        ]),
      ];
      notify("turn/completed", { threadId: "native-thread", turn: turns[0] });
      activeTurn = null;
    }
    return;
  }
  const respond = (result) => wire({ id: request.id, result });
  const fail = (message) =>
    wire({ id: request.id, error: { code: -32000, message } });
  if (request.method === "initialize") {
    if (scenario === "bad-wire") {
      process.stdout.write("not json\n");
      return;
    }
    if (scenario === "exit-on-initialize") {
      process.exit(7);
    }
    if (scenario === "init-error") {
      fail("Initialization refused");
      return;
    }
    if (scenario === "init-timeout") return;
    respond({
      userAgent: "fake-codex/0.159.2",
      codexHome: "/fake",
      platformFamily: "unix",
      platformOs: "linux",
    });
    return;
  }
  if (!initialized) {
    fail("Not initialized");
    return;
  }
  if (request.method === "model/list") {
    if (scenario === "timeout") return;
    if (scenario === "exit-on-models") process.exit(9);
    if (scenario === "model-error") {
      fail("Catalog unavailable");
      return;
    }
    const cursor = request.params.cursor;
    respond({
      data: [
        {
          id: cursor ? "model-2" : "test-model",
          model: cursor ? "model-2" : "test-model",
          displayName: "Test modèle",
          description: "Offline",
          supportedReasoningEfforts: [
            { reasoningEffort: "high", description: "High" },
          ],
          defaultReasoningEffort: "high",
          inputModalities: ["text"],
          isDefault: !cursor,
        },
      ],
      nextCursor:
        scenario === "repeated-cursor"
          ? "same"
          : scenario === "model-pages" && !cursor
            ? "page-2"
            : null,
    });
    return;
  }
  if (guiMode) {
    handleGui(request, respond, fail);
    return;
  }
  if (request.method === "thread/start" || request.method === "thread/resume") {
    if (request.method === "thread/start")
      model = request.params.model || model;
    respond({ thread: thread(), model });
    return;
  }
  if (request.method === "thread/read") {
    if (scenario === "native-terminal-wins" && request.params.includeTurns) {
      turns = [
        turn("turn-1", "completed", [
          {
            type: "agentMessage",
            id: "message",
            text: "Native final",
            phase: "final_answer",
          },
        ]),
      ];
      activeTurn = null;
    }
    respond({ thread: thread(request.params.includeTurns) });
    return;
  }
  if (request.method === "thread/turns/list") {
    if (scenario === "repeated-history-cursor") {
      respond({ data: [], nextCursor: "same" });
      return;
    }
    respond({
      data: [
        turn(request.params.cursor ? "history-2" : "history-1", "completed", [
          {
            type: "agentMessage",
            id: request.params.cursor ? "m2" : "m1",
            text: request.params.cursor ? "second" : "first",
            phase: "final_answer",
          },
        ]),
      ],
      nextCursor: request.params.cursor ? null : "page-2",
    });
    return;
  }
  if (request.method === "turn/start") {
    if (scenario === "send-error") {
      fail("Turn denied");
      return;
    }
    activeTurn = "turn-" + ++turnCounter;
    model = request.params.model || model;
    const started = turn(activeTurn);
    notify("turn/started", { threadId: "native-thread", turn: started });
    if (scenario === "send-before-receipt") {
      notify("item/started", {
        threadId: "native-thread",
        turnId: activeTurn,
        item: { type: "agentMessage", id: "message", text: "" },
      });
      notify("item/agentMessage/delta", {
        threadId: "native-thread",
        turnId: activeTurn,
        itemId: "message",
        delta: "Live before receipt",
      });
      turns = [
        turn(activeTurn, "completed", [
          {
            type: "agentMessage",
            id: "message",
            text: "Complete",
            phase: "final_answer",
          },
        ]),
      ];
      notify("turn/completed", { threadId: "native-thread", turn: turns[0] });
      activeTurn = null;
      respond({ turn: started });
      return;
    }
    respond({ turn: started });
    if (
      scenario === "approval" ||
      scenario === "file-approval" ||
      scenario === "resolved-approval"
    ) {
      wire({
        id: scenario === "file-approval" ? 42 : "wire-approval",
        method:
          scenario === "file-approval"
            ? "item/fileChange/requestApproval"
            : "item/commandExecution/requestApproval",
        params: {
          threadId: "native-thread",
          turnId: activeTurn,
          itemId: "cmd",
          command: "echo safe",
          reason: "Explicit permission needed",
          cwd: "/workspace/test",
          grantRoot: "/restricted",
        },
      });
      if (scenario === "resolved-approval")
        notify("serverRequest/resolved", {
          threadId: "native-thread",
          requestId: "wire-approval",
        });
    } else if (scenario === "unknown-request") {
      wire({
        id: "unknown",
        method: "item/tool/requestUserInput",
        params: { threadId: "native-thread", turnId: activeTurn },
      });
    } else if (
      scenario === "stream" ||
      scenario === "tools" ||
      scenario === "native-terminal-wins" ||
      scenario === "gui"
    ) {
      const params = { threadId: "native-thread", turnId: activeTurn };
      notify("item/started", {
        ...params,
        item: { type: "agentMessage", id: "message", text: "" },
      });
      notify("item/agentMessage/delta", {
        ...params,
        itemId: "message",
        delta: "Hello ",
      });
      notify("item/agentMessage/delta", {
        ...params,
        itemId: "message",
        delta: "world",
      });
      notify("item/reasoning/summaryTextDelta", {
        ...params,
        itemId: "reason",
        summaryIndex: 1,
        delta: "Visible reasoning",
      });
      if (scenario === "tools") {
        notify("item/started", {
          ...params,
          item: {
            type: "commandExecution",
            id: "cmd",
            command: "echo safe",
            cwd: "/workspace/test",
            status: "inProgress",
          },
        });
        notify("item/commandExecution/outputDelta", {
          ...params,
          itemId: "cmd",
          delta: "safe\n",
        });
        notify("item/completed", {
          ...params,
          item: {
            type: "commandExecution",
            id: "cmd",
            command: "echo safe",
            status: "completed",
            aggregatedOutput: "safe\n",
            exitCode: 0,
          },
        });
        notify("item/completed", {
          ...params,
          item: {
            type: "fileChange",
            id: "patch",
            status: "completed",
            changes: [{ path: "a.txt", diff: "+a" }],
          },
        });
        notify("item/completed", {
          ...params,
          item: {
            type: "mcpToolCall",
            id: "mcp",
            server: "test",
            tool: "read",
            status: "completed",
            arguments: { path: "a.txt" },
            result: { text: "read" },
          },
        });
      }
    }
    if (scenario === "gui") {
      const turnId = activeTurn;
      setTimeout(() => {
        if (activeTurn !== turnId) return;
        turns.push(
          turn(turnId, "completed", [
            {
              type: "userMessage",
              id: "input-" + turnId,
              content: request.params.input,
            },
            {
              type: "agentMessage",
              id: "message",
              text: "Hello world",
              phase: "final_answer",
            },
          ]),
        );
        notify("item/completed", {
          threadId: "native-thread",
          turnId,
          item: turns.at(-1).items.at(-1),
        });
        activeTurn = null;
        notify("turn/completed", {
          threadId: "native-thread",
          turn: turns.at(-1),
        });
      }, 150);
    }
    return;
  }
  if (request.method === "turn/interrupt") {
    turns = [turn(activeTurn, "interrupted")];
    activeTurn = null;
    respond({});
    notify("turn/completed", { threadId: "native-thread", turn: turns[0] });
    return;
  }
  fail("Unsupported request " + request.method);
});
if (scenario === "ignore-shutdown") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
