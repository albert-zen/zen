import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAgentAdapter } from "../src/main/agent-providers/codex-adapter.js";
import type { AgentProviderEvent } from "../src/main/agent-providers/types.js";

// A spawned protocol child, not mocked adapter methods. It never calls a model,
// accesses credentials, or opens a network connection. The log is test-owned.
const peer = fileURLToPath(
  new URL("./fixtures/codex-app-server-peer.cjs", import.meta.url),
);

async function fixture(
  t: test.TestContext,
  scenario = "",
  extra: ConstructorParameters<typeof CodexAgentAdapter>[0] = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-codex-peer-"));
  const logPath = path.join(dir, "protocol.jsonl");
  const adapter = new CodexAgentAdapter({
    binaryPath: process.execPath,
    args: [peer],
    env: { PEER_SCENARIO: scenario, PEER_LOG: logPath },
    requestTimeoutMs: 1500,
    shutdownGraceMs: 50,
    terminationGraceMs: 100,
    ...extra,
  });
  const events: AgentProviderEvent[] = [];
  adapter.onEvent((event) => events.push(event));
  t.after(async () => {
    await adapter.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const log = async () =>
    (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, any>);
  return { adapter, events, log };
}
async function until(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!(await predicate())) {
    if (Date.now() > deadline)
      throw new Error("Expected protocol event did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function create(adapter: CodexAgentAdapter) {
  return adapter.create({
    cwd: "/workspace/test",
    model: "test-model",
    permissionMode: "workspace-write",
  });
}

test("launches a real stdio child and initializes before listing models", async (t) => {
  const { adapter, log } = await fixture(t);
  const models = await adapter.models();
  assert.equal(models[0]?.model, "test-model");
  assert.equal(models[0]?.displayName, "Test modèle");
  assert.deepEqual(models[0]?.supportedReasoningEfforts, [
    { reasoningEffort: "high", description: "High" },
  ]);
  assert.deepEqual(
    (await log()).map((row) => row.method),
    ["initialize", "initialized", "model/list"],
  );
});

test("concurrent discovery requests initialize exactly one child", async (t) => {
  const { adapter, log } = await fixture(t);
  await Promise.all([adapter.models(), adapter.models(), adapter.models()]);
  assert.equal(
    (await log()).filter((row) => row.method === "initialize").length,
    1,
  );
});

test("model discovery follows native pages and rejects repeated cursors", async (t) => {
  const { adapter } = await fixture(t, "model-pages");
  assert.deepEqual(
    (await adapter.models()).map((model) => model.model),
    ["test-model", "model-2"],
  );
  const bad = await fixture(t, "repeated-cursor");
  await assert.rejects(bad.adapter.models(), /repeated a pagination cursor/);
});

test("creates native threads with user-routed approvals and faithful permission modes", async (t) => {
  const { adapter, log } = await fixture(t);
  for (const permissionMode of [
    "read-only",
    "workspace-write",
    "danger-full-access",
  ] as const) {
    const session = await adapter.create({
      cwd: "/workspace/test",
      model: "test-model",
      permissionMode,
    });
    assert.equal(session.nativeSessionId, "native-thread");
    assert.equal(session.thread.canonicalItems, undefined);
  }
  const requests = (await log()).filter((row) => row.method === "thread/start");
  assert.deepEqual(
    requests.map((row) => row.params.sandbox),
    ["read-only", "workspace-write", "danger-full-access"],
  );
  for (const request of requests) {
    assert.equal(request.params.approvalPolicy, "on-request");
    assert.equal(request.params.approvalsReviewer, "user");
  }
  await assert.rejects(
    adapter.create({
      cwd: "/workspace/test",
      permissionMode: "unknown" as never,
    }),
    /Unsupported/,
  );
});

test("read resumes native authority and hydrates all paginated history", async (t) => {
  const { adapter, log } = await fixture(t, "paginated");
  const session = await adapter.read("native-thread");
  assert.deepEqual(
    session.thread.turns.map((turn) => turn.id),
    ["history-1", "history-2"],
  );
  const requests = await log();
  assert.equal(
    requests.filter((row) => row.method === "thread/resume").length,
    1,
  );
  assert.equal(
    requests.find((row) => row.method === "thread/resume")?.params.excludeTurns,
    true,
  );
  assert.equal(
    requests.filter(
      (row) => row.method === "thread/read" && row.params.includeTurns,
    ).length,
    0,
  );
  await adapter.read("native-thread");
  assert.equal(
    (await log()).filter((row) => row.method === "thread/resume").length,
    1,
  );
});

test("paginated native history rejects cursor loops", async (t) => {
  const { adapter } = await fixture(t, "repeated-history-cursor");
  await assert.rejects(
    adapter.read("native-thread"),
    /repeated a pagination cursor/,
  );
});

test("live deltas overlay native read without fabricating canonical history", async (t) => {
  const { adapter, events, log } = await fixture(t, "stream");
  await create(adapter);
  await adapter.send("native-thread", { text: "test", model: "model-2" });
  await until(
    () => events.filter((event) => event.type === "changed").length >= 5,
  );
  const session = await adapter.read("native-thread");
  assert.equal(session.model, "model-2");
  assert.equal(session.thread.status.type, "active");
  assert.equal(session.thread.canonicalItems, undefined);
  const items = session.thread.turns[0]?.items;
  assert.equal(
    items?.find((item) => item.type === "agentMessage")?.text,
    "Hello world",
  );
  const reasoning = items?.find((item) => item.type === "reasoning");
  assert.deepEqual(reasoning?.summary, ["", "Visible reasoning"]);
  const request = (await log()).find((row) => row.method === "turn/start");
  assert.equal(request?.params.model, "model-2");
  assert.equal(request?.params.approvalsReviewer, "user");
  assert.deepEqual(request?.params.input, [
    { type: "text", text: "test", text_elements: [] },
  ]);
  // Returned display objects cannot mutate the retained stream tail.
  if (items?.[0]?.type === "agentMessage") items[0].text = "tampered";
  assert.equal(
    (await adapter.read("native-thread")).thread.turns[0]?.items.find(
      (item) => item.type === "agentMessage",
    )?.text,
    "Hello world",
  );
});

test("tool lifecycle/output and unsupported item types remain readable projections", async (t) => {
  const { adapter, events } = await fixture(t, "tools");
  await create(adapter);
  await adapter.send("native-thread", { text: "tools" });
  await until(
    () => events.filter((event) => event.type === "changed").length >= 10,
  );
  const items = (await adapter.read("native-thread")).thread.turns[0]?.items;
  const command = items?.find((item) => item.id === "cmd");
  assert.equal(command?.type, "commandExecution");
  if (command?.type === "commandExecution") {
    assert.equal(command.status, "completed");
    assert.equal(command.aggregatedOutput, "safe\n");
    assert.equal(command.exitCode, 0);
  }
  const mcp = items?.find((item) => item.id === "mcp");
  if (mcp?.type === "commandExecution") {
    assert.equal(mcp.toolName, "mcpToolCall");
    assert.deepEqual(mcp.toolArguments, { path: "a.txt" });
    assert.match(mcp.aggregatedOutput ?? "", /read/);
  } else assert.fail("MCP item was omitted");
  assert.equal(
    items?.some((item) => item.id === "patch"),
    true,
  );
});

test("late turn/start receipt does not regress completed streaming state", async (t) => {
  const { adapter } = await fixture(t, "send-before-receipt");
  await create(adapter);
  await adapter.send("native-thread", { text: "test" });
  const snapshot = await adapter.read("native-thread");
  assert.equal(snapshot.thread.turns[0]?.status, "completed");
  assert.equal(snapshot.thread.status.type, "idle");
  const message = snapshot.thread.turns[0]?.items.find(
    (item) => item.type === "agentMessage",
  );
  assert.equal(message?.text, "Complete");
});

for (const scenario of ["approval", "file-approval"] as const) {
  test(`${scenario} remains pending until an explicit scoped response`, async (t) => {
    const { adapter, events, log } = await fixture(t, scenario);
    await create(adapter);
    await adapter.send("native-thread", { text: "needs approval" });
    await until(() => events.some((event) => event.type === "approval"));
    const approval = events.find((event) => event.type === "approval");
    assert.ok(approval?.type === "approval");
    assert.equal(approval.sessionId, "native-thread");
    assert.match(approval.detail, /Explicit permission/);
    assert.equal(
      (await log()).some((row) => !row.method && row.id !== undefined),
      false,
    );
    await adapter.respondApproval(approval.requestId, "decline");
    await until(
      () => events.filter((event) => event.type === "changed").length >= 3,
    );
    await until(async () =>
      (await log()).some((row) => !row.method && row.id !== undefined),
    );
    const response = (await log()).find(
      (row) => !row.method && row.id !== undefined,
    );
    assert.deepEqual(response, {
      id: scenario === "file-approval" ? 42 : "wire-approval",
      result: { decision: "decline" },
    });
    await assert.rejects(
      adapter.respondApproval(approval.requestId, "accept"),
      /no longer pending/,
    );
  });
}

test("process restart expires approvals even when native wire IDs are reused", async (t) => {
  const { adapter, events } = await fixture(t, "approval");
  await create(adapter);
  await adapter.send("native-thread", { text: "first" });
  await until(() => events.some((event) => event.type === "approval"));
  const first = events.find((event) => event.type === "approval");
  assert.ok(first?.type === "approval");
  await adapter.restart();
  await assert.rejects(
    adapter.respondApproval(first.requestId, "accept"),
    /no longer pending/,
  );
  await adapter.send("native-thread", { text: "second" });
  await until(
    () => events.filter((event) => event.type === "approval").length === 2,
  );
  const last = events.filter((event) => event.type === "approval").at(-1);
  assert.ok(last?.type === "approval");
  assert.notEqual(last.requestId, first.requestId);
  await adapter.respondApproval(last.requestId, "accept");
});

test("native resolved callbacks expire their matching approval", async (t) => {
  const { adapter, events } = await fixture(t, "resolved-approval");
  await create(adapter);
  await adapter.send("native-thread", { text: "test" });
  await until(
    () => events.filter((event) => event.type === "changed").length >= 3,
  );
  const approval = events.find((event) => event.type === "approval");
  assert.ok(approval?.type === "approval");
  await assert.rejects(
    adapter.respondApproval(approval.requestId, "accept"),
    /no longer pending/,
  );
});

test("unknown server callbacks fail closed with a visible error and wire rejection", async (t) => {
  const { adapter, events, log } = await fixture(t, "unknown-request");
  await create(adapter);
  await adapter.send("native-thread", { text: "test" });
  await until(() => events.some((event) => event.type === "error"));
  await until(async () => (await log()).some((row) => row.id === "unknown"));
  const response = (await log()).find((row) => row.id === "unknown");
  assert.equal(response?.error.code, -32601);
  assert.equal(response?.result, undefined);
  assert.equal(
    events.some((event) => event.type === "approval"),
    false,
  );
});

test("interrupt addresses the exact native turn and waits for native completion", async (t) => {
  const { adapter, log } = await fixture(t, "stream");
  await create(adapter);
  await adapter.send("native-thread", { text: "test" });
  await adapter.interrupt("native-thread");
  const request = (await log()).find((row) => row.method === "turn/interrupt");
  assert.deepEqual(request?.params, {
    threadId: "native-thread",
    turnId: "turn-1",
  });
  const snapshot = await adapter.read("native-thread");
  assert.equal(snapshot.thread.turns[0]?.status, "interrupted");
  assert.equal(snapshot.thread.status.type, "idle");
  await assert.rejects(adapter.interrupt("native-thread"), /no active turn/);
});

test("restart clears volatile deltas and resumes by native ID before sending", async (t) => {
  const { adapter, log } = await fixture(t, "stream");
  await create(adapter);
  await adapter.send("native-thread", { text: "test" });
  await adapter.restart();
  const snapshot = await adapter.read("native-thread");
  assert.deepEqual(snapshot.thread.turns, []);
  assert.equal(
    (await log()).filter((row) => row.method === "initialize").length,
    2,
  );
  assert.equal(
    (await log()).filter((row) => row.method === "thread/resume").length,
    1,
  );
});

for (const scenario of [
  "model-error",
  "timeout",
  "exit-on-models",
  "init-error",
  "init-timeout",
  "exit-on-initialize",
  "bad-wire",
] as const) {
  test(`propagates ${scenario} without hanging pending callers`, async (t) => {
    const { adapter } = await fixture(t, scenario, { requestTimeoutMs: 100 });
    await assert.rejects(adapter.models(), /Codex|Initialization|Catalog/);
  });
}

test("readable transport survives UTF-8 and JSONL chunk splitting", async (t) => {
  const { adapter } = await fixture(t, "split-wire");
  assert.equal((await adapter.models())[0]?.displayName, "Test modèle");
});

test("a missing executable reports spawn failure", async () => {
  const adapter = new CodexAgentAdapter({
    binaryPath: "/does-not-exist/codex",
    requestTimeoutMs: 100,
  });
  await assert.rejects(adapter.models(), /ENOENT|closed/);
  await adapter.dispose();
});

test("teardown escalates a non-cooperative child and permits no post-dispose work", async (t) => {
  const { adapter } = await fixture(t, "ignore-shutdown");
  await adapter.models();
  await adapter.dispose();
  await assert.rejects(adapter.models(), /disposed/);
});

test("stopping initialization rejects pending work and leaves no stranded process", async (t) => {
  const { adapter } = await fixture(t, "init-timeout", {
    requestTimeoutMs: 5000,
  });
  const starting = adapter.start();
  const result = assert.rejects(starting, /stopped/);
  await adapter.stop();
  await result;
});

test("terminal native history supersedes a differing volatile stream preview", async (t) => {
  const { adapter } = await fixture(t, "native-terminal-wins");
  await create(adapter);
  await adapter.send("native-thread", { text: "test" });
  const snapshot = await adapter.read("native-thread");
  assert.equal(snapshot.thread.turns[0]?.status, "completed");
  assert.equal(
    snapshot.thread.turns[0]?.items.find((item) => item.type === "agentMessage")
      ?.text,
    "Native final",
  );
  assert.equal(snapshot.thread.status.type, "idle");
});

test("approval resolution events remove pending UI prompts on reply and stop", async (t) => {
  const { adapter, events } = await fixture(t, "approval");
  await create(adapter);
  await adapter.send("native-thread", { text: "test" });
  await until(() => events.some((event) => event.type === "approval"));
  const first = events.find((event) => event.type === "approval");
  assert.ok(first?.type === "approval");
  await adapter.respondApproval(first.requestId, "decline");
  assert.ok(
    events.some(
      (event) =>
        event.type === "approvalResolved" &&
        event.requestId === first.requestId,
    ),
  );
  await adapter.send("native-thread", { text: "another" });
  await until(
    () => events.filter((event) => event.type === "approval").length === 2,
  );
  const second = events.filter((event) => event.type === "approval").at(-1);
  assert.ok(second?.type === "approval");
  await adapter.stop();
  assert.ok(
    events.some(
      (event) =>
        event.type === "approvalResolved" &&
        event.requestId === second.requestId,
    ),
  );
});

test("observer exceptions and unsubscribe cannot break native transport", async (t) => {
  const { adapter } = await fixture(t, "stream");
  adapter.onEvent(() => {
    throw new Error("UI observer failure");
  });
  let count = 0;
  const unsubscribe = adapter.onEvent(() => {
    count += 1;
  });
  unsubscribe();
  await create(adapter);
  await adapter.send("native-thread", { text: "test" });
  await adapter.read("native-thread");
  assert.equal(count, 0);
});

test("GUI native peer creates distinct sessions and preserves their cwd and history across process restart", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zen-codex-native-state-"));
  const stateFile = path.join(dir, "native-state.json");
  const { adapter } = await fixture(t, "gui", {
    env: { PEER_STATE_FILE: stateFile },
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await adapter.create({
    cwd: "/selected/first-workspace",
    model: "test-model",
    permissionMode: "workspace-write",
  });
  const second = await adapter.create({
    cwd: "/selected/second-workspace",
    model: "model-2",
    permissionMode: "read-only",
  });
  assert.notEqual(first.nativeSessionId, second.nativeSessionId);
  assert.equal(first.thread.cwd, "/selected/first-workspace");
  assert.equal(second.thread.cwd, "/selected/second-workspace");
  await Promise.all([
    adapter.send(first.nativeSessionId, { text: "First native history" }),
    adapter.send(second.nativeSessionId, { text: "Second native history" }),
  ]);
  await until(async () => {
    const firstRead = await adapter.read(first.nativeSessionId);
    const secondRead = await adapter.read(second.nativeSessionId);
    return (
      firstRead.thread.turns[0]?.status === "completed" &&
      secondRead.thread.turns[0]?.status === "completed"
    );
  });
  await adapter.restart();
  const restoredFirst = await adapter.read(first.nativeSessionId);
  const restoredSecond = await adapter.read(second.nativeSessionId);
  assert.equal(restoredFirst.thread.cwd, "/selected/first-workspace");
  assert.equal(restoredSecond.thread.cwd, "/selected/second-workspace");
  assert.equal(restoredSecond.model, "model-2");
  assert.equal(
    restoredFirst.thread.turns[0]?.items.find(
      (item) => item.type === "userMessage",
    )?.content[0]?.text,
    "First native history",
  );
  assert.equal(
    restoredSecond.thread.turns[0]?.items.find(
      (item) => item.type === "userMessage",
    )?.content[0]?.text,
    "Second native history",
  );
  const third = await adapter.create({
    cwd: "/selected/third-workspace",
    permissionMode: "workspace-write",
  });
  assert.notEqual(third.nativeSessionId, first.nativeSessionId);
  assert.notEqual(third.nativeSessionId, second.nativeSessionId);
  await assert.rejects(adapter.read("missing-native-session"), /not found/);
});

test("GUI native restart preserves unfinished history as interrupted and expires approvals", async (t) => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "zen-codex-native-approval-"),
  );
  const { adapter, events } = await fixture(t, "approval", {
    env: {
      PEER_STATE_FILE: path.join(dir, "native-state.json"),
      PEER_SCENARIO: "approval",
    },
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = await adapter.create({
    cwd: "/selected/approval-workspace",
    permissionMode: "workspace-write",
  });
  await adapter.send(session.nativeSessionId, {
    text: "Unfinished native history",
  });
  await until(() => events.some((event) => event.type === "approval"));
  const pending = events.find((event) => event.type === "approval");
  assert.ok(pending?.type === "approval");
  await adapter.restart();
  const restored = await adapter.read(session.nativeSessionId);
  assert.equal(restored.thread.status.type, "idle");
  assert.equal(restored.thread.turns[0]?.status, "interrupted");
  assert.equal(
    restored.thread.turns[0]?.items.find((item) => item.type === "userMessage")
      ?.content[0]?.text,
    "Unfinished native history",
  );
  await assert.rejects(
    adapter.respondApproval(pending.requestId, "accept"),
    /no longer pending/,
  );
  await adapter.send(session.nativeSessionId, { text: "Next native turn" });
  await until(
    () => events.filter((event) => event.type === "approval").length === 2,
  );
  const next = events.filter((event) => event.type === "approval").at(-1);
  assert.ok(next?.type === "approval");
  await adapter.respondApproval(next.requestId, "decline");
  await until(
    async () =>
      (await adapter.read(session.nativeSessionId)).thread.turns[1]?.status ===
      "completed",
  );
  assert.equal(
    (await adapter.read(session.nativeSessionId)).thread.turns.length,
    2,
  );
});
