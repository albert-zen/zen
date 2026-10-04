import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarnessAdapter } from "./adapter.mjs";

function setup(engine, result) {
  const calls = [];
  const adapter = createHarnessAdapter(engine, {
    request: async (method, params) => {
      calls.push({ method, params });
      if (result instanceof Error) throw result;
      return typeof result === "function" ? result(method, params) : result;
    },
  });
  return { adapter, calls };
}
for (const engine of ["zen", "codex"]) {
  test(`${engine}: create pins conservative policy without starting a turn`, async () => {
    const { adapter, calls } = setup(engine, { thread: { id: "t" } });
    assert.deepEqual(await adapter.createSession({ cwd: "/work" }), {
      engine,
      id: "t",
    });
    assert.deepEqual(calls, [
      {
        method: "thread/start",
        params: {
          cwd: "/work",
          sandbox: "read-only",
          approvalPolicy: "on-request",
        },
      },
    ]);
  });
  test(`${engine}: rejects another engine's reference before dispatch`, async () => {
    const { adapter, calls } = setup(engine, {});
    await assert.rejects(
      adapter.readSession({
        engine: engine === "zen" ? "codex" : "zen",
        id: "t",
      }),
      /engine/,
    );
    assert.equal(calls.length, 0);
  });
  test(`${engine}: acceptance does not invent model consumption`, async () => {
    const { adapter } = setup(engine, { turnId: "turn", turn: { id: "turn" } });
    const receipt = await adapter.send(
      { engine, id: "t" },
      { text: "hi", messageId: "m", mode: "start" },
    );
    assert.equal(receipt.status, "accepted");
    assert.equal(receipt.consumption, "unknown");
  });
  test(`${engine}: steering requires active-turn identity and never falls back`, async () => {
    const { adapter, calls } = setup(engine, new Error("turn ended"));
    const ref = { engine, id: "t" };
    await assert.rejects(
      adapter.send(ref, { text: "hi", messageId: "m", mode: "steer" }),
      /expectedTurnId/,
    );
    assert.equal(calls.length, 0);
    await assert.rejects(
      adapter.send(ref, {
        text: "hi",
        messageId: "m",
        mode: "steer",
        expectedTurnId: "turn",
      }),
      /turn ended/,
    );
    assert.equal(calls.length, 1);
  });
  test(`${engine}: rejects malformed response and wrong session identity`, async () => {
    const { adapter } = setup(engine, {
      thread: { id: "other", items: [], turns: [] },
    });
    await assert.rejects(adapter.readSession({ engine, id: "t" }), /identity/);
    const malformed = setup(engine, {});
    await assert.rejects(
      malformed.adapter.createSession({ cwd: "/work" }),
      /thread/,
    );
  });
  test(`${engine}: interrupt is correlated, errors propagate`, async () => {
    const { adapter, calls } = setup(engine, {});
    await adapter.interrupt({ engine, id: "t" }, "turn");
    assert.deepEqual(calls, [
      { method: "turn/interrupt", params: { threadId: "t", turnId: "turn" } },
    ]);
  });
}
test("native Zen uses native send and canonical read; preserves client id", async () => {
  const { adapter, calls } = setup("zen", (method) =>
    method === "zen/thread/read"
      ? { thread: { id: "t", items: [], turns: [] } }
      : { turnId: "turn" },
  );
  const ref = { engine: "zen", id: "t" };
  const snapshot = await adapter.readSession(ref);
  assert.equal(snapshot.format, "zen-canonical-items");
  await adapter.send(ref, {
    text: "hi",
    messageId: "m",
    mode: "steer",
    expectedTurnId: "turn",
  });
  assert.deepEqual(calls[1], {
    method: "zen/turn/send",
    params: {
      threadId: "t",
      mode: "steer",
      input: [{ type: "text", text: "hi" }],
      clientUserMessageId: "m",
      expectedTurnId: "turn",
    },
  });
});
test("Codex uses official methods and keeps provider-owned snapshot opaque", async () => {
  const { adapter, calls } = setup("codex", (method) =>
    method === "thread/read"
      ? { thread: { id: "t", turns: [] } }
      : method === "turn/start"
        ? { turn: { id: "turn" } }
        : { turnId: "turn" },
  );
  const ref = { engine: "codex", id: "t" };
  assert.equal((await adapter.readSession(ref)).format, "codex-thread");
  await adapter.send(ref, { text: "hi", messageId: "m", mode: "start" });
  await adapter.send(ref, {
    text: "follow",
    messageId: "m2",
    mode: "steer",
    expectedTurnId: "turn",
  });
  assert.deepEqual(
    calls.map((c) => c.method),
    ["thread/read", "turn/start", "turn/steer"],
  );
  assert.equal(calls[1].params.clientUserMessageId, undefined);
  assert.equal(calls[2].params.expectedTurnId, "turn");
});
test("unsupported backend and implicit queueing fail closed", async () => {
  assert.throws(
    () => createHarnessAdapter("claude", { request() {} }),
    /Unsupported/,
  );
  const { adapter, calls } = setup("zen", {});
  await assert.rejects(
    adapter.send(
      { engine: "zen", id: "t" },
      { text: "hi", messageId: "m", mode: "queue" },
    ),
    /mode/,
  );
  assert.equal(calls.length, 0);
});
