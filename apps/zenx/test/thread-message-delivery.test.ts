import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import type { ModelEvent } from "../../../src/model.js";
import {
  deferred,
  fixture,
  sender,
} from "../../../test/thread-message-fixture.js";

test("native self-control and Subagents default to agent steering even with saved user queue", async () => {
  const { serveCodexWebSocket } =
    await import("../../../src/protocol/codex/websocket.js");
  const { ZenXProtocolClient } =
    await import("../src/protocol-client/protocol-client.js");
  const { MutableAppServerRequestPort, ZenXSelfControlCapabilityPackage } =
    await import("../src/main/capabilities/self-control-package.js");
  const { ZenXSubagentsCapabilityPackage } =
    await import("../src/main/capabilities/subagents-package.js");
  const entered = deferred(),
    release = deferred();
  let blocked = false;
  const f = fixture({
    provider: "native-message",
    async *stream(): AsyncIterable<ModelEvent> {
      if (!blocked) {
        blocked = true;
        entered.resolve();
        await release.promise;
      }
      yield { type: "text_delta", delta: "done" };
    },
  });
  const sources = await Promise.all(
    ["self", "subagent"].map((label) => sender(f, label)),
  );
  const target = await f.server.startThread();
  const active = await f.server.startTurn(target.id, "target");
  await entered.promise;
  const host = await serveCodexWebSocket({
    appServer: f.server,
    zenHome: os.tmpdir(),
    listen: "ws://127.0.0.1:0",
  });
  const client = await ZenXProtocolClient.connect({
    url: host.url,
    clientInfo: { name: "thread-message-test", title: "test", version: "1" },
  });
  const port = new MutableAppServerRequestPort();
  await port.attach(client, os.tmpdir());
  const threads = new ZenXSelfControlCapabilityPackage({
    appServer: port,
    sendPreference: async () => "queue",
  });
  const subagents = new ZenXSubagentsCapabilityPackage({
    appServer: port,
    threads,
    listSummaries: async () => [],
  });
  try {
    for (const [index, name] of [
      "zenx_threads_send",
      "zenx_subagents_send",
    ].entries()) {
      const source = sources[index]!;
      const result = (await (index === 0 ? threads : subagents).invoke(name, {
        name,
        arguments: { threadId: target.id, text: `native-${index}` },
        threadId: source.threadId,
        canonicalToolCallId: source.toolCallId,
        callId: source.callId,
        cwd: os.tmpdir(),
        signal: new AbortController().signal,
      })) as { mode: string; turnId: string };
      assert.equal(result.mode, "steer");
      assert.equal(result.turnId, active.id);
    }
    await assert.rejects(
      threads.invoke("zenx_threads_send", {
        name: "zenx_threads_send",
        arguments: {
          threadId: target.id,
          text: "spoof",
          sourceThreadId: sources[0]!.threadId,
        },
        cwd: os.tmpdir(),
        callId: "fake",
        signal: new AbortController().signal,
      }),
      /Unexpected argument/,
    );
  } finally {
    release.resolve();
    await active.done;
    client.close();
    await host.close();
  }
  const snapshot = await f.server.readThread(target.id);
  assert.equal(
    snapshot.items.filter((item) => item.type === "thread_message").length,
    2,
  );
  assert.equal(
    snapshot.items.filter((item) => item.type === "user_message_queued").length,
    0,
  );
});
