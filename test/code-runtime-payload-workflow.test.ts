import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZenAppServer } from "../src/app-server.js";
import { RunCodeToolRuntime } from "../src/code-runtime.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
import type { ModelAdapter } from "../src/model.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { AgentRuntime } from "../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { ToolOutputSpool } from "../src/tool-output-spool.js";
import { ShellToolRuntime, ToolEnvironment } from "../src/tool.js";

test("large JSON is raw inside the program while canonical model output stays bounded", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "zen-report-"));
  const payload = JSON.stringify({
    items: Array.from({ length: 20000 }, (_, i) => ({
      id: i,
      label: "中文数据",
    })),
  });
  await writeFile(join(cwd, "big.json"), payload);
  const spool = new ToolOutputSpool({ rootDirectory: join(cwd, "spool") });
  const env = new ToolEnvironment({
    runtimes: [new ShellToolRuntime(), new RunCodeToolRuntime()],
    toolOutputSpool: spool,
  });
  t.after(async () => {
    await env.close();
    await spool.close();
    await rm(cwd, { recursive: true, force: true });
  });
  let round = 0;
  const model: ModelAdapter = {
    provider: "workflow-test",
    async *stream() {
      if (++round === 1) {
        yield {
          type: "tool_call",
          callId: "report",
          name: "run_code",
          arguments: {
            code: `const r = await tools.shell({command: 'cat big.json'}); if(r.exitCode !== 0 || !r.outputInfo.complete) throw new Error('Expected complete payload'); text({count: JSON.parse(r.output).items.length});`,
          },
        };
      } else yield { type: "text_delta", delta: "done" };
    },
  };
  const server = new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    runtime: new AgentRuntime({ toolEnvironment: env, toolOutputSpool: spool }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          { id: "model", isDefault: true, contextWindow: 32768 },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd,
      providerProfileId: model.provider,
      modelId: "model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
  t.after(() => server.closeRuntimeConfiguration());
  const thread = await server.startThread();
  const turn = await server.startTurn(
    thread.id,
    "Read the directory and summarize its records.",
  );
  await turn.done;
  const snapshot = await server.readThread(thread.id);
  const results = snapshot.items.filter((item) => item.type === "tool_result");
  const summary = results.find((item) => item.callId === "report")!;
  assert.equal(summary.exitCode, 0);
  assert.deepEqual(JSON.parse(summary.output), { count: 20000 });
  const child = results.find((item) => item.callId !== "report")!;
  assert.match(child.output, /^\[tool output receipt\]/);
  assert.ok(child.output.length < 10000);
  const path = /^full_output: (.+)$/m.exec(child.output)![1]!;
  assert.equal(await readFile(path, "utf8"), payload);
});
