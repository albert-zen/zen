import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { CodexConnection } from "../src/protocol/codex/connection.js";
import { isRecord, type JsonRpcMessage } from "../src/protocol/codex/wire.js";
import { NativeConnection } from "../src/protocol/native/connection.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";

function fixture() {
  const journal = new InMemoryThreadJournal();
  const server = createHostedAppServer({
    cwd: os.tmpdir(),
    dataDirectory: "/tmp/unused-native-fork",
    model: "fake",
    models: ["fake"],
    approvalPolicy: "never",
    provider: { type: "fake" },
    journal,
  });
  const projection = new NativeRecoveryProjection(server);
  const messages: JsonRpcMessage[] = [];
  const native = new NativeConnection({
    appServer: server,
    projection,
    send: (message) => messages.push(message),
  });
  return { journal, server, projection, messages, native };
}

function response(messages: JsonRpcMessage[], id: string) {
  const message = messages.find(
    (message) => "id" in message && message.id === id,
  );
  assert(message && ("result" in message || "error" in message));
  return message;
}

test("native exact-item fork requires initialization and returns canonical exact-prefix identity", async () => {
  const f = fixture();
  try {
    const source = await f.server.startThread();
    await (
      await f.server.startTurn(source.id, "first input")
    ).done;
    const selected = (await f.server.readThread(source.id)).items.find(
      (item) => item.type === "agent_message",
    )!;
    await (
      await f.server.startTurn(source.id, "later input")
    ).done;
    const params = {
      sourceThreadId: source.id,
      through: { type: "item", itemId: selected.id },
      workspace: { type: "same-directory" },
    };
    await f.native.receive({
      id: "uninitialized",
      method: "zen/thread/fork",
      params,
    });
    const unavailable = response(f.messages, "uninitialized");
    assert("error" in unavailable && unavailable.error.code === -32600);
    await f.native.receive({
      id: "initialize",
      method: "zen/initialize",
      params: {},
    });
    await f.native.receive({ id: "fork", method: "zen/thread/fork", params });
    const forked = response(f.messages, "fork");
    assert(
      "result" in forked &&
        isRecord(forked.result) &&
        isRecord(forked.result.thread),
    );
    const threadId = forked.result.thread.id;
    assert(typeof threadId === "string");
    const fork = await f.server.readThread(threadId);
    assert.deepEqual(forked.result.thread, fork);
    assert.equal(fork.turns.length, 1);
    assert(
      fork.items.some(
        (item) =>
          item.type === "thread_forked" &&
          item.sourceBoundaryItemId === selected.id,
      ),
    );
    assert.equal(
      fork.items.filter((item) => item.type === "agent_message").length,
      1,
    );
    assert.equal((await f.server.readThread(source.id)).turns.length, 2);
  } finally {
    f.native.close();
    f.projection.close();
    await f.server.closeProviderTransport();
  }
});

test("native fork rejects malformed and unavailable targets while the CAS adapter rejects item selection", async () => {
  const f = fixture();
  const cas = new CodexConnection({
    appServer: f.server,
    zenHome: os.tmpdir(),
    send: (message) => f.messages.push(message),
  });
  try {
    const source = await f.server.startThread();
    await (
      await f.server.startTurn(source.id, "first input")
    ).done;
    const selected = (await f.server.readThread(source.id)).items.find(
      (item) => item.type === "agent_message",
    )!;
    await f.native.receive({
      id: "initialize",
      method: "zen/initialize",
      params: {},
    });
    const valid = {
      sourceThreadId: source.id,
      through: { type: "item", itemId: selected.id },
      workspace: { type: "same-directory" },
    };
    const invalid = [
      {},
      { ...valid, sourceThreadId: "" },
      { ...valid, sourceThreadId: " " },
      { ...valid, through: { type: "item" } },
      { ...valid, through: { type: "item", itemId: "" } },
      { ...valid, through: { type: "item", itemId: 7 } },
      { ...valid, through: { type: "latest" } },
      {
        ...valid,
        through: { type: "item", itemId: selected.id, turnId: selected.turnId },
      },
      { ...valid, through: { type: "latest-complete", itemId: selected.id } },
      { ...valid, workspace: { type: "new-directory" } },
      {
        ...valid,
        workspace: { type: "same-directory", cwd: "/tmp/elsewhere" },
      },
      { ...valid, automaticStart: true },
      { ...valid, through: { type: "item", itemId: source.items[0]!.id } },
    ];
    for (const [index, params] of invalid.entries()) {
      const id = `invalid-${String(index)}`;
      await f.native.receive({ id, method: "zen/thread/fork", params });
      const rejected = response(f.messages, id);
      assert(
        "error" in rejected && rejected.error.code === -32602,
        JSON.stringify(rejected),
      );
      assert.deepEqual(rejected.error.data, { zenCode: "invalid_request" });
    }
    await f.native.receive({
      id: "missing-item",
      method: "zen/thread/fork",
      params: { ...valid, through: { type: "item", itemId: "missing" } },
    });
    const missing = response(f.messages, "missing-item");
    assert("error" in missing);
    assert.deepEqual(missing.error.data, {
      zenCode: "fork_boundary_unavailable",
    });
    await cas.receive({
      id: "cas-initialize",
      method: "initialize",
      params: {},
    });
    await cas.receive({ method: "initialized" });
    await cas.receive({ id: "cas-fork", method: "thread/fork", params: valid });
    const rejected = response(f.messages, "cas-fork");
    assert("error" in rejected && rejected.error.code === -32602);
    assert.deepEqual(await f.journal.listThreadIds(), [source.id]);
    await cas.receive({
      id: "cas-copy",
      method: "thread/fork",
      params: { ...valid, through: { type: "latest-complete" } },
    });
    assert(
      "result" in response(f.messages, "cas-copy"),
      "the existing Copy request remains supported",
    );
  } finally {
    cas.close();
    f.native.close();
    f.projection.close();
    await f.server.closeProviderTransport();
  }
});
