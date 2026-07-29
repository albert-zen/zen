import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import {
  CodexClient,
  CodexClientError,
  responseResult,
} from "../src/protocol/codex/client.js";
import { CodexConnection } from "../src/protocol/codex/connection.js";
import { serveCodexWebSocket } from "../src/protocol/codex/websocket.js";
import { isRecord, type JsonRpcMessage } from "../src/protocol/codex/wire.js";

function testHost(approvalPolicy: "always" | "never" = "never") {
  return createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: path.join(os.tmpdir(), "unused-zen-test-data"),
    model: "fake",
    approvalPolicy,
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
  });
}

test("enforces the Codex initialize handshake and method boundary", async () => {
  const messages: JsonRpcMessage[] = [];
  const connection = new CodexConnection({
    appServer: testHost(),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    send: (message) => {
      messages.push(message);
    },
  });

  await connection.receive({ id: 1, method: "thread/list", params: {} });
  assert.deepEqual(messages.pop(), {
    id: 1,
    error: { code: -32600, message: "Not initialized" },
  });

  await connection.receive({
    id: 2,
    method: "initialize",
    params: {
      clientInfo: { name: "test", title: "Test", version: "1" },
      capabilities: null,
    },
  });
  const initialized = messages.pop();
  assert(
    initialized !== undefined &&
      "result" in initialized &&
      typeof initialized.result === "object",
  );

  await connection.receive({ id: 3, method: "initialize", params: {} });
  assert.deepEqual(messages.pop(), {
    id: 3,
    error: { code: -32600, message: "Already initialized" },
  });

  await connection.receive({ method: "initialized" });
  await connection.receive({ id: 4, method: "not/a-method", params: {} });
  assert.deepEqual(messages.pop(), {
    id: 4,
    error: { code: -32601, message: "Method not found: not/a-method" },
  });
  connection.close();
});

test("streams the minimal Codex Thread/Turn/Item lifecycle over WebSocket", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost(),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    const notifications: string[] = [];
    const completed = deferred<void>();
    for (const method of [
      "thread/started",
      "turn/started",
      "item/started",
      "item/agentMessage/delta",
      "item/completed",
      "thread/tokenUsage/updated",
      "turn/completed",
    ]) {
      client.onNotification(method, () => {
        notifications.push(method);
        if (method === "turn/completed") {
          completed.resolve();
        }
      });
    }

    await client.initialize({
      name: "test",
      title: "Test",
      version: "0.1.0",
    });
    const start = await client.request("thread/start", {
      cwd: process.cwd(),
      model: "fake",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");
    assert.equal(typeof thread.id, "string");

    const turnStart = await client.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "hello", text_elements: [] }],
    });
    const turn = responseResult<Record<string, unknown>>(turnStart, "turn");
    assert.equal(turn.status, "inProgress");
    await completed.promise;

    assert(notifications.includes("thread/started"));
    assert(notifications.includes("turn/started"));
    assert(notifications.includes("item/agentMessage/delta"));
    assert(!notifications.includes("thread/tokenUsage/updated"));
    assert.equal(notifications.at(-1), "turn/completed");

    const read = await client.request("thread/read", {
      threadId: thread.id,
      includeTurns: true,
    });
    const readThread = responseResult<Record<string, unknown>>(read, "thread");
    assert(Array.isArray(readThread.turns));
    assert.equal(
      (readThread.turns[0] as { status: string }).status,
      "completed",
    );
  } finally {
    client.close();
    await server.close();
  }
});

test("routes transient command approval and persists only command facts", async () => {
  const host = testHost("always");
  const server = await serveCodexWebSocket({
    appServer: host,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    let approvalRequests = 0;
    const commandOrder: string[] = [];
    client.onNotification("item/started", (params) => {
      if (
        isRecord(params) &&
        isRecord(params.item) &&
        params.item.type === "commandExecution"
      ) {
        commandOrder.push("item/started");
      }
    });
    client.onServerRequest(
      "item/commandExecution/requestApproval",
      (params) => {
        approvalRequests += 1;
        commandOrder.push("approval");
        assert.equal(
          (params as { command: string }).command,
          "printf protocol-approved",
        );
        return { decision: "accept" };
      },
    );
    await client.initialize({
      name: "test",
      title: "Test",
      version: "0.1.0",
    });
    const start = await client.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");
    const completed = deferred<void>();
    client.onNotification("turn/completed", () => {
      completed.resolve();
    });
    await client.request("turn/start", {
      threadId: thread.id,
      input: [
        {
          type: "text",
          text: "!shell printf protocol-approved",
          text_elements: [],
        },
      ],
    });
    await completed.promise;
    assert.equal(approvalRequests, 1);
    assert.deepEqual(commandOrder, ["item/started", "approval"]);

    const snapshot = await host.readThread(String(thread.id));
    assert(!snapshot.items.some((item) => item.type.includes("approval")));
    assert(snapshot.items.some((item) => item.type === "tool_call"));
    assert(snapshot.items.some((item) => item.type === "tool_result"));
  } finally {
    client.close();
    await server.close();
  }
});

test("acceptForSession remains connection-local and suppresses later approval prompts", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost("always"),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    let approvalRequests = 0;
    client.onServerRequest("item/commandExecution/requestApproval", () => {
      approvalRequests += 1;
      return { decision: "acceptForSession" };
    });
    await client.initialize({
      name: "test",
      title: "Test",
      version: "0.1.0",
    });
    const start = await client.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");

    for (const command of ["printf first", "printf second"]) {
      const completed = deferred<void>();
      const dispose = client.onNotification("turn/completed", () => {
        completed.resolve();
      });
      await client.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: `!shell ${command}`, text_elements: [] }],
      });
      await completed.promise;
      dispose();
    }
    assert.equal(approvalRequests, 1);
  } finally {
    client.close();
    await server.close();
  }
});

test("matches the pinned thread/unsubscribe response and rejects thread/subscribe", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost(),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    await client.initialize({
      name: "test",
      title: "Test",
      version: "0.1.0",
    });
    const start = await client.request("thread/start", {});
    const thread = responseResult<Record<string, unknown>>(start, "thread");

    assert.deepEqual(
      await client.request("thread/unsubscribe", { threadId: thread.id }),
      { status: "unsubscribed" },
    );
    assert.deepEqual(
      await client.request("thread/unsubscribe", { threadId: thread.id }),
      { status: "notSubscribed" },
    );
    await assert.rejects(
      client.request("thread/subscribe", { threadId: thread.id }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32601,
    );
    await assert.rejects(
      client.request("thread/start", { approvalPolicy: "untrusted" }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );
    await assert.rejects(
      client.request("thread/start", { sandbox: "workspace-write" }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );
  } finally {
    client.close();
    await server.close();
  }
});

test("interrupts a pending approval and resolves its server request", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost("always"),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    const approvalSeen = deferred<void>();
    const unansweredApproval = deferred<unknown>();
    const requestResolved = deferred<Record<string, unknown>>();
    const commandCompleted = deferred<Record<string, unknown>>();
    const turnCompleted = deferred<Record<string, unknown>>();

    client.onServerRequest("item/commandExecution/requestApproval", () => {
      approvalSeen.resolve();
      return unansweredApproval.promise;
    });
    client.onNotification("serverRequest/resolved", (params) => {
      if (isRecord(params)) {
        requestResolved.resolve(params);
      }
    });
    client.onNotification("item/completed", (params) => {
      if (
        isRecord(params) &&
        isRecord(params.item) &&
        params.item.type === "commandExecution"
      ) {
        commandCompleted.resolve(params.item);
      }
    });
    client.onNotification("turn/completed", (params) => {
      if (isRecord(params) && isRecord(params.turn)) {
        turnCompleted.resolve(params.turn);
      }
    });

    await client.initialize({
      name: "test",
      title: "Test",
      version: "0.1.0",
    });
    const start = await client.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");
    const turnStart = await client.request("turn/start", {
      threadId: thread.id,
      input: [
        {
          type: "text",
          text: "!shell printf never-runs",
          text_elements: [],
        },
      ],
    });
    const turn = responseResult<Record<string, unknown>>(turnStart, "turn");
    await within(approvalSeen.promise);

    assert.deepEqual(
      await within(
        client.request("turn/interrupt", {
          threadId: thread.id,
          turnId: turn.id,
        }),
      ),
      {},
    );
    const [resolved, command, completedTurn] = await within(
      Promise.all([
        requestResolved.promise,
        commandCompleted.promise,
        turnCompleted.promise,
      ]),
    );
    assert.equal(resolved.threadId, thread.id);
    assert.equal(resolved.requestId, "approval_1");
    assert.equal(command.status, "declined");
    assert.equal(completedTurn.status, "interrupted");
  } finally {
    client.close();
    await server.close();
  }
});

test("resumed connections complete commands from canonical tool-call history", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost("always"),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const first = await CodexClient.connect(server.url);
  const resumed = await CodexClient.connect(server.url);
  try {
    const approvalSeen = deferred<void>();
    const approvalDecision = deferred<unknown>();
    const firstTurnCompleted = deferred<void>();
    const resumedCommand = deferred<Record<string, unknown>>();
    const resumedErrors: unknown[] = [];

    first.onServerRequest("item/commandExecution/requestApproval", () => {
      approvalSeen.resolve();
      return approvalDecision.promise;
    });
    first.onNotification("turn/completed", () => {
      firstTurnCompleted.resolve();
    });
    resumed.onNotification("item/completed", (params) => {
      if (
        isRecord(params) &&
        isRecord(params.item) &&
        params.item.type === "commandExecution"
      ) {
        resumedCommand.resolve(params.item);
      }
    });
    resumed.onNotification("error", (params) => {
      resumedErrors.push(params);
    });

    await first.initialize({
      name: "first",
      title: "First",
      version: "0.1.0",
    });
    await resumed.initialize({
      name: "resumed",
      title: "Resumed",
      version: "0.1.0",
    });
    const start = await first.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");
    await first.request("turn/start", {
      threadId: thread.id,
      input: [
        {
          type: "text",
          text: "!shell printf resumed-command",
          text_elements: [],
        },
      ],
    });
    await within(approvalSeen.promise);

    await resumed.request("thread/resume", { threadId: thread.id });
    approvalDecision.resolve({ decision: "accept" });

    const command = await within(resumedCommand.promise);
    await within(firstTurnCompleted.promise);
    assert.equal(command.status, "completed");
    assert.equal(command.aggregatedOutput, "resumed-command");
    assert.deepEqual(resumedErrors, []);
  } finally {
    first.close();
    resumed.close();
    await server.close();
  }
});

test("CLI executes one full local protocol turn", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zen-cli-test-"),
  );
  try {
    const echo = await executeCli([
      "run",
      "--data-dir",
      temporaryDirectory,
      "hello CLI",
    ]);
    assert.equal(echo.stderr, "");
    assert.match(echo.stdout, /Echo: hello CLI/);

    const approvedTool = await executeCli([
      "run",
      "--data-dir",
      temporaryDirectory,
      "--approve",
      "!shell printf cli-approved",
    ]);
    assert.equal(approvedTool.stderr, "");
    assert.match(approvedTool.stdout, /Command result:\s+cli-approved/u);
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});

async function executeCli(
  arguments_: string[],
): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.resolve("dist/apps/cli/src/cli.js"), ...arguments_],
      { cwd: process.cwd() },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`${error.message}\n${stderr}`));
        }
      },
    );
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${String(timeoutMs)} ms`));
    }, timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
