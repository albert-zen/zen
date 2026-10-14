import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { ZenAppServer } from "../src/app-server.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { AgentRuntime } from "../src/runtime.js";
import { ToolEnvironment } from "../src/tool.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import type { ModelAdapter, ModelEvent } from "../src/model.js";
import { textFromUserInput } from "../src/item.js";
import { NativeConnection } from "../src/protocol/native/connection.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import type { NativeTurnSendResult } from "../src/protocol/native/wire.js";
import type { JsonRpcMessage } from "../src/protocol/codex/wire.js";
import { deferred, fixture } from "./thread-message-fixture.js";
import { png1x1 } from "./fixtures.js";

function imageFixture(model: ModelAdapter): ReturnType<typeof fixture> {
  const journal = new InMemoryThreadJournal();
  const metadata = new InMemoryThreadMetadataStore();
  const server = new ZenAppServer({
    journal,
    threadMetadata: metadata,
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({ runtimes: [] }),
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          {
            id: "images",
            isDefault: true,
            contextWindow: 32768,
            inputModalities: ["text", "image"],
          },
        ]),
      },
    ]),
    defaults: {
      cwd: os.tmpdir(),
      providerProfileId: model.provider,
      modelId: "images",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  return { server, journal, metadata };
}

function connect(f: ReturnType<typeof fixture>) {
  const projection = new NativeRecoveryProjection(f.server);
  const messages: JsonRpcMessage[] = [];
  const connection = new NativeConnection({
    appServer: f.server,
    projection,
    send(message) {
      messages.push(message);
    },
  });
  let id = 0;
  return {
    messages,
    async rpc(method: string, params: unknown = {}) {
      const next = ++id;
      await connection.receive({ id: next, method, params });
      const message = messages.find(
        (message) => "id" in message && message.id === next,
      );
      assert(message);
      return message;
    },
    close() {
      connection.close();
      projection.close();
    },
  };
}
function accepted(message: JsonRpcMessage) {
  assert("result" in message, JSON.stringify(message));
  return message.result as NativeTurnSendResult;
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Timed out waiting for expected native evidence")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const input = (text: string) => [{ type: "text", text }];
const image = {
  type: "image_bytes",
  mediaType: "image/png",
  dataBase64: Buffer.from(png1x1()).toString("base64"),
};

for (const source of ["host", "thread"] as const) {
  test(`human queue receipts reject ${source} queued, admitted and cancelled identities`, async () => {
    const entered = deferred(),
      release = deferred();
    let samples = 0;
    const f = fixture({
      provider: `collision-${source}`,
      async *stream(): AsyncIterable<ModelEvent> {
        if (++samples === 1) {
          entered.resolve();
          await release.promise;
        }
        yield { type: "text_delta", delta: "done" };
      },
    });
    const target = await f.server.startThread();
    const active = await f.server.startTurn(target.id, "busy");
    await entered.promise;
    const client = connect(f);
    try {
      await client.rpc("zen/initialize");
      for (const state of ["queued", "admitted", "cancelled"] as const) {
        const clientId = `${source}-${state}`;
        if (source === "host") {
          await f.server.wakeTurn(
            target.id,
            {
              clientId,
              source: "trigger",
              sourceId: "trigger",
              text: "source context",
            },
            state === "admitted" ? {} : { mode: "queue" },
          );
        } else {
          await f.server.sendRemoteThreadMessage(
            target.id,
            {
              sender: {
                threadId: "remote-source",
                toolCallId: `tool-${state}`,
                callId: `call-${state}`,
              },
              text: "source context",
              ...(state === "admitted"
                ? {}
                : { messageType: "follow_up" as const }),
            },
            "paired-device",
            clientId,
          );
        }
        const snapshot = await f.server.readThread(target.id);
        const original = snapshot.items.find(
          (item) => "clientId" in item && item.clientId === clientId,
        );
        assert(original);
        assert.equal(
          original.type,
          `${source}_message${state === "admitted" ? "" : "_queued"}`,
        );
        if (state === "cancelled") {
          const cancelled = await f.server.cancelQueuedMessages(target.id, [
            { queuedItemId: original.id, clientId },
          ]);
          assert.equal(cancelled[0]?.status, "cancelled");
        }
        const before = (await f.server.readThread(target.id)).items;
        for (const mode of ["queue", "batch-next"]) {
          const reply = await bounded(
            client.rpc("zen/turn/send", {
              threadId: target.id,
              clientUserMessageId: clientId,
              mode,
              input: input("source context"),
            }),
          );
          assert("error" in reply, JSON.stringify(reply));
          assert.equal(
            (reply.error.data as { zenCode: string }).zenCode,
            "idempotency_conflict",
          );
          assert.equal(reply.error.code, -32602);
        }
        assert.deepEqual((await f.server.readThread(target.id)).items, before);
        if (state === "queued")
          await f.server.cancelQueuedMessages(target.id, [
            { queuedItemId: original.id, clientId },
          ]);
      }
      assert.equal(
        (await f.server.readThread(target.id)).items.some(
          (item) => item.type === "user_message_queued",
        ),
        false,
      );
    } finally {
      release.resolve();
      client.close();
    }
    await active.done;
  });
}

test("combined native omitted-mode image start and soft steer coexist with explicit image queue receipts", async () => {
  const entered = deferred(),
    release = deferred(),
    done = deferred();
  let samples = 0,
    completions = 0;
  const f = imageFixture({
    provider: "combined-inline",
    async *stream(): AsyncIterable<ModelEvent> {
      if (++samples === 1) {
        entered.resolve();
        await release.promise;
      }
      yield { type: "text_delta", delta: "done" };
    },
  });
  const target = await f.server.startThread();
  const client = connect(f);
  f.server.subscribe((event) => {
    if (event.type === "turn_completed" && ++completions === 2) done.resolve();
  });
  try {
    await client.rpc("zen/initialize");
    const started = accepted(
      await bounded(
        client.rpc("zen/turn/send", {
          threadId: target.id,
          clientUserMessageId: "start-image",
          input: [...input("start"), image],
        }),
      ),
    );
    assert(started.turnId);
    assert.equal(started.admission, undefined);
    await bounded(entered.promise);
    const steered = accepted(
      await bounded(
        client.rpc("zen/turn/send", {
          threadId: target.id,
          clientUserMessageId: "steer-image",
          input: [...input("steer"), image],
        }),
      ),
    );
    assert.equal(steered.turnId, started.turnId);
    assert.equal(steered.admission, undefined);
    const params = {
      threadId: target.id,
      clientUserMessageId: "queue-image",
      mode: "queue",
      input: [...input("queue"), image],
    };
    const queued = accepted(
      await bounded(client.rpc("zen/turn/send", params)),
    ).admission!;
    assert.equal(queued.state, "queued");
    assert(queued.queuedItemId);
    assert.equal(
      accepted(await client.rpc("zen/turn/send", params)).admission
        ?.queuedItemId,
      queued.queuedItemId,
    );
    const busy = await f.server.readThread(target.id);
    assert.equal(
      busy.items.filter((item) => item.type === "user_message").length,
      2,
    );
    assert.equal(
      busy.items.some((item) => item.type === "turn_aborted"),
      false,
    );
    assert.equal(
      busy.items.filter((item) => item.type === "user_message_queued").length,
      1,
    );
    release.resolve();
    await bounded(done.promise);
    const after = await f.server.readThread(target.id);
    const messages = after.items.filter((item) => item.type === "user_message");
    assert.equal(messages.length, 3);
    const consumed = messages.find((item) => item.clientId === "queue-image")!;
    assert.notEqual(consumed.turnId, started.turnId);
    assert.equal(textFromUserInput(consumed.content!), "queue");
    const hashes = messages.map(
      (item) =>
        item.content?.find((part) => part.type === "image")?.attachment.sha256,
    );
    assert(hashes[0]);
    assert.deepEqual(hashes, [hashes[0], hashes[0], hashes[0]]);
    assert.deepEqual(
      accepted(await client.rpc("zen/turn/send", params)).admission,
      { ...queued, state: "admitted", turnId: consumed.turnId },
    );
    assert.equal(after.turns.length, 2);
  } finally {
    release.resolve();
    client.close();
  }
});
