import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenAppServer, type AppServerEvent } from "../src/app-server.js";
import { JsonlThreadJournal } from "../src/journal.js";
import type { ThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { FakeModel, type ModelAdapter } from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import {
  projectCompletedItem,
  projectThreadSummary,
} from "../src/protocol/codex/mapper.js";
import { AgentRuntime } from "../src/runtime.js";
import { JsonlThreadMetadataStore } from "../src/thread-metadata.js";
import {
  JsonThreadSummaryProjection,
  isNativeThreadSummary,
} from "../src/thread-summary.js";
import { ShellToolRuntime, ToolEnvironment } from "../src/tool.js";
import { isTurnEndItem, turnEndPosition } from "../src/turn-end.js";
import { NativeRecoveryProjection } from "../src/protocol/native/recovery.js";

function createServer(
  directory: string,
  journal?: ThreadJournal,
  model: ModelAdapter = new FakeModel(),
): ZenAppServer {
  const modelCatalog = new StaticModelCatalog([
    { id: "fake", isDefault: true, contextWindow: 32_768 },
    { id: "other", contextWindow: 32_768 },
  ]);
  return new ZenAppServer({
    journal: journal ?? new JsonlThreadJournal(path.join(directory, "threads")),
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({
        runtimes: [new ShellToolRuntime()],
      }),
    }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog,
      },
    ]),
    threadMetadata: new JsonlThreadMetadataStore(
      path.join(directory, "thread-metadata.jsonl"),
    ),
    threadSummaryProjection: new JsonThreadSummaryProjection(
      path.join(directory, "thread-summaries.json"),
    ),
    defaults: {
      cwd: directory,
      providerProfileId: model.provider,
      modelId: "fake",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
}

test("rebuilds native summaries and follows canonical and product metadata changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-summary-"));
  try {
    const server = createServer(directory);
    const started = await server.startThread();
    await server.updateThreadSettings(started.id, { model: "other" });
    await server.setThreadName(started.id, "Release planning");
    await server.setThreadArchived(started.id, true);

    const archived = await server.listThreadSummaries({ archived: true });
    assert.equal(archived.length, 1);
    assert.deepEqual(archived[0], {
      threadId: started.id,
      lastItemId: (await server.readThread(started.id)).items.at(-1)?.id,
      currentMetadata: {
        providerProfileId: "fake",
        modelId: "other",
        reasoningEffort: "medium",
        model: "other",
        provider: "fake",
        cwd: directory,
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
      name: "Release planning",
      archived: true,
      createdAt: started.items[0]?.createdAt,
      updatedAt: archived[0]?.updatedAt,
      turnSortAt: started.items[0]?.createdAt,
      preview: "",
      status: "idle",
    });

    await unlink(path.join(directory, "thread-summaries.json"));
    const rebuilt = await createServer(directory).listThreadSummaries({
      archived: true,
    });
    assert.deepEqual(rebuilt, archived);

    const projectionFile = path.join(directory, "thread-summaries.json");
    const staleProjection = JSON.parse(
      await readFile(projectionFile, "utf8"),
    ) as { summaries: Array<{ currentMetadata?: { model?: string } }> };
    staleProjection.summaries[0]!.currentMetadata!.model = "fake";
    await writeFile(projectionFile, JSON.stringify(staleProjection), "utf8");
    const authoritative = await createServer(directory).listThreadSummaries({
      archived: true,
    });
    assert.deepEqual(authoritative, archived);

    await writeFile(projectionFile, "not valid json", "utf8");
    const recovered = await createServer(directory).listThreadSummaries({
      archived: true,
    });
    assert.deepEqual(recovered, archived);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a real tool turn publishes canonical end evidence only after it stops", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-summary-final-"));
  let enterApproval!: () => void;
  let releaseApproval!: () => void;
  const entered = new Promise<void>((resolve) => {
    enterApproval = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseApproval = resolve;
  });
  let sample = 0;
  const model: ModelAdapter = {
    provider: "fake",
    async *stream() {
      if (sample++ === 0) {
        yield { type: "text_delta", delta: "Checking the result first." };
        yield {
          type: "tool_call",
          callId: "check",
          name: "shell",
          arguments: { command: "echo synthetic" },
        };
      } else {
        yield { type: "text_delta", delta: "The final reply." };
      }
    },
  };
  try {
    const server = createServer(directory, undefined, model);
    const thread = await server.startThread({ approvalPolicy: "always" });
    const turn = await server.startTurn(thread.id, "Check then reply", {
      requestApproval: async () => {
        enterApproval();
        await released;
        return "decline";
      },
    });
    await entered;
    const [running] = await server.listThreadSummaries();
    assert(running && running.status === "active");
    assert.ok(
      running.lastAgentMessage,
      "the real runtime committed pre-tool commentary",
    );
    assert.equal(running.lastTurnEnd, undefined);
    releaseApproval();
    await turn.done;
    const [completed] = await server.listThreadSummaries();
    assert(completed && completed.status === "idle");
    const completedItems = (await server.readThread(thread.id)).items;
    const terminal = completedItems.at(-1)!;
    assert.equal(terminal.type, "turn_completed");
    assert.deepEqual(completed.lastTurnEnd, {
      status: "completed",
      id: terminal.id,
      turnId: turn.id,
      createdAt: terminal.createdAt,
      position: turnEndPosition(
        completedItems,
        terminal as Parameters<typeof turnEndPosition>[1],
      ),
    });
    assert.ok(completed.lastTurnEnd);
    const [reloaded] = await createServer(directory).listThreadSummaries();
    assert(reloaded && reloaded.status === "idle");
    assert.deepEqual(reloaded.lastTurnEnd, completed.lastTurnEnd);
  } finally {
    releaseApproval();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const outcome of [
  "normal",
  "empty",
  "failure",
  "partial-failure",
  "abort",
  "tool-empty",
] as const) {
  test(`canonical end event is committed once and survives recovery: ${outcome}`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zen-summary-end-"));
    let entered!: () => void;
    const inSample = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let samples = 0;
    let currentServer: ZenAppServer | undefined;
    const model: ModelAdapter = {
      provider: "fake",
      async *stream(request) {
        entered();
        const [sampling] = await currentServer!.listThreadSummaries();
        assert(sampling && sampling.status === "active");
        assert.equal(
          sampling.lastTurnEnd,
          undefined,
          "every model attempt, including automatic recovery retries, remains non-terminal",
        );
        if (outcome === "normal") yield { type: "text_delta", delta: "Done." };
        if (outcome === "partial-failure" || outcome === "abort") {
          yield { type: "text_delta", delta: "Partial text only" };
        }
        if (outcome === "failure" || outcome === "partial-failure")
          throw new Error("synthetic model failure");
        if (outcome === "abort") {
          await new Promise<void>((resolve, reject) => {
            if (request.signal.aborted) reject(request.signal.reason);
            else
              request.signal.addEventListener(
                "abort",
                () => reject(request.signal.reason),
                { once: true },
              );
          });
        }
        if (outcome === "tool-empty" && samples++ === 0) {
          yield {
            type: "tool_call",
            callId: "tool-only",
            name: "shell",
            arguments: { command: "echo synthetic" },
          };
        }
      },
    };
    try {
      const journal = new JsonlThreadJournal(path.join(directory, "threads"));
      const server = createServer(directory, journal, model);
      currentServer = server;
      const recovery = new NativeRecoveryProjection(server, {
        processEpoch: "test-epoch",
      });
      try {
        const thread = await server.startThread({ approvalPolicy: "always" });
        const observed: AppServerEvent[] = [];
        const diskChecks: Promise<void>[] = [];
        server.subscribe((event) => {
          observed.push(event);
          if (
            event.type === "item_completed" &&
            (isTurnEndItem(event.item) || event.item.type === "turn_started")
          ) {
            diskChecks.push(
              journal.read(thread.id).then((items) => {
                assert.deepEqual(
                  items.find((item) => item.id === event.item.id),
                  event.item,
                  "the event is the original already-durable terminal Item",
                );
              }),
            );
          }
        });
        const turn = await server.startTurn(thread.id, outcome, {
          requestApproval: async () => "decline",
        });
        if (outcome === "abort") {
          await inSample;
          const [running] = await server.listThreadSummaries();
          assert(running && running.status === "active");
          assert.equal(running.lastTurnEnd, undefined);
          await server.interruptTurn(thread.id, turn.id);
        }
        await turn.done;
        await Promise.all(diskChecks);
        const snapshot = await server.readThread(thread.id);
        const terminal = snapshot.items.findLast(isTurnEndItem)!;
        assert(terminal);
        assert.equal(
          projectCompletedItem(terminal),
          null,
          "legacy CAS does not invent a message from a terminal Item",
        );
        assert.equal(
          terminal.type,
          outcome === "abort" ? "turn_aborted" : "turn_completed",
        );
        const startEvents = observed.filter(
          (event) =>
            event.type === "item_completed" &&
            event.item.type === "turn_started",
        );
        assert.equal(startEvents.length, 1);
        assert.equal(
          observed[observed.indexOf(startEvents[0]!) + 1]?.type,
          "turn_started",
        );
        const startEvent = startEvents[0]!;
        assert(startEvent.type === "item_completed");
        assert.equal(
          projectCompletedItem(startEvent.item),
          null,
          "legacy CAS ignores the lifecycle Item",
        );
        const terminalEvents = observed.filter(
          (event) =>
            event.type === "item_completed" && isTurnEndItem(event.item),
        );
        assert.equal(terminalEvents.length, 1);
        const itemIndex = observed.indexOf(terminalEvents[0]!);
        assert.equal(
          observed[itemIndex + 1]?.type,
          "turn_completed",
          "terminal Item precedes the unchanged status event",
        );
        assert.equal(
          observed.filter((event) => event.type === "turn_completed").length,
          1,
        );
        if (outcome === "empty" || outcome === "tool-empty") {
          assert.equal(
            snapshot.items.findLast((item) => item.type === "agent_message")
              ?.text,
            "",
          );
        }
        const [summary] = await server.listThreadSummaries();
        assert(summary && summary.status === "idle");
        assert.deepEqual(summary.lastTurnEnd, {
          status:
            outcome === "abort"
              ? "aborted"
              : outcome.includes("failure")
                ? "failed"
                : "completed",
          id: terminal.id,
          turnId: turn.id,
          createdAt: terminal.createdAt,
          position: turnEndPosition(snapshot.items, terminal),
        });
        assert.equal(isNativeThreadSummary(summary), true);
        const legacy = structuredClone(summary);
        delete legacy.lastTurnEnd!.status;
        assert.equal(
          isNativeThreadSummary(legacy),
          true,
          "old summaries remain readable without an outcome",
        );
        assert.equal(
          isNativeThreadSummary({
            ...summary,
            lastTurnEnd: { ...summary.lastTurnEnd, status: "retrying" },
          }),
          false,
          "transient recovery is not a terminal outcome",
        );
        const terminalEvent = terminalEvents[0]!;
        assert(terminalEvent.type === "item_completed");
        assert.equal(
          terminalEvent.turnEndPosition,
          summary.lastTurnEnd?.position,
        );
        const resumed = await recovery.resume(thread.id);
        const again = await recovery.resume(thread.id);
        assert.equal(
          again.watermark,
          resumed.watermark,
          "read-only resume never emits another end",
        );
        assert.deepEqual(
          resumed.thread.items.findLast(isTurnEndItem),
          terminal,
        );
        assert.equal(
          observed.filter(
            (event) =>
              event.type === "item_completed" && isTurnEndItem(event.item),
          ).length,
          1,
        );
        const [reloaded] = await createServer(directory).listThreadSummaries();
        assert(reloaded && reloaded.status === "idle");
        assert.deepEqual(reloaded.lastTurnEnd, summary.lastTurnEnd);
      } finally {
        recovery.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("Turn sort timestamp changes only at a new Turn and survives projection rebuild", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-summary-turn-"));
  try {
    const server = createServer(directory);
    const first = await server.startThread();
    const second = await server.startThread();
    const initial = (await server.listThreadSummaries()).find(
      (s) => s.threadId === first.id,
    );
    assert(initial && initial.status !== "systemError");
    assert.equal(initial.turnSortAt, initial.createdAt);
    const turn = await server.startTurn(first.id, "one");
    const running = (await server.listThreadSummaries()).find(
      (s) => s.threadId === first.id,
    );
    assert(running && running.status !== "systemError");
    assert.equal(
      running.turnSortAt,
      (await server.readThread(first.id)).items.find(
        (item) => item.type === "turn_started" && item.turnId === turn.id,
      )?.createdAt,
    );
    await turn.done;
    await server.setThreadName(first.id, "after turn");
    const finished = (await server.listThreadSummaries()).find(
      (s) => s.threadId === first.id,
    );
    assert(finished && finished.status !== "systemError");
    assert.equal(finished.turnSortAt, running.turnSortAt);
    assert.notEqual(finished.updatedAt, initial.updatedAt);
    const otherTurn = await server.startTurn(second.id, "two");
    await otherTurn.done;
    const next = await server.startTurn(first.id, "three");
    await next.done;
    const latest = (await server.listThreadSummaries()).find(
      (s) => s.threadId === first.id,
    );
    assert(latest && latest.status !== "systemError");
    assert.equal(
      latest.turnSortAt,
      (await server.readThread(first.id)).items.find(
        (item) => item.type === "turn_started" && item.turnId === next.id,
      )?.createdAt,
    );
    assert.deepEqual(
      await createServer(directory).listThreadSummaries(),
      await server.listThreadSummaries(),
    );
    await unlink(path.join(directory, "thread-summaries.json"));
    assert.deepEqual(
      await createServer(directory).listThreadSummaries(),
      await server.listThreadSummaries(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("queued input only advances sort key when its Turn actually starts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-summary-queue-"));
  try {
    const server = createServer(directory);
    const started = await server.startThread();
    await server.queueMessage(started.id, "queued work", "queued-once");
    let turnStartedAt: string | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      turnStartedAt = (await server.readThread(started.id)).items.find(
        (item) => item.type === "turn_started",
      )?.createdAt;
      if (turnStartedAt !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(turnStartedAt);
    const [summary] = await server.listThreadSummaries();
    assert(summary && summary.status !== "systemError");
    assert.equal(summary.turnSortAt, turnStartedAt);
    let completed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      completed = (await server.readThread(started.id)).items.some(
        (item) => item.type === "turn_completed",
      );
      if (completed) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(completed, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fork uses its own creation instead of inherited Turn recency", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-summary-fork-"));
  try {
    const server = createServer(directory);
    const source = await server.startThread();
    await (
      await server.startTurn(source.id, "source Turn")
    ).done;
    const fork = await server.forkThread({
      sourceThreadId: source.id,
      through: { type: "latest-complete" },
      workspace: { type: "same-directory" },
    });
    const current = (await server.listThreadSummaries()).find(
      (s) => s.threadId === fork.id,
    );
    assert(current && current.status !== "systemError");
    assert.equal(current.turnSortAt, current.createdAt);
    assert.equal(
      current.lastTurnEnd,
      undefined,
      "inherited completed history is not this fork executing",
    );
    await (
      await server.startTurn(fork.id, "fork's own Turn")
    ).done;
    const newer = (await server.listThreadSummaries()).find(
      (s) => s.threadId === fork.id,
    );
    assert(newer && newer.status !== "systemError");
    assert.equal(
      newer.turnSortAt,
      (await server.readThread(fork.id)).items.findLast(
        (i) => i.type === "turn_started",
      )?.createdAt,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("running-source forks and side chats do not notify for synthetic snapshot closures", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-summary-running-fork-"),
  );
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let done: Promise<unknown> | undefined;
  let sample = 0;
  const server = createServer(directory, undefined, {
    provider: "fake",
    async *stream() {
      if (sample++ === 0) {
        yield { type: "text_delta", delta: "Still working before tool" };
        yield {
          type: "tool_call",
          callId: "pending",
          name: "shell",
          arguments: { command: "echo synthetic" },
        };
      }
    },
  });
  try {
    const source = await server.startThread({ approvalPolicy: "always" });
    const running = await server.startTurn(source.id, "run", {
      requestApproval: async () => {
        entered();
        await released;
        return "decline";
      },
    });
    done = running.done;
    await waiting;
    const boundary = (await server.readThread(source.id)).items.findLast(
      (item) => item.type === "agent_message",
    )!;
    const fork = await server.forkThread({
      sourceThreadId: source.id,
      through: { type: "item", itemId: boundary.id },
      workspace: { type: "same-directory" },
    });
    const side = await server.createChildThread({
      parentThreadId: source.id,
      mode: "side-chat",
    });
    for (const target of [fork, side]) {
      assert(
        target.items.some((item) => item.type === "turn_aborted"),
        "fixture includes a synthetic snapshot closure",
      );
      const summary = (await server.listThreadSummaries()).find(
        (item) => item.threadId === target.id,
      )!;
      assert(summary.status === "idle");
      assert.equal(
        summary.lastTurnEnd,
        undefined,
        "no execution was transferred into the target",
      );
      const local = await server.startTurn(target.id, "new local execution");
      await local.done;
      const ended = (await server.listThreadSummaries()).find(
        (item) => item.threadId === target.id,
      )!;
      assert(ended.status === "idle");
      assert.equal(ended.lastTurnEnd?.turnId, local.id);
      const reloaded = (
        await createServer(directory).listThreadSummaries()
      ).find((item) => item.threadId === target.id)!;
      assert(reloaded.status === "idle");
      assert.deepEqual(reloaded.lastTurnEnd, ended.lastTurnEnd);
    }
    release();
    await running.done;
  } finally {
    release();
    await done;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex summary adapter maps native list state without defining it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-summary-map-"));
  try {
    const server = createServer(directory);
    const started = await server.startThread();
    await (
      await server.startTurn(started.id, "hello from native summary")
    ).done;
    const [summary] = await server.listThreadSummaries();
    assert(summary !== undefined);
    const projected = projectThreadSummary(summary);
    assert.equal(projected.id, started.id);
    assert.equal(projected.preview, "hello from native summary");
    assert.equal(projected.modelProvider, "fake");
    assert.equal(projected.cwd, directory);
    assert.deepEqual(projected.status, { type: "idle" });
    assert.deepEqual(projected.turns, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native summary status follows the current in-process Turn", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-summary-active-"),
  );
  let releaseApproval = (): void => undefined;
  const approval = new Promise<void>((resolve) => {
    releaseApproval = resolve;
  });
  try {
    const server = createServer(directory);
    const started = await server.startThread({ approvalPolicy: "always" });
    const turn = await server.startTurn(started.id, "!shell printf active", {
      requestApproval: async () => {
        await approval;
        return "decline";
      },
    });
    const beforeSteer = (await server.listThreadSummaries())[0];
    assert(beforeSteer && beforeSteer.status !== "systemError");
    assert.equal(beforeSteer.status, "active");
    assert.equal(
      (await server.readThread(started.id)).turns.at(-1)?.status,
      "inProgress",
    );
    assert.equal(
      (
        await new JsonlThreadJournal(path.join(directory, "threads")).read(
          started.id,
        )
      ).filter((item) => item.type === "turn_aborted").length,
      0,
    );
    await server.steerTurn(started.id, turn.id, "same Turn steer");
    const afterSteer = (await server.listThreadSummaries())[0];
    assert(afterSteer && afterSteer.status !== "systemError");
    assert.equal(afterSteer.turnSortAt, beforeSteer.turnSortAt);
    releaseApproval();
    await turn.done;
    assert.equal((await server.listThreadSummaries())[0]?.status, "idle");
  } finally {
    releaseApproval();
    await rm(directory, { recursive: true, force: true });
  }
});

test("replacement successor lacking its initial message remains incomplete", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-incomplete-replacement-"),
  );
  try {
    const journal = new JsonlThreadJournal(path.join(directory, "threads"));
    const started = await createServer(directory).startThread();
    const now = new Date().toISOString();
    await journal.append({
      id: "old-start",
      threadId: started.id,
      turnId: "old",
      type: "turn_started",
      createdAt: now,
    });
    await journal.append({
      id: "replacement",
      threadId: started.id,
      turnId: "old",
      successorTurnId: "successor",
      clientId: "replace-id",
      input: [{ type: "text", text: "later" }],
      type: "turn_replacement_requested",
      createdAt: now,
    });
    await journal.append({
      id: "old-stop",
      threadId: started.id,
      turnId: "old",
      type: "turn_aborted",
      createdAt: now,
      reason: "replaced",
    });
    await journal.append({
      id: "new-start",
      threadId: started.id,
      turnId: "successor",
      type: "turn_started",
      createdAt: now,
    });
    await createServer(directory).readThread(started.id);
    assert.equal(
      (await journal.read(started.id)).filter(
        (item) => item.type === "turn_aborted",
      ).length,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reader never retries a tool whose side effect happened but result is unknown", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-unknown-tool-"));
  try {
    const disk = new JsonlThreadJournal(path.join(directory, "threads"));
    const journal: ThreadJournal = {
      listThreadIds: () => disk.listThreadIds(),
      read: (id) => disk.read(id),
      create: (items) => disk.create(items),
      append: async (item) => {
        if (item.type === "tool_result")
          throw new Error("tool result append outcome unknown");
        await disk.append(item);
      },
    };
    const owner = createServer(directory, journal);
    const thread = await owner.startThread();
    const turn = await owner.startTurn(thread.id, "!shell printf x >> marker");
    await assert.rejects(turn.done, /tool result append outcome unknown/u);
    assert.equal(await readFile(path.join(directory, "marker"), "utf8"), "x");
    await createServer(directory).readThread(thread.id);
    await createServer(directory).readThread(thread.id);
    assert.equal(await readFile(path.join(directory, "marker"), "utf8"), "x");
    const items = await disk.read(thread.id);
    assert.equal(items.filter((item) => item.type === "tool_call").length, 1);
    assert.equal(
      items.filter(
        (item) => item.type === "tool_result" || item.type === "turn_aborted",
      ).length,
      0,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("another live Host reading the same journal never signs its owner's Turn", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-shared-owner-"));
  let release = (): void => undefined;
  const approval = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const owner = createServer(directory);
    const thread = await owner.startThread({ approvalPolicy: "always" });
    const active = await owner.startTurn(thread.id, "!shell printf once", {
      requestApproval: async () => {
        await approval;
        return "decline";
      },
    });
    const journal = new JsonlThreadJournal(path.join(directory, "threads"));
    await Promise.all([
      createServer(directory).readThread(thread.id),
      createServer(directory).readThread(thread.id),
    ]);
    assert.equal(
      (await journal.read(thread.id)).filter(
        (item) => item.type === "turn_aborted",
      ).length,
      0,
    );
    assert.equal(
      (await owner.readThread(thread.id)).turns.at(-1)?.status,
      "inProgress",
    );
    release();
    await active.done;
    const items = await journal.read(thread.id);
    assert.equal(
      items.filter((item) => item.type === "turn_aborted").length,
      0,
    );
    assert.equal(
      items.filter(
        (item) => item.type === "turn_completed" && item.turnId === active.id,
      ).length,
      1,
    );
  } finally {
    release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("parallel cold reads never write a terminal or consume queued input", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-lost-owner-"));
  try {
    const journal = new JsonlThreadJournal(path.join(directory, "threads"));
    const started = await createServer(directory).startThread();
    const now = new Date().toISOString();
    await journal.append({
      id: "old-start",
      threadId: started.id,
      turnId: "old-turn",
      type: "turn_started",
      createdAt: now,
    });
    await journal.append({
      id: "queued",
      threadId: started.id,
      type: "user_message_queued",
      createdAt: now,
      clientId: "queued-client",
      input: [{ type: "text", text: "later" }],
    });
    const recovered = createServer(directory);
    const [read, summaries] = await Promise.all([
      recovered.readThread(started.id),
      recovered.listThreadSummaries(),
    ]);
    assert.equal(read.turns.at(-1)?.status, "interrupted");
    assert.equal(
      summaries.find((s) => s.threadId === started.id)?.status,
      "idle",
    );
    await recovered.readThread(started.id);
    await createServer(directory).readThread(started.id);
    const items = await journal.read(started.id);
    assert.equal(
      items.filter((i) => i.type === "turn_aborted" && i.turnId === "old-turn")
        .length,
      0,
    );
    assert.equal(
      items.filter((i) => i.type === "user_message_queued").length,
      1,
    );
    assert.equal(
      items.filter(
        (i) => i.type === "user_message" && i.clientId === "queued-client",
      ).length,
      0,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("message summaries follow canonical user/Agent messages, not metadata or trailing lifecycle items", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-summary-messages-"),
  );
  try {
    const server = createServer(directory);
    const thread = await server.startThread();
    const [empty] = await server.listThreadSummaries();
    assert(empty && empty.status !== "systemError");
    assert.equal(empty.lastMessage, undefined);
    assert.equal(empty.lastAgentMessage, undefined);
    await (
      await server.startTurn(thread.id, "hello")
    ).done;
    const canonical = (await server.readThread(thread.id)).items;
    const lastAgent = canonical.findLast(
      (item) => item.type === "agent_message",
    )!;
    assert(lastAgent);
    assert.notEqual(
      canonical.at(-1)?.id,
      lastAgent.id,
      "lifecycle tail is not a message",
    );
    const [summary] = await server.listThreadSummaries();
    assert(summary && summary.status !== "systemError");
    assert.deepEqual(summary.lastAgentMessage, {
      id: lastAgent.id,
      createdAt: lastAgent.createdAt,
    });
    assert.deepEqual(summary.lastMessage, {
      id: lastAgent.id,
      createdAt: lastAgent.createdAt,
      kind: "agent",
    });
    await server.updateThreadSettings(thread.id, { model: "other" });
    await server.setThreadName(thread.id, "rename is not a message");
    const [renamed] = await server.listThreadSummaries();
    assert(renamed && renamed.status !== "systemError");
    assert.deepEqual(renamed.lastMessage, summary.lastMessage);
    assert.deepEqual(renamed.lastAgentMessage, summary.lastAgentMessage);
    await unlink(path.join(directory, "thread-summaries.json"));
    const [rebuilt] = await createServer(directory).listThreadSummaries();
    assert(rebuilt && rebuilt.status !== "systemError");
    assert.deepEqual(rebuilt.lastMessage, summary.lastMessage);
    assert.deepEqual(rebuilt.lastAgentMessage, summary.lastAgentMessage);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
