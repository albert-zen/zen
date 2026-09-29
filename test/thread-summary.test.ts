import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenAppServer } from "../src/app-server.js";
import { JsonlThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import { FakeModel } from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { projectThreadSummary } from "../src/protocol/codex/mapper.js";
import { AgentRuntime } from "../src/runtime.js";
import { JsonlThreadMetadataStore } from "../src/thread-metadata.js";
import { JsonThreadSummaryProjection } from "../src/thread-summary.js";
import { ShellToolRuntime, ToolEnvironment } from "../src/tool.js";

function createServer(directory: string): ZenAppServer {
  const model = new FakeModel();
  const modelCatalog = new StaticModelCatalog([
    { id: "fake", isDefault: true, contextWindow: 32_768 },
    { id: "other", contextWindow: 32_768 },
  ]);
  return new ZenAppServer({
    journal: new JsonlThreadJournal(path.join(directory, "threads")),
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
