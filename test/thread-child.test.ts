import assert from "node:assert/strict";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHostedAppServer } from "../apps/cli/src/host.js";
import {
  InMemoryThreadJournal,
  JsonlThreadJournal,
  type ThreadJournal,
} from "../src/journal.js";
import { decodeCanonicalItem, type CanonicalItem } from "../src/item.js";
import { NativeConnection } from "../src/protocol/native/connection.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";
import type { JsonRpcMessage } from "../src/protocol/codex/wire.js";
import { JsonThreadSummaryProjection } from "../src/thread-summary.js";
import { InMemoryThreadSummaryProjection } from "../src/thread-summary.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";

function createHost(journal: ThreadJournal = new InMemoryThreadJournal()) {
  return createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: "/tmp/unused-thread-child",
    model: "fake",
    models: ["fake"],
    approvalPolicy: "never",
    provider: { type: "fake" },
    journal,
    threadMetadata: new InMemoryThreadMetadataStore(),
    threadSummaryProjection: new InMemoryThreadSummaryProjection(),
  });
}

test("fresh child inherits current parent configuration and survives reload and parent archive", async () => {
  const journal = new InMemoryThreadJournal();
  const host = createHost(journal);
  const parent = await host.startThread({
    sandbox: "read-only",
    approvalPolicy: "always",
  });
  const child = await host.createChildThread({
    parentThreadId: parent.id,
    mode: "fresh",
  });
  assert.equal(child.parentThreadId, parent.id);
  assert.equal(child.cwd, parent.cwd);
  assert.equal(child.modelId, parent.modelId);
  assert.equal(child.providerProfileId, parent.providerProfileId);
  assert.equal(child.reasoningEffort, parent.reasoningEffort);
  assert.equal(child.sandbox, "read-only");
  assert.equal(child.approvalPolicy, "always");
  assert.equal(child.items.length, 1);
  const metadata = child.items[0]!;
  assert.equal(metadata.type, "thread_metadata");
  assert.equal(
    decodeCanonicalItem(JSON.parse(JSON.stringify(metadata))).type,
    "thread_metadata",
  );
  await host.setThreadArchived(parent.id, true);
  assert.equal((await host.readThread(child.id)).archived, false);
  const nested = await host.createChildThread({
    parentThreadId: child.id,
    mode: "fresh",
  });
  assert.equal(nested.parentThreadId, child.id);
  await host.closeProviderTransport();

  const reloaded = createHost(journal);
  try {
    assert.equal(
      (await reloaded.readThread(child.id)).parentThreadId,
      parent.id,
    );
    assert.equal(
      (await reloaded.listThreadSummaries()).find(
        (entry) => entry.threadId === child.id,
      )?.parentThreadId,
      parent.id,
    );
  } finally {
    await reloaded.closeProviderTransport();
  }
});

test("fork child has its own relation while ordinary Copy clears inherited relations", async () => {
  const journal = new InMemoryThreadJournal();
  const host = createHost(journal);
  try {
    const parent = await host.startThread();
    await (
      await host.startTurn(parent.id, "parent history")
    ).done;
    const child = await host.createChildThread({
      parentThreadId: parent.id,
      mode: "fork",
    });
    assert.equal(child.parentThreadId, parent.id);
    assert(
      child.items.some(
        (item) =>
          item.type === "thread_forked" && item.sourceThreadId === parent.id,
      ),
    );
    assert(
      child.items.some(
        (item) =>
          item.type === "user_message" &&
          item.content?.[0]?.type === "text" &&
          item.content[0].text === "parent history",
      ),
    );
    const nested = await host.createChildThread({
      parentThreadId: child.id,
      mode: "fork",
    });
    assert.equal(nested.parentThreadId, child.id);
    const copy = await host.forkThread({
      sourceThreadId: nested.id,
      through: { type: "latest-complete" },
      workspace: { type: "same-directory" },
    });
    assert.equal(copy.parentThreadId, undefined);
    assert.equal(
      copy.items.find((item) => item.type === "thread_metadata")
        ?.parentThreadId,
      undefined,
    );
    assert.equal(
      (await host.listThreadSummaries()).find(
        (entry) => entry.threadId === copy.id,
      )?.parentThreadId,
      undefined,
    );
    const reloaded = createHost(journal);
    try {
      assert.equal(
        (await reloaded.readThread(nested.id)).parentThreadId,
        child.id,
      );
      assert.equal(
        (await reloaded.readThread(copy.id)).parentThreadId,
        undefined,
      );
      assert.equal(
        (await reloaded.listThreadSummaries()).find(
          (entry) => entry.threadId === copy.id,
        )?.parentThreadId,
        undefined,
      );
    } finally {
      await reloaded.closeProviderTransport();
    }
  } finally {
    await host.closeProviderTransport();
  }
});

test("child creation rejects missing parent and unavailable fork boundary without publishing a child", async () => {
  const journal = new InMemoryThreadJournal();
  const host = createHost(journal);
  try {
    const parent = await host.startThread();
    const ids = await journal.listThreadIds();
    await assert.rejects(
      host.createChildThread({ parentThreadId: "missing", mode: "fresh" }),
    );
    await assert.rejects(
      host.createChildThread({ parentThreadId: parent.id, mode: "fork" }),
      /complete Turn/,
    );
    assert.deepEqual(await journal.listThreadIds(), ids);
  } finally {
    await host.closeProviderTransport();
  }
});

test("failed fork journal creation publishes no child or relationship", async () => {
  class FailingJournal extends InMemoryThreadJournal {
    override async create(_items: readonly CanonicalItem[]): Promise<void> {
      throw new Error("injected create failure");
    }
  }
  const journal = new FailingJournal();
  const host = createHost(journal);
  try {
    const parent = await host.startThread();
    await (
      await host.startTurn(parent.id, "complete")
    ).done;
    const events: string[] = [];
    const dispose = host.subscribe((event) => {
      if (event.type === "thread_started") events.push(event.threadId);
    });
    await assert.rejects(
      host.createChildThread({ parentThreadId: parent.id, mode: "fork" }),
      /injected create failure/,
    );
    dispose();
    assert.deepEqual(events, []);
    assert.deepEqual(await journal.listThreadIds(), [parent.id]);
    assert.deepEqual(
      (await host.listThreadSummaries()).map((entry) => entry.threadId),
      [parent.id],
    );
  } finally {
    await host.closeProviderTransport();
  }
});

test("native-only child creation returns the canonical snapshot and rejects invalid requests", async () => {
  const host = createHost();
  const recovery = new NativeRecoveryProjection(host);
  const messages: JsonRpcMessage[] = [];
  const connection = new NativeConnection({
    appServer: host,
    projection: recovery,
    send: (message) => messages.push(message),
  });
  try {
    const parent = await host.startThread();
    await connection.receive({
      id: 1,
      method: "zen/thread/create-child",
      params: { parentThreadId: parent.id, mode: "fresh" },
    });
    assert("error" in messages.at(-1)!);
    await connection.receive({ id: 2, method: "zen/initialize", params: {} });
    await connection.receive({
      id: 3,
      method: "zen/thread/create-child",
      params: { parentThreadId: parent.id, mode: "fresh" },
    });
    const result = messages.at(-1)!;
    assert("result" in result);
    assert.equal(
      (result.result as { thread: { parentThreadId: string } }).thread
        .parentThreadId,
      parent.id,
    );
    await connection.receive({
      id: 4,
      method: "zen/thread/create-child",
      params: { parentThreadId: parent.id, mode: "unknown" },
    });
    assert("error" in messages.at(-1)!);
    await connection.receive({
      id: 5,
      method: "zen/thread/create-child",
      params: { parentThreadId: "missing", mode: "fresh" },
    });
    const failed = messages.at(-1)!;
    assert("error" in failed);
    assert(failed.error.data);
  } finally {
    connection.close();
    recovery.close();
    await host.closeProviderTransport();
  }
});

test("fresh child append failure is explicit and does not publish a child", async () => {
  class FailingJournal extends InMemoryThreadJournal {
    fail = false;
    override async append(item: CanonicalItem): Promise<void> {
      if (this.fail) throw new Error("injected append failure");
      await super.append(item);
    }
  }
  const journal = new FailingJournal();
  const host = createHost(journal);
  try {
    const parent = await host.startThread();
    journal.fail = true;
    const events: string[] = [];
    const dispose = host.subscribe((event) => {
      if (event.type === "thread_started") events.push(event.threadId);
    });
    await assert.rejects(
      host.createChildThread({ parentThreadId: parent.id, mode: "fresh" }),
      /injected append failure/,
    );
    dispose();
    assert.deepEqual(events, []);
    assert.deepEqual(await journal.listThreadIds(), [parent.id]);
    assert.deepEqual(
      (await host.listThreadSummaries()).map((entry) => entry.threadId),
      [parent.id],
    );
  } finally {
    await host.closeProviderTransport();
  }
});

test("JSONL reload and deleted summary cache derive child relations and ordinary Copy from canonical metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-child-journal-"));
  const projectionFile = path.join(directory, "summaries.json");
  const makeHost = () =>
    createHostedAppServer({
      cwd: directory,
      dataDirectory: directory,
      model: "fake",
      models: ["fake", "other"],
      approvalPolicy: "never",
      provider: { type: "fake" },
      journal: new JsonlThreadJournal(path.join(directory, "threads")),
      threadSummaryProjection: new JsonThreadSummaryProjection(projectionFile),
    });
  try {
    const host = makeHost();
    const parent = await host.startThread();
    await host.updateThreadSettings(parent.id, {
      model: "other",
    });
    await host.setThreadPermissions(parent.id, "workspace-write");
    const fresh = await host.createChildThread({
      parentThreadId: parent.id,
      mode: "fresh",
    });
    assert.equal(fresh.modelId, "other");
    assert.equal(fresh.sandbox, "workspace-write");
    assert.equal(fresh.approvalPolicy, "always");
    await (
      await host.startTurn(parent.id, "history")
    ).done;
    const fork = await host.createChildThread({
      parentThreadId: parent.id,
      mode: "fork",
    });
    const copy = await host.forkThread({
      sourceThreadId: fork.id,
      through: { type: "latest-complete" },
      workspace: { type: "same-directory" },
    });
    await host.closeProviderTransport();
    for (const rebuild of [false, true]) {
      if (rebuild) await unlink(projectionFile);
      const restored = makeHost();
      try {
        assert.equal(
          (await restored.readThread(fresh.id)).parentThreadId,
          parent.id,
        );
        assert.equal(
          (await restored.readThread(fork.id)).parentThreadId,
          parent.id,
        );
        assert.equal(
          (await restored.readThread(copy.id)).parentThreadId,
          undefined,
        );
        const summaries = await restored.listThreadSummaries();
        assert.equal(
          summaries.find((entry) => entry.threadId === fresh.id)
            ?.parentThreadId,
          parent.id,
        );
        assert.equal(
          summaries.find((entry) => entry.threadId === fork.id)?.parentThreadId,
          parent.id,
        );
        assert.equal(
          summaries.find((entry) => entry.threadId === copy.id)?.parentThreadId,
          undefined,
        );
      } finally {
        await restored.closeProviderTransport();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
