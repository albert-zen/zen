import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { ZenAppServer } from "../src/app-server.js";
import type { AttachmentStore } from "../src/attachment.js";
import type { CanonicalItem, UserInput } from "../src/item.js";
import { InMemoryThreadJournal, type ThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime, type RunTurnOptions } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ToolEnvironment } from "../src/tool.js";
import {
  pendingSteerMessages,
  recoverSteerRecall,
} from "../src/steer-recall.js";
import { NativeConnection } from "../src/protocol/native/connection.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import type { JsonRpcMessage } from "../src/protocol/codex/wire.js";

const text = (value: string): UserInput => [{ type: "text", text: value }];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function createServer(options: {
  journal: ThreadJournal;
  attachments?: AttachmentStore;
  runtime?: AgentRuntime;
  model?: ModelAdapter;
  images?: boolean;
}) {
  const model = options.model ?? {
    provider: "queue-edit",
    async *stream(): AsyncIterable<ModelEvent> {
      yield { type: "text_delta", delta: "done" };
    },
  };
  return new ZenAppServer({
    journal: options.journal,
    ...(options.attachments === undefined
      ? {}
      : { attachments: options.attachments }),
    runtime:
      options.runtime ??
      new AgentRuntime({
        toolEnvironment: new ToolEnvironment({ runtimes: [] }),
      }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          {
            id: "fake",
            isDefault: true,
            contextWindow: 32768,
            inputModalities:
              options.images === false ? ["text"] : ["text", "image"],
          },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: os.tmpdir(),
      providerProfileId: model.provider,
      modelId: "fake",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
}

async function running(failFirst = false) {
  const sampled = [deferred(), deferred()];
  const release = [deferred(), deferred()];
  const requests: ModelRequest[] = [];
  const model: ModelAdapter = {
    provider: "recall-live",
    async *stream(request) {
      const index = requests.length;
      requests.push(request);
      sampled[index]?.resolve();
      await Promise.race([
        release[index]?.promise ?? Promise.resolve(),
        new Promise<never>((_, reject) => {
          if (request.signal.aborted) reject(request.signal.reason);
          else
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            );
        }),
      ]);
      request.signal.throwIfAborted();
      if (index === 0 && failFirst)
        throw new Error("synthetic provider failure");
      yield { type: "text_delta", delta: "done" };
    },
  };
  const journal = new InMemoryThreadJournal();
  const server = createServer({ journal, model });
  const thread = await server.startThread();
  const turn = await server.startTurn(thread.id, "initial", {
    clientId: "initial",
  });
  void turn.done.catch(() => undefined);
  await sampled[0]!.promise;
  return {
    journal,
    server,
    threadId: thread.id,
    turn,
    sampled,
    release,
    requests,
  };
}
function userIdsInTurn(items: readonly CanonicalItem[], turnId: string) {
  return items.flatMap((item) =>
    item.type === "user_message" && item.turnId === turnId
      ? [item.clientId]
      : [],
  );
}
function snapshotTargets(items: Parameters<typeof pendingSteerMessages>[0]) {
  return pendingSteerMessages(items).map((item) => ({
    queuedItemId: item.id,
    clientId: item.clientId,
    expectedRevision: item.revision,
  }));
}

test(
  "pending native-human steer is admitted without ItemList input and recalled before claim",
  { timeout: 10000 },
  async () => {
    const f = await running();
    try {
      const admitted = await f.server.sendMessage(f.threadId, "steer-one", {
        clientId: "one",
        recallableSteer: true,
      });
      assert.equal(admitted.admission?.state, "queued");
      const before = await f.server.readThread(f.threadId);
      assert.equal(pendingSteerMessages(before.items).length, 1);
      assert(
        !before.items.some(
          (item) => item.type === "user_message" && item.clientId === "one",
        ),
      );
      assert(!JSON.stringify(before.itemList).includes("steer-one"));
      await f.server.recallSteerMessages(f.threadId, {
        recallId: "recall",
        targets: snapshotTargets(before.items),
      });
      await assert.rejects(
        f.server.sendMessage(f.threadId, "steer-one", {
          clientId: "one",
          recallableSteer: true,
        }),
        { code: "queue_id_cancelled" },
      );
      f.release[0]!.resolve();
      await f.turn.done;
      assert.equal(f.requests.length, 1);
    } finally {
      for (const gate of f.release) gate.resolve();
      await f.turn.done.catch(() => undefined);
    }
  },
);

test(
  "normal final continues same Turn, claims once, and fences late recall",
  { timeout: 10000 },
  async () => {
    const f = await running();
    try {
      await f.server.stageSteerMessage(f.threadId, f.turn.id, "steer-two", {
        clientId: "two",
      });
      const pending = await f.server.readThread(f.threadId);
      const targets = snapshotTargets(pending.items);
      f.release[0]!.resolve();
      await f.sampled[1]!.promise;
      const claimed = await f.server.readThread(f.threadId);
      assert.equal(pendingSteerMessages(claimed.items).length, 0);
      assert.equal(
        claimed.items.filter((item) => item.type === "turn_started").length,
        1,
      );
      assert.equal(
        claimed.items.filter(
          (item) => item.type === "user_message" && item.clientId === "two",
        ).length,
        1,
      );
      assert(JSON.stringify(f.requests[1]!.messages).includes("steer-two"));
      await assert.rejects(
        f.server.recallSteerMessages(f.threadId, { recallId: "late", targets }),
        { code: "steer_recall_conflict" },
      );
      const duplicate = await f.server.stageSteerMessage(
        f.threadId,
        f.turn.id,
        "steer-two",
        { clientId: "two" },
      );
      assert.equal(duplicate.admission?.state, "admitted");
    } finally {
      for (const gate of f.release) gate.resolve();
      await f.turn.done.catch(() => undefined);
    }
  },
);

for (const ending of ["stop", "error"] as const)
  test(
    `${ending} holds pending input without scheduling; explicit successor carries it before fresh input`,
    { timeout: 10000 },
    async () => {
      const f = await running(ending === "error");
      try {
        await f.server.stageSteerMessage(f.threadId, f.turn.id, "held-first", {
          clientId: "held-1",
        });
        await f.server.stageSteerMessage(f.threadId, f.turn.id, "held-second", {
          clientId: "held-2",
        });
        if (ending === "stop")
          await f.server
            .interruptTurn(f.threadId, f.turn.id)
            .catch(() => undefined);
        else {
          f.release[0]!.resolve();
          await f.turn.done.catch(() => undefined);
        }
        await f.server.resumeQueue(f.threadId);
        await setImmediate();
        assert.equal(f.requests.length, 1);
        assert.equal(
          pendingSteerMessages((await f.server.readThread(f.threadId)).items)
            .length,
          2,
        );
        const next = await f.server.startTurn(f.threadId, "fresh-input", {
          clientId: "fresh",
        });
        await f.sampled[1]!.promise;
        const after = await f.server.readThread(f.threadId);
        const order = userIdsInTurn(after.items, next.id);
        assert.deepEqual(order, ["held-1", "held-2", "fresh"]);
        assert.equal(pendingSteerMessages(after.items).length, 0);
        f.release[1]!.resolve();
        await next.done;
      } finally {
        for (const gate of f.release) gate.resolve();
        await f.turn.done.catch(() => undefined);
      }
    },
  );

test(
  "legacy core steer keeps its immediate nonrecallable compatibility semantics",
  { timeout: 10000 },
  async () => {
    const f = await running();
    try {
      await f.server.steerTurn(f.threadId, f.turn.id, "legacy");
      const thread = await f.server.readThread(f.threadId);
      assert.equal(pendingSteerMessages(thread.items).length, 0);
      assert(JSON.stringify(thread.itemList).includes("legacy"));
    } finally {
      for (const gate of f.release) gate.resolve();
      await f.turn.done.catch(() => undefined);
    }
  },
);

test(
  "both native ordinary and explicit steer enter the same staged Core path",
  { timeout: 10000 },
  async () => {
    const f = await running();
    const projection = new NativeRecoveryProjection(f.server);
    const messages: JsonRpcMessage[] = [];
    const connection = new NativeConnection({
      appServer: f.server,
      projection,
      send: (message) => {
        messages.push(message);
      },
    });
    try {
      await connection.receive({
        id: "init",
        method: "zen/initialize",
        params: {},
      });
      for (const mode of [undefined, "steer"] as const) {
        const id = mode ?? "ordinary";
        await connection.receive({
          id,
          method: "zen/turn/send",
          params: {
            threadId: f.threadId,
            clientUserMessageId: id,
            input: text(id),
            ...(mode === undefined ? {} : { mode, expectedTurnId: f.turn.id }),
          },
        });
        const response = messages.find(
          (message) =>
            "id" in message && message.id === id && "result" in message,
        );
        assert(response && "result" in response);
        assert.equal(
          (response.result as { admission?: { state: string } }).admission
            ?.state,
          "queued",
        );
      }
      const snapshot = await f.server.readThread(f.threadId);
      assert.equal(pendingSteerMessages(snapshot.items).length, 2);
      await f.server.recallSteerMessages(f.threadId, {
        recallId: "native",
        targets: snapshotTargets(snapshot.items),
      });
    } finally {
      connection.close();
      projection.close();
      for (const gate of f.release) gate.resolve();
      await f.turn.done.catch(() => undefined);
    }
  },
);

test(
  "explicit Retry is not blocked by held steer and includes it before continuation",
  { timeout: 10000 },
  async () => {
    const f = await running();
    try {
      await f.server.stageSteerMessage(
        f.threadId,
        f.turn.id,
        "held-before-retry",
        { clientId: "held" },
      );
      await f.server
        .interruptTurn(f.threadId, f.turn.id)
        .catch(() => undefined);
      const next = await f.server.retryTurn(f.threadId, f.turn.id, "en", {
        clientId: "retry",
      });
      await f.sampled[1]!.promise;
      const after = await f.server.readThread(f.threadId);
      const order = userIdsInTurn(after.items, next.id);
      assert.deepEqual(order, ["held", "retry"]);
      f.release[1]!.resolve();
      await next.done;
    } finally {
      for (const gate of f.release) gate.resolve();
      await f.turn.done.catch(() => undefined);
    }
  },
);

test(
  "explicit Replace carries staged input before replacement, without reviving its Turn",
  { timeout: 10000 },
  async () => {
    const f = await running();
    try {
      await f.server.stageSteerMessage(
        f.threadId,
        f.turn.id,
        "held-before-replace",
        { clientId: "held" },
      );
      const replacement = await f.server.replaceTurn(
        f.threadId,
        f.turn.id,
        "replacement",
        { clientId: "replacement" },
      );
      await f.sampled[1]!.promise;
      assert.notEqual(replacement.turn.id, f.turn.id);
      const after = await f.server.readThread(f.threadId);
      const order = userIdsInTurn(after.items, replacement.turn.id);
      assert.deepEqual(order, ["held", "replacement"]);
      f.release[1]!.resolve();
      await replacement.turn.done;
    } finally {
      for (const gate of f.release) gate.resolve();
      await f.turn.done.catch(() => undefined);
    }
  },
);

test(
  "restored crash snapshot stays held until explicit successor admission",
  { timeout: 10000 },
  async () => {
    const f = await running();
    try {
      await f.server.stageSteerMessage(f.threadId, f.turn.id, "crash-held", {
        clientId: "held",
      });
      const persisted = await f.journal.read(f.threadId);
      const restored = new InMemoryThreadJournal();
      await restored.create(persisted);
      let calls = 0;
      const cold = createServer({
        journal: restored,
        model: {
          provider: "recall-live",
          async *stream() {
            calls++;
            yield { type: "text_delta", delta: "done" };
          },
        },
      });
      await cold.readThread(f.threadId);
      await cold.resumeQueue(f.threadId);
      assert.equal(calls, 0);
      assert.equal(
        pendingSteerMessages(await restored.read(f.threadId)).length,
        1,
      );
      const next = await cold.startTurn(f.threadId, "fresh", {
        clientId: "fresh",
      });
      await next.done;
      const order = userIdsInTurn(await restored.read(f.threadId), next.id);
      assert.deepEqual(order, ["held", "fresh"]);
      assert.equal(calls, 1);
    } finally {
      for (const gate of f.release) gate.resolve();
      await f.turn.done.catch(() => undefined);
    }
  },
);

test(
  "initial admission wait does not block recallable steer acceptance",
  { timeout: 10000 },
  async () => {
    const entered = deferred();
    const release = deferred();
    const journal = new InMemoryThreadJournal();
    const runtime = new (class extends AgentRuntime {
      override async runTurn(options: RunTurnOptions) {
        entered.resolve();
        await release.promise;
        await super.runTurn(options);
      }
    })({ toolEnvironment: new ToolEnvironment({ runtimes: [] }) });
    const server = createServer({ journal, runtime });
    const thread = await server.startThread();
    const starting = server.startTurn(thread.id, "initial", {
      clientId: "initial",
    });
    try {
      await entered.promise;
      const staged = await server.sendMessage(
        thread.id,
        "during initial wait",
        {
          clientId: "early",
          recallableSteer: true,
        },
      );
      assert.equal(staged.admission?.state, "queued");
      const before = await server.readThread(thread.id);
      assert.equal(pendingSteerMessages(before.items).length, 1);
      assert(!before.items.some((item) => item.type === "user_message"));
      release.resolve();
      const turn = await starting;
      await turn.done;
      const after = await server.readThread(thread.id);
      assert.deepEqual(userIdsInTurn(after.items, turn.id), [
        "initial",
        "early",
      ]);
    } finally {
      release.resolve();
      const turn = await starting;
      await turn.done.catch(() => undefined);
    }
  },
);

test(
  "human pending bursts are all claimed by the next sample, not split by guidance quota",
  { timeout: 10000 },
  async () => {
    const f = await running();
    try {
      for (let index = 0; index < 12; index++)
        await f.server.stageSteerMessage(
          f.threadId,
          f.turn.id,
          `burst-${index}`,
          { clientId: `burst-${index}` },
        );
      f.release[0]!.resolve();
      await f.sampled[1]!.promise;
      const after = await f.server.readThread(f.threadId);
      assert.deepEqual(pendingSteerMessages(after.items), []);
      const ids = userIdsInTurn(after.items, f.turn.id);
      assert.equal(ids.length, 13);
      for (let index = 0; index < 12; index++)
        assert(
          JSON.stringify(f.requests[1]!.messages).includes(`burst-${index}`),
        );
      f.release[1]!.resolve();
      await f.turn.done;
      assert.equal(f.requests.length, 2);
    } finally {
      for (const gate of f.release) gate.resolve();
      await f.turn.done.catch(() => undefined);
    }
  },
);

test(
  "automatic queued successor does not claim held human steer",
  { timeout: 10000 },
  async () => {
    const f = await running();
    try {
      await f.server.stageSteerMessage(f.threadId, f.turn.id, "held-private", {
        clientId: "held",
      });
      await f.server.interruptTurn(f.threadId, f.turn.id);
      await f.server.queueMessage(f.threadId, "queued-next", "queued");
      await f.sampled[1]!.promise;
      const after = await f.server.readThread(f.threadId);
      assert.equal(pendingSteerMessages(after.items).length, 1);
      assert(!JSON.stringify(f.requests[1]!.messages).includes("held-private"));
      assert(JSON.stringify(f.requests[1]!.messages).includes("queued-next"));
      f.release[1]!.resolve();
      await setImmediate();
    } finally {
      for (const gate of f.release) gate.resolve();
      await f.turn.done.catch(() => undefined);
    }
  },
);

test(
  "fork remaps recall receipt anchors without changing parent recovery",
  { timeout: 10000 },
  async () => {
    const f = await running();
    try {
      await f.server.stageSteerMessage(f.threadId, f.turn.id, "fork-recalled", {
        clientId: "fork-pending",
      });
      const pending = await f.server.readThread(f.threadId);
      await f.server.recallSteerMessages(f.threadId, {
        recallId: "fork-receipt",
        targets: snapshotTargets(pending.items),
      });
      f.release[0]!.resolve();
      await f.turn.done;
      const parent = await f.server.readThread(f.threadId);
      const child = await f.server.forkThread({
        sourceThreadId: f.threadId,
        through: { type: "latest-complete" },
        workspace: { type: "same-directory" },
      });
      const recovered = recoverSteerRecall(
        child.items,
        child.id,
        "fork-receipt",
      );
      assert(recovered);
      assert.equal(recovered.messages.length, 1);
      assert.equal(recovered.messages[0]!.threadId, child.id);
      assert.notEqual(
        recovered.messages[0]!.id,
        pendingSteerMessages(pending.items)[0]!.id,
      );
      assert.deepEqual(
        (await f.server.readThread(f.threadId)).items,
        parent.items,
      );
      assert(recoverSteerRecall(parent.items, f.threadId, "fork-receipt"));
    } finally {
      for (const gate of f.release) gate.resolve();
      await f.turn.done.catch(() => undefined);
    }
  },
);

for (const winner of ["claim", "recall"] as const)
  test(
    `simultaneous claim and recall serialize with ${winner} first`,
    { timeout: 10000 },
    async () => {
      const f = await running();
      const entered = deferred();
      const releaseCommit = deferred();
      const append = f.journal.append.bind(f.journal);
      try {
        await f.server.stageSteerMessage(f.threadId, f.turn.id, "race-input", {
          clientId: "race",
        });
        const targets = snapshotTargets(
          (await f.server.readThread(f.threadId)).items,
        );
        f.journal.append = async (item) => {
          if (
            (winner === "claim" &&
              item.type === "user_message" &&
              item.clientId === "race") ||
            (winner === "recall" &&
              item.type === "user_message_steer_recalled")
          ) {
            entered.resolve();
            await releaseCommit.promise;
          }
          return await append(item);
        };
        const recall = () =>
          f.server.recallSteerMessages(f.threadId, {
            recallId: "race-receipt",
            targets,
          });
        let withdrawal: ReturnType<typeof recall>;
        if (winner === "recall") {
          withdrawal = recall();
          await entered.promise;
          f.release[0]!.resolve();
        } else {
          f.release[0]!.resolve();
          await entered.promise;
          withdrawal = recall();
        }
        const outcome = withdrawal.then(
          () => "recalled",
          () => "conflict",
        );
        await setImmediate();
        releaseCommit.resolve();
        assert.equal(
          await outcome,
          winner === "recall" ? "recalled" : "conflict",
        );
        if (winner === "claim") await f.sampled[1]!.promise;
        f.release[1]!.resolve();
        await f.turn.done;
        const after = await f.server.readThread(f.threadId);
        assert.equal(
          after.items.some(
            (item) => item.type === "user_message" && item.clientId === "race",
          ),
          winner === "claim",
        );
        assert.equal(
          after.items.some(
            (item) => item.type === "user_message_steer_recalled",
          ),
          winner === "recall",
        );
      } finally {
        releaseCommit.resolve();
        for (const gate of f.release) gate.resolve();
        await f.turn.done.catch(() => undefined);
      }
    },
  );
