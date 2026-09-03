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
    { id: "fake", isDefault: true },
    { id: "other" },
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
    assert.equal((await server.listThreadSummaries())[0]?.status, "active");
    releaseApproval();
    await turn.done;
    assert.equal((await server.listThreadSummaries())[0]?.status, "idle");
  } finally {
    releaseApproval();
    await rm(directory, { recursive: true, force: true });
  }
});
