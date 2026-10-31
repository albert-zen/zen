import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { AppServerError, ZenAppServer } from "../src/app-server.js";
import type { CanonicalItem } from "../src/item.js";
import {
  InMemoryThreadJournal,
  ThreadJournalAppendOutcomeUnknownError,
} from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { Thread } from "../src/thread.js";
import { ShellToolRuntime, ToolEnvironment } from "../src/tool.js";

// Synthetic in-memory journal contract tests, not filesystem durability or UI paint measurements.
class HistoryBudgetRuntime extends AgentRuntime {
  override projectToolPresentation(
    items: readonly CanonicalItem[],
    agentic: boolean,
  ) {
    const snapshot = super.projectToolPresentation(items, agentic);
    return {
      ...snapshot,
      modelTools: snapshot.modelTools.map((tool) => ({
        name: tool.name,
        description: "",
        inputSchema: {},
      })),
    };
  }
}
function runtime() {
  return new HistoryBudgetRuntime({
    toolEnvironment: new ToolEnvironment({
      runtimes: [new ShellToolRuntime()],
    }),
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("operation blocked behind synthetic summary")),
          1500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function serverWith(journal: InMemoryThreadJournal, model: ModelAdapter) {
  return new ZenAppServer({
    journal,
    runtime: runtime(),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          { id: "recording-model", isDefault: true, contextWindow: 1000 },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: os.tmpdir(),
      providerProfileId: model.provider,
      modelId: "recording-model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    contextCompaction: { includeOriginalReference: false },
  });
}
async function preparing(failSummary = false) {
  const journal = new InMemoryThreadJournal();
  const summaryStarted = deferred();
  const releaseSummary = deferred();
  const normalRequests: ModelRequest[] = [];
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (request.debugContext?.purpose === "compaction") {
        summaryStarted.resolve();
        if (request.signal.aborted) throw request.signal.reason;
        await Promise.race([
          releaseSummary.promise,
          new Promise<never>((_, reject) =>
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            ),
          ),
        ]);
        request.signal.throwIfAborted();
        if (failSummary) throw new Error("synthetic summary unavailable");
        yield { type: "text_delta", delta: "synthetic summary" };
        return;
      }
      normalRequests.push(request);
      yield {
        type: "text_delta",
        delta:
          normalRequests.length === 1
            ? "synthetic history ".repeat(300)
            : "synthetic answer",
      };
    },
  };
  const server = serverWith(journal, model);
  const thread = await server.startThread();
  await (
    await server.sendMessage(thread.id, "first", { clientId: "first" })
  ).done;
  const second = await bounded(
    server.sendMessage(thread.id, "second", { clientId: "second" }),
  );
  await bounded(summaryStarted.promise);
  return {
    journal,
    server,
    thread,
    second,
    normalRequests,
    model,
    releaseSummary,
  };
}

test("summary preparation permits exact duplicate, steer and queue admission without a main sample", async () => {
  const f = await preparing();
  try {
    const duplicate = await bounded(
      f.server.sendMessage(f.thread.id, "second", { clientId: "second" }),
    );
    assert.equal(duplicate.id, f.second.id);
    await bounded(
      f.server.steerTurn(f.thread.id, f.second.id, "late steering", {
        clientId: "steer",
      }),
    );
    await bounded(
      f.server.queueMessage(f.thread.id, "next queued", "queued", {
        waitForTurnAdmission: false,
      }),
    );
    const items = await f.journal.read(f.thread.id);
    assert.equal(
      items.filter(
        (item) => item.type === "user_message" && item.clientId === "second",
      ).length,
      1,
    );
    assert(
      items.some(
        (item) => item.type === "user_message" && item.clientId === "steer",
      ),
    );
    const queued = items.find(
      (item) =>
        item.type === "user_message_queued" && item.clientId === "queued",
    );
    assert(queued?.type === "user_message_queued");
    await bounded(
      f.server.cancelQueuedMessages(f.thread.id, [
        { queuedItemId: queued.id, clientId: queued.clientId },
      ]),
    );
    assert.equal(f.normalRequests.length, 1);
    f.releaseSummary.resolve();
    await bounded(f.second.done);
    assert.match(
      JSON.stringify(f.normalRequests[1]?.messages),
      /late steering/,
    );
    const after = await f.journal.read(f.thread.id);
    const compaction = after.find((item) => item.type === "context_compaction");
    assert(compaction?.type === "context_compaction");
    const boundary = after.findIndex(
      (item) => item.id === compaction.coveredThroughItemId,
    );
    assert(
      after.findIndex(
        (item) => item.type === "user_message" && item.clientId === "second",
      ) > boundary,
    );
    assert(
      after.findIndex(
        (item) => item.type === "user_message" && item.clientId === "steer",
      ) > boundary,
    );
  } finally {
    f.releaseSummary.resolve();
    await f.server.stopActiveTurns();
  }
});

test("interrupting admitted preparation preserves input and records interruption without main sampling", async () => {
  const f = await preparing();
  try {
    await bounded(f.server.interruptTurn(f.thread.id, f.second.id));
    const items = await f.journal.read(f.thread.id);
    assert(
      items.some(
        (item) => item.type === "user_message" && item.clientId === "second",
      ),
    );
    assert(
      items.some(
        (item) => item.type === "turn_aborted" && item.turnId === f.second.id,
      ),
    );
    assert.equal(f.normalRequests.length, 1);
  } finally {
    f.releaseSummary.resolve();
    await f.server.stopActiveTurns();
  }
});

test("summary rejection after admission records failed turn and retains the exact message identity", async () => {
  const f = await preparing(true);
  try {
    f.releaseSummary.resolve();
    await bounded(f.second.done);
    const items = await f.journal.read(f.thread.id);
    assert.equal(
      items.filter(
        (item) => item.type === "user_message" && item.clientId === "second",
      ).length,
      1,
    );
    assert(
      items.some(
        (item) =>
          item.type === "turn_completed" &&
          item.turnId === f.second.id &&
          item.status === "failed",
      ),
    );
    assert.equal(f.normalRequests.length, 1);
    const duplicate = await f.server.sendMessage(f.thread.id, "second", {
      clientId: "second",
    });
    assert.equal(duplicate.id, f.second.id);
    assert.equal(f.normalRequests.length, 1);
  } finally {
    f.releaseSummary.resolve();
    await f.server.stopActiveTurns();
  }
});

test("restart recovery preserves admitted preparation input and never replays the prior operation", async () => {
  const f = await preparing();
  try {
    const recoveredJournal = new InMemoryThreadJournal();
    const snapshot = await f.journal.read(f.thread.id);
    await recoveredJournal.create(snapshot);
    const recoveredThread = new Thread(f.thread.id, snapshot);
    await runtime().reconcileInterruptedHistory(
      recoveredThread,
      async (item) => {
        await recoveredJournal.append(item);
        recoveredThread.append(item);
      },
    );
    const recovered = serverWith(recoveredJournal, f.model);
    const duplicate = await recovered.sendMessage(f.thread.id, "second", {
      clientId: "second",
    });
    assert.equal(duplicate.id, f.second.id);
    await duplicate.done;
    const items = await recoveredJournal.read(f.thread.id);
    assert.equal(
      items.filter(
        (item) => item.type === "user_message" && item.clientId === "second",
      ).length,
      1,
    );
    assert(
      items.some(
        (item) => item.type === "turn_aborted" && item.turnId === f.second.id,
      ),
    );
    assert.equal(f.normalRequests.length, 1);
    await recovered.stopActiveTurns();
  } finally {
    f.releaseSummary.resolve();
    await f.server.stopActiveTurns();
  }
});

async function eagerPreparation(
  options: { failSummary?: boolean; unknownAppend?: boolean } = {},
) {
  class Journal extends InMemoryThreadJournal {
    override async append(item: CanonicalItem): Promise<void> {
      await super.append(item);
      if (options.unknownAppend && item.type === "context_compaction")
        throw new ThreadJournalAppendOutcomeUnknownError(
          new Error("synthetic unknown compaction append"),
        );
    }
  }
  const journal = new Journal();
  const summaryStarted = deferred();
  const releaseSummary = deferred();
  const summaryExited = deferred();
  const normalRequests: ModelRequest[] = [];
  let summaryCalls = 0;
  const model: ModelAdapter = {
    provider: "recording",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (request.debugContext?.purpose === "compaction") {
        summaryCalls++;
        summaryStarted.resolve();
        try {
          request.signal.throwIfAborted();
          await Promise.race([
            releaseSummary.promise,
            new Promise<never>((_, reject) =>
              request.signal.addEventListener(
                "abort",
                () => reject(request.signal.reason),
                { once: true },
              ),
            ),
          ]);
          request.signal.throwIfAborted();
          if (options.failSummary)
            throw new Error("synthetic eager summary unavailable");
          yield { type: "text_delta", delta: "synthetic summary" };
        } finally {
          summaryExited.resolve();
        }
        return;
      }
      normalRequests.push(request);
      yield { type: "text_delta", delta: "synthetic answer" };
      if (normalRequests.length === 1)
        yield { type: "usage", inputTokens: 800, outputTokens: 1 };
    },
  };
  const server = serverWith(journal, model);
  const thread = await server.startThread();
  const first = await server.sendMessage(thread.id, "first", {
    clientId: "first",
  });
  await bounded(summaryStarted.promise);
  await bounded(first.done);
  return {
    journal,
    server,
    thread,
    first,
    normalRequests,
    releaseSummary,
    summaryExited,
    summaryCalls: () => summaryCalls,
  };
}

test("eager summary is owned independently of completed turn and permits ingress but rejects explicit overlap", async () => {
  const f = await eagerPreparation();
  try {
    await assert.rejects(
      f.server.compactThread(f.thread.id),
      (error) =>
        error instanceof AppServerError && error.code === "thread_busy",
    );
    const second = await bounded(
      f.server.sendMessage(f.thread.id, "second", { clientId: "second" }),
    );
    const duplicate = await bounded(
      f.server.sendMessage(f.thread.id, "second", { clientId: "second" }),
    );
    assert.equal(duplicate.id, second.id);
    await bounded(
      f.server.steerTurn(f.thread.id, second.id, "late steering", {
        clientId: "steer",
      }),
    );
    const items = await f.journal.read(f.thread.id);
    assert(
      items.some(
        (item) =>
          item.type === "turn_completed" &&
          item.turnId === f.first.id &&
          item.status === "completed",
      ),
    );
    assert.equal(
      items.filter(
        (item) => item.type === "user_message" && item.clientId === "second",
      ).length,
      1,
    );
    assert(
      items.some(
        (item) => item.type === "user_message" && item.clientId === "steer",
      ),
    );
    assert.equal(f.normalRequests.length, 1);
    f.releaseSummary.resolve();
    await bounded(second.done);
    assert.equal(f.summaryCalls(), 1);
    assert.match(
      JSON.stringify(f.normalRequests[1]?.messages),
      /late steering/,
    );
  } finally {
    f.releaseSummary.resolve();
    await f.server.closeRuntimeConfiguration();
  }
});

test("close aborts and joins eager summary and admitted waiting turn without main sampling", async () => {
  const f = await eagerPreparation();
  try {
    const second = await bounded(
      f.server.sendMessage(f.thread.id, "second", { clientId: "second" }),
    );
    await bounded(f.server.closeRuntimeConfiguration());
    await bounded(f.summaryExited.promise);
    await bounded(second.done);
    assert.equal(f.normalRequests.length, 1);
    const items = await f.journal.read(f.thread.id);
    assert(
      items.some(
        (item) => item.type === "turn_aborted" && item.turnId === second.id,
      ),
    );
    assert(
      items.some(
        (item) =>
          item.type === "turn_completed" &&
          item.turnId === f.first.id &&
          item.status === "completed",
      ),
    );
  } finally {
    f.releaseSummary.resolve();
  }
});

test("eager summary failure is reported without changing completed turn or replaying input", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args);
  });
  const f = await eagerPreparation({ failSummary: true });
  try {
    const second = await bounded(
      f.server.sendMessage(f.thread.id, "second", { clientId: "second" }),
    );
    f.releaseSummary.resolve();
    await bounded(second.done);
    const items = await f.journal.read(f.thread.id);
    assert.equal(warnings.length, 1);
    assert.match(
      String(warnings[0]?.[0]),
      /Could not automatically compact completed Turn/,
    );
    assert(
      items.some(
        (item) =>
          item.type === "turn_completed" &&
          item.turnId === f.first.id &&
          item.status === "completed",
      ),
    );
    assert.equal(
      items.filter(
        (item) => item.type === "user_message" && item.clientId === "second",
      ).length,
      1,
    );
    // The next input rechecks its required context preparation. A second
    // definitive summary failure fails that new turn, never the completed one.
    assert(
      items.some(
        (item) =>
          item.type === "turn_completed" &&
          item.turnId === second.id &&
          item.status === "failed",
      ),
    );
    assert.equal(f.normalRequests.length, 1);
    assert.equal(f.summaryCalls(), 2);
  } finally {
    f.releaseSummary.resolve();
    await f.server.closeRuntimeConfiguration();
  }
});

test("unknown eager summary append blocks waiting sample and is surfaced again on shutdown without replay", async () => {
  const f = await eagerPreparation({ unknownAppend: true });
  const second = await bounded(
    f.server.sendMessage(f.thread.id, "second", { clientId: "second" }),
  );
  // Attach outcome observation before releasing the independently owned operation.
  const failed = assert.rejects(
    second.done,
    ThreadJournalAppendOutcomeUnknownError,
  );
  f.releaseSummary.resolve();
  await bounded(failed);
  assert.equal(f.normalRequests.length, 1);
  assert.equal(f.summaryCalls(), 1);
  const items = await f.journal.read(f.thread.id);
  assert.equal(
    items.filter(
      (item) => item.type === "user_message" && item.clientId === "second",
    ).length,
    1,
  );
  assert.equal(
    items.filter((item) => item.type === "context_compaction").length,
    1,
  );
  await assert.rejects(f.server.closeRuntimeConfiguration(), AggregateError);
  assert.equal(f.summaryCalls(), 1);
});

test("archiving does not let deletion invalidate an owned eager summary and close prevents later dispatch", async () => {
  const f = await eagerPreparation();
  try {
    const archived = await bounded(
      f.server.setThreadArchived(f.thread.id, true),
    );
    assert.equal(archived.archived, true);
    await assert.rejects(
      f.server.deleteThread(f.thread.id, archived.items.at(-1)!.id),
      (error) =>
        error instanceof AppServerError && error.code === "thread_busy",
    );
    assert.equal(
      (await f.journal.read(f.thread.id)).some(
        (item) => item.type === "thread_deleted",
      ),
      false,
    );
    await bounded(f.server.closeRuntimeConfiguration());
    await bounded(f.summaryExited.promise);
    f.releaseSummary.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.summaryCalls(), 1);
    assert.equal(f.normalRequests.length, 1);
    assert.equal(
      (await f.journal.read(f.thread.id)).some(
        (item) => item.type === "context_compaction",
      ),
      false,
    );
    await assert.rejects(
      f.server.sendMessage(f.thread.id, "after close", {
        clientId: "after-close",
      }),
      (error) =>
        error instanceof AppServerError && error.code === "host_restarting",
    );
    assert.equal(f.normalRequests.length, 1);
  } finally {
    f.releaseSummary.resolve();
    await f.server.stopActiveTurns();
  }
});
