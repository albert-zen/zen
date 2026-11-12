import assert from "node:assert/strict";
import test from "node:test";
import { Thread as CanonicalThread } from "../../../src/thread.js";
import { readThreadHistory } from "../../../src/thread-history.js";
import { applyNativeThreadEvent } from "../src/renderer/src/thread-view-state.js";
import { projectTurn } from "../src/renderer/src/turn-projection.js";
import {
  recoveryScenario,
  recoveryScenarioSnapshot,
  syntheticRecovery,
} from "./fixtures/loop-recovery-scenario.js";

for (const mode of ["live", "reload"] as const) {
  for (const phase of [
    "running",
    "recovering",
    "continuing",
    "completed",
    "stopped",
  ] as const) {
    test(`native ${mode} ${phase} keeps recovery nonterminal and out of turn.error`, () => {
      const thread = recoveryScenario(phase, mode);
      const turn = thread.turns[0]!;
      assert.equal(turn.error, null);
      assert.equal(
        turn.status,
        phase === "completed"
          ? "completed"
          : phase === "stopped"
            ? "interrupted"
            : "inProgress",
      );
      assert.equal(
        thread.status.type,
        ["completed", "stopped"].includes(phase) ? "idle" : "active",
      );
      if (phase !== "running") {
        assert.deepEqual(
          thread.canonicalItems?.find(
            (item) => item.id === syntheticRecovery.id,
          ),
          syntheticRecovery,
        );
        assert.equal(
          turn.items.filter((item) => item.type === "commandExecution").length,
          1,
        );
      }
      if (["running", "recovering", "continuing"].includes(phase))
        assert.equal(projectTurn(turn).terminalFallback, null);
      if (phase === "completed")
        assert.match(projectTurn(turn).finalItem?.text ?? "", /没有重复执行/);
    });
  }
  test(`native ${mode} real terminal failure remains visible after earlier recovery`, () => {
    let thread = recoveryScenario("failed", mode);
    const message = thread.turns[0]!.error?.message;
    assert.match(message ?? "", /bounded recovery budget/);
    assert.equal(thread.turns[0]!.status, "failed");
    thread = applyNativeThreadEvent(thread, {
      type: "item_completed",
      item: syntheticRecovery,
    });
    assert.equal(
      thread.turns[0]!.error?.message,
      message,
      "late recovery replay cannot overwrite terminal error",
    );
  });
}

test("synthetic visual snapshots validate against real canonical Turn derivation and preserve public recovery history", () => {
  for (const phase of [
    "running",
    "recovering",
    "completed",
    "failed",
    "stopped",
  ] as const) {
    const snapshot = recoveryScenarioSnapshot(phase);
    const canonical = new CanonicalThread(snapshot.id, snapshot.items);
    assert.equal(
      canonical.deriveTurns({ activeTurnId: snapshot.turns[0]!.id })[0]!.status,
      snapshot.turns[0]!.status,
    );
    if (phase !== "running") {
      const history = readThreadHistory(snapshot, {
        granularity: "item",
        itemId: syntheticRecovery.id,
        maxTurns: 10,
        maxItemsPerTurn: 50,
      });
      assert.deepEqual(
        JSON.parse(String(history.content)).recovery,
        syntheticRecovery.recovery,
      );
    }
  }
});

test("real recovered fork and side-chat snapshots keep diagnostics in history without terminal errors", async () => {
  const { ZenAppServer } = await import("../../../src/app-server.js");
  const { AgentRuntime } = await import("../../../src/runtime.js");
  const { ToolEnvironment } = await import("../../../src/tool.js");
  const { InMemoryThreadJournal } = await import("../../../src/journal.js");
  const { InMemoryThreadMetadataStore } =
    await import("../../../src/thread-metadata.js");
  const { ProviderRegistry } =
    await import("../../../src/provider-registry.js");
  const { StaticModelCatalog } = await import("../../../src/model-catalog.js");
  const { projectRecoverySnapshot } =
    await import("./fixtures/loop-recovery-scenario.js");
  const journal = new InMemoryThreadJournal();
  let samples = 0;
  const server = new ZenAppServer({
    runtime: new AgentRuntime({
      toolEnvironment: new ToolEnvironment({ bundles: [] }),
      sampleRetry: { sleep: async () => {} },
    }),
    journal,
    threadMetadata: new InMemoryThreadMetadataStore(),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: "synthetic",
        adapter: {
          provider: "synthetic",
          async *stream() {
            if (++samples === 1) throw new Error("network unavailable");
            yield {
              type: "text_delta" as const,
              delta: "Synthetic recovered answer",
            };
          },
        },
        modelCatalog: new StaticModelCatalog([
          {
            id: "synthetic",
            isDefault: true,
            contextWindow: 32768,
            inputModalities: ["text"],
          },
        ]),
      },
    ]),
    defaults: {
      cwd: "/tmp",
      providerProfileId: "synthetic",
      modelId: "synthetic",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  const original = await server.startThread();
  await (
    await server.startTurn(original.id, "Synthetic request")
  ).done;
  const source = await server.readThread(original.id);
  const copies = [
    source,
    await server.forkThread({
      sourceThreadId: source.id,
      through: { type: "latest-complete" },
      workspace: { type: "same-directory" },
    }),
    await server.createChildThread({
      parentThreadId: source.id,
      mode: "side-chat",
    }),
  ];
  for (const copy of copies) {
    const reloadedItems = await journal.read(copy.id);
    const canonical = new CanonicalThread(copy.id, reloadedItems);
    const snapshot = {
      ...copy,
      items: canonical.items,
      turns: canonical.deriveTurns(),
    };
    const view = projectRecoverySnapshot(snapshot);
    assert.equal(view.turns[0]?.error, null);
    assert.equal(view.turns[0]?.status, "completed");
    const recovery = copy.items.find(
      (item) => item.type === "failure" && item.recovery !== undefined,
    )!;
    assert.equal(recovery.type, "failure");
    const history = readThreadHistory(snapshot, {
      granularity: "item",
      itemId: recovery.id,
      maxTurns: 10,
      maxItemsPerTurn: 50,
    });
    assert.deepEqual(
      JSON.parse(String(history.content)).recovery,
      recovery.type === "failure" ? recovery.recovery : undefined,
    );
    assert.deepEqual(
      view.canonicalItems?.find((item) => item.id === recovery.id),
      recovery,
    );
  }
});

test("shared recovery projection does not pull Host crypto into the renderer", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../../../src/loop-recovery.ts", import.meta.url),
    "utf8",
  );
  // The native UI's compaction view imports compileModelMessages, so its recovery
  // projection must remain portable; fingerprint hashing belongs to Host Runtime.
  assert.doesNotMatch(
    source,
    /(?:from\s*|import\s*\()\s*["'](?:node:|crypto["'])/u,
  );
});
