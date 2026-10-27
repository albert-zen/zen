import { buildCodeRuntimeWorkerFixture } from "./code-runtime-worker-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { browserBackend, browserBridge } from "./model-browser-fixture.js";
import { BrowserBackendRegistry } from "../src/main/capabilities/browser-backend-registry.js";
import { ZenAppServer } from "../../../src/app-server.js";
import { AgentRuntime } from "../../../src/runtime.js";
import { CodeRuntime, RunCodeToolRuntime } from "../../../src/code-runtime.js";
import { ToolEnvironment } from "../../../src/tool.js";
import { DomainThreadJournal } from "../../../src/domain-journal.js";
import { FileTraceStore } from "../../../src/trace.js";
import { JsonlThreadMetadataStore } from "../../../src/thread-metadata.js";
import { ProviderRegistry } from "../../../src/provider-registry.js";
import { StaticModelCatalog } from "../../../src/model-catalog.js";
import { compileItemList } from "../../../src/item-list.js";
import type { ModelAdapter, ModelRequest } from "../../../src/model.js";

test("real nested Browser full receipts stay semantic, survive durable compaction, and retired refs reject after cold reconstruction without replay", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workerUrl = await buildCodeRuntimeWorkerFixture(directory);
  let phase: "nested" | "inspect" | "restart" = "nested",
    round = 0,
    chosenTab = "",
    compactions = 0;
  const samples: ModelRequest[] = [];
  const model: ModelAdapter = {
    provider: "synthetic-browser",
    async *stream(request) {
      samples.push(request);
      if (request.debugContext?.purpose === "compaction") {
        compactions++;
        yield {
          type: "text_delta",
          delta: `The Browser tab is ${chosenTab}. A click completed once. Inspect afresh; never replay it.`,
        };
        return;
      }
      if (round++ % 2) {
        yield { type: "text_delta", delta: "Observed, not replayed." };
        return;
      }
      yield phase === "nested"
        ? {
            type: "tool_call",
            callId: "nested-browser",
            name: "run_code",
            arguments: {
              code: `
const listed = await tools.browser_workspace_list_tabs({session: 'main'});
if (Object.hasOwn(listed, 'referenceBindings')) throw new Error('Private root bindings leaked into worker');
text(listed);
const tab = JSON.parse(listed.output).tabs[0].tab;
const observed = await tools.browser_workspace_inspect({tab});
if (Object.hasOwn(observed, 'referenceBindings')) throw new Error('Private observation bindings leaked');
text(observed);
const result = await tools.browser_workspace_click({target: JSON.parse(observed.output).targets[0].ref});
if (Object.hasOwn(result, 'referenceBindings')) throw new Error('Private action bindings leaked');
text(result);
text({referenceBindings: 'literal user JSON survives'});
text({chosenTab: tab});
`,
            },
          }
        : {
            type: "tool_call",
            callId: phase === "restart" ? "retired-ref" : "post-compaction",
            name: "browser_workspace_inspect",
            arguments: { tab: chosenTab },
          };
    },
  };
  const build = async () => {
    const backend = browserBackend(2),
      bridge = await browserBridge(new BrowserBackendRegistry(backend.backend));
    const trace = new FileTraceStore(path.join(directory, "trace")),
      metadata = new JsonlThreadMetadataStore(
        path.join(directory, "metadata.jsonl"),
      );
    const journal = new DomainThreadJournal({
      directory: path.join(directory, "threads"),
      trace,
      metadata,
    });
    const environment = new ToolEnvironment({
      bundles: [bridge.bundle],
      runtimes: [
        new RunCodeToolRuntime(
          new CodeRuntime({
            workerUrl,
          }),
        ),
      ],
    });
    const server = new ZenAppServer({
      journal,
      threadMetadata: metadata,
      runtime: new AgentRuntime({ toolEnvironment: environment, trace }),
      providerRegistry: new ProviderRegistry([
        {
          providerProfileId: model.provider,
          adapter: model,
          modelCatalog: new StaticModelCatalog([
            { id: "fixture", isDefault: true, contextWindow: 1000000 },
          ]),
        },
      ]),
      defaults: {
        cwd: directory,
        providerProfileId: model.provider,
        modelId: "fixture",
        reasoningEffort: "medium",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
    });
    return {
      backend,
      bridge,
      trace,
      journal,
      server,
      async close() {
        await server.closeRuntimeConfiguration();
        await environment.close();
        await bridge.close();
        await journal.close();
      },
    };
  };
  let first: Awaited<ReturnType<typeof build>> | undefined,
    second: Awaited<ReturnType<typeof build>> | undefined;
  try {
    first = await build();
    const thread = await first.server.startThread();
    await (
      await first.server.startTurn(
        thread.id,
        'Inspect and click once. Preserve literal JSON {"referenceBindings":"user-owned"}.',
      )
    ).done;
    const snapshot = await first.server.readThread(thread.id),
      root = snapshot.items.find(
        (i) => i.type === "tool_result" && i.callId === "nested-browser",
      );
    assert.ok(root?.type === "tool_result");
    assert.equal(root.exitCode, 0, root.output);
    assert.match(root.output, /literal user JSON survives/);
    assert.doesNotMatch(root.output, /RAW-|sessionEpoch|ownerThreadId/);
    const semantic = await first.journal.readItemList(thread.id),
      binding = semantic
        .flatMap((i) => i.source.metadata?.referenceBindings ?? [])
        .find((b: any) => b.namespace === "browser" && b.kind === "tab") as any;
    assert.ok(binding);
    chosenTab = binding.ref;
    const messages = JSON.stringify(compileItemList(semantic).messages);
    assert.doesNotMatch(messages, /RAW-|sessionEpoch|ownerThreadId/);
    assert.match(messages, /referenceBindings/);
    assert.equal(
      first.backend.calls.filter((c) => c.name === "click").length,
      1,
    );
    await first.server.compactThread(thread.id);
    assert.equal(compactions, 1);
    phase = "inspect";
    round = 0;
    await (
      await first.server.startTurn(
        thread.id,
        `Inspect ${chosenTab}; do not repeat the action.`,
      )
    ).done;
    const post = (await first.server.readThread(thread.id)).items.find(
      (i) => i.type === "tool_result" && i.callId === "post-compaction",
    );
    assert.ok(post?.type === "tool_result");
    assert.equal(post.exitCode, 0, post.output);
    assert.equal(
      first.backend.calls.filter((c) => c.name === "click").length,
      1,
    );
    await first.close();
    first = undefined;
    second = await build();
    const recovered = await second.journal.readItemList(thread.id);
    assert.ok(recovered.some((i) => i.source.metadata?.referenceBindings));
    phase = "restart";
    round = 0;
    await (
      await second.server.startTurn(
        thread.id,
        `Old ${chosenTab} is retired; never fall back to a new tab.`,
      )
    ).done;
    const retired = (await second.server.readThread(thread.id)).items.find(
      (i) => i.type === "tool_result" && i.callId === "retired-ref",
    );
    assert.ok(retired?.type === "tool_result");
    assert.notEqual(retired.exitCode, 0);
    assert.match(retired.output, /retired|refresh|inspect/i);
    assert.equal(second.bridge.native.length, 0);
    assert.deepEqual(second.backend.calls, []);
    const records = await second.trace.read(thread.id, {
      verifyArtifacts: true,
    });
    assert.equal(records.issues.length, 0);
    const artifacts = await Promise.all(
      records.records.flatMap((r) =>
        r.artifacts.map(async (a) =>
          Buffer.from(await second!.trace.readArtifact(a.ref)).toString(),
        ),
      ),
    );
    assert.ok(
      artifacts.some((bytes) => bytes.includes("RAW-native-tab")),
      "raw native output remains in independent durable Trace after restart",
    );
    assert.ok(samples.length >= 7);
  } finally {
    await first?.close();
    await second?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
