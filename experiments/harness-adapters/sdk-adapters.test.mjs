import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarnessAdapter } from "./adapter.mjs";
const ref = (engine, id = "s") => ({ engine, id });
const input = { text: "hello", messageId: "m", mode: "start" };

test("Claude starts on first prompt, resumes explicitly, reads and forks through official SDK", async () => {
  const calls = [];
  const sdk = {
    query(args) {
      calls.push(["query", args]);
      return Object.assign(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "s" };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "s",
            result: "answer",
          };
        })(),
        {
          close() {
            calls.push(["close"]);
          },
        },
      );
    },
    getSessionInfo: async (id, opts) => ({ sessionId: id }),
    getSessionMessages: async (id, opts) => {
      calls.push(["read", id, opts]);
      return [];
    },
    forkSession: async (id, opts) => {
      calls.push(["fork", id, opts]);
      return { sessionId: "child" };
    },
  };
  const a = createHarnessAdapter("claude-code", sdk, { cwd: "/work" });
  const started = await a.startSession(input);
  assert.deepEqual(started.ref, ref("claude-code"));
  assert.equal(started.status, "settled");
  assert.equal(started.consumption, "unknown");
  assert.equal(calls[0][1].options.permissionMode, "default");
  await a.send(ref("claude-code"), input);
  assert.equal(calls[2][1].options.resume, "s");
  assert.equal(
    (await a.readSession(ref("claude-code"))).format,
    "claude-session-messages",
  );
  assert.deepEqual(
    await a.forkSession(ref("claude-code")),
    ref("claude-code", "child"),
  );
  assert.equal(a.capabilities.steer, false);
  await assert.rejects(
    a.send(ref("claude-code"), { ...input, mode: "steer" }),
    /Unsupported/,
  );
});
test("Claude failures close query and never turn missing/error results into success", async () => {
  let closed = 0;
  const sdk = {
    query() {
      return Object.assign(
        (async function* () {
          yield {
            type: "result",
            subtype: "error_max_turns",
            is_error: true,
            session_id: "s",
            errors: ["budget"],
          };
        })(),
        {
          close() {
            closed++;
          },
        },
      );
    },
  };
  const a = createHarnessAdapter("claude-code", sdk, { cwd: "/work" });
  await assert.rejects(a.startSession(input), /error_max_turns/);
  assert.equal(closed, 1);
});
test("OpenCode maps SDK wrappers, messages, prompt, fork and session abort", async () => {
  const calls = [];
  const session = {};
  for (const name of ["create", "get", "messages", "prompt", "fork", "abort"])
    session[name] = async (args) => {
      calls.push([name, args]);
      return {
        data:
          name === "messages"
            ? []
            : name === "abort"
              ? true
              : name === "prompt"
                ? { info: { id: "a", sessionID: "s" }, parts: [] }
                : { id: name === "fork" ? "child" : "s" },
      };
    };
  const a = createHarnessAdapter("opencode", { session }, { cwd: "/work" });
  assert.deepEqual(await a.createSession({ cwd: "/work" }), ref("opencode"));
  assert.equal(
    (await a.readSession(ref("opencode"))).format,
    "opencode-messages",
  );
  assert.equal((await a.send(ref("opencode"), input)).status, "settled");
  assert.deepEqual(calls.find((c) => c[0] === "prompt")[1].body, {
    parts: [{ type: "text", text: "hello" }],
  });
  assert.deepEqual(
    await a.forkSession(ref("opencode")),
    ref("opencode", "child"),
  );
  await a.interrupt(ref("opencode"));
  assert.equal(calls.at(-1)[0], "abort");
  assert.equal(a.capabilities.interruptScope, "session");
});
test("OpenCode errors and wrong-session output do not become success", async () => {
  const err = new Error("transport");
  const a = createHarnessAdapter(
    "opencode",
    { session: { prompt: async () => ({ error: err }) } },
    { cwd: "/work" },
  );
  await assert.rejects(a.send(ref("opencode"), input), (e) => e === err);
  const b = createHarnessAdapter(
    "opencode",
    {
      session: {
        prompt: async () => ({ data: { info: { sessionID: "wrong" } } }),
      },
    },
    { cwd: "/work" },
  );
  await assert.rejects(b.send(ref("opencode"), input), /identity/);
});
test("DeepSeek maps automation ACP without fabricating history or forks", async () => {
  const calls = [];
  const a = createHarnessAdapter(
    "deepseek-harness",
    {
      request: async (method, params) => {
        calls.push([method, params]);
        return method === "session/new"
          ? { sessionId: "s" }
          : method === "session/prompt"
            ? { stopReason: "end_turn" }
            : {};
      },
      notify: async (method, params) => {
        calls.push([method, params]);
      },
    },
    { cwd: "/work" },
  );
  assert.deepEqual(
    await a.createSession({ cwd: "/work" }),
    ref("deepseek-harness"),
  );
  assert.deepEqual(calls[0], ["session/new", { cwd: "/work", mcpServers: [] }]);
  const result = await a.send(ref("deepseek-harness"), input);
  assert.equal(result.status, "settled");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.consumption, "unknown");
  await a.interrupt(ref("deepseek-harness"));
  assert.equal(calls.at(-1)[0], "session/cancel");
  await a.resumeSession(ref("deepseek-harness"));
  assert.equal(calls.at(-1)[0], "session/resume");
  await assert.rejects(a.readSession(ref("deepseek-harness")), /Unsupported/);
  await assert.rejects(a.forkSession(ref("deepseek-harness")), /Unsupported/);
});
for (const engine of ["claude-code", "opencode", "deepseek-harness"])
  test(`${engine}: wrong-engine refs and unsupported steer never dispatch`, async () => {
    const a = createHarnessAdapter(engine, {}, { cwd: "/work" });
    await assert.rejects(a.send(ref("codex"), input), /engine/);
    await assert.rejects(
      a.send(ref(engine), { ...input, mode: "steer" }),
      /Unsupported/,
    );
  });
test("Claude rejects missing terminal results and preserves SDK failures without retry", async () => {
  const error = new Error("sdk failed");
  let calls = 0,
    closed = 0;
  const make = (fail) => ({
    query() {
      calls++;
      return Object.assign(
        (async function* () {
          if (fail) throw error;
          yield { type: "system", subtype: "init", session_id: "s" };
        })(),
        {
          close() {
            closed++;
          },
        },
      );
    },
  });
  await assert.rejects(
    createHarnessAdapter("claude-code", make(false), {
      cwd: "/work",
    }).startSession(input),
    /without a result/,
  );
  await assert.rejects(
    createHarnessAdapter("claude-code", make(true), {
      cwd: "/work",
    }).startSession(input),
    (e) => e === error,
  );
  assert.equal(calls, 2);
  assert.equal(closed, 2);
});
test("DeepSeek preserves stop reason and transport errors rather than claiming successful completion", async () => {
  let calls = 0;
  const error = new Error("session busy");
  const a = createHarnessAdapter(
    "deepseek-harness",
    {
      request: async () => {
        calls++;
        throw error;
      },
    },
    { cwd: "/work" },
  );
  await assert.rejects(
    a.send(ref("deepseek-harness"), input),
    (e) => e === error,
  );
  assert.equal(calls, 1);
  const b = createHarnessAdapter(
    "deepseek-harness",
    { request: async () => ({ stopReason: "max_tokens" }) },
    { cwd: "/work" },
  );
  assert.equal(
    (await b.send(ref("deepseek-harness"), input)).stopReason,
    "max_tokens",
  );
});
test("OpenCode and DeepSeek create reject a different bound workspace without dispatch", async () => {
  for (const engine of ["opencode", "deepseek-harness"]) {
    const a = createHarnessAdapter(engine, {}, { cwd: "/work" });
    await assert.rejects(a.createSession({ cwd: "/other" }), /cwd/);
  }
});
