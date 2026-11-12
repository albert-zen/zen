import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { ShellToolRuntime, ToolEnvironment } from "../src/tool.js";

test("scan, parallel file reads, partial failure, URL reporting and stored summary work together", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "zen-report-"));
  const names = [
    "空 格.json",
    "quote'.json",
    "line\nbreak.json",
    ...Array.from({ length: 7 }, (_, i) => `row-${i}.json`),
  ];
  await Promise.all(
    names.map((name, i) =>
      writeFile(join(cwd, name), JSON.stringify({ value: i + 1 })),
    ),
  );
  const env = new ToolEnvironment({
    runtimes: [new ShellToolRuntime(), new RunCodeToolRuntime()],
  });
  t.after(async () => {
    await env.close();
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
            code: `
// @exec: {"yield_time_ms": 180000}
const listed = await tools.shell({command: "find . -type f -name '*.json' -print0"});
if (listed.exitCode !== 0) throw new Error(listed.output);
const paths = listed.output.split(String.fromCharCode(0)).filter(Boolean).sort();
paths.push('./missing.json');
const quote = value => "'" + value.replaceAll("'", "'" + String.fromCharCode(92) + "''") + "'";
const rows = await Promise.all(paths.map(async file => {
  const result = await tools.shell({command: 'cat -- ' + quote(file)});
  if (result.exitCode !== 0) return {file, status: 'failed', exitCode: result.exitCode};
  const data = JSON.parse(result.output);
  const url = new URL('https://example.invalid/report');
  url.searchParams.set('file', file);
  return {file, status: 'ok', value: data.value, bytes: new TextEncoder().encode(result.output).length, url: url.href};
}));
store('report', {id: crypto.randomUUID(), rows});
text('| File | Value | Status |');
text('| --- | ---: | --- |');
for (const row of rows) text('| ' + JSON.stringify(row.file) + ' | ' + (row.value ?? '-') + ' | ' + row.status + ' |');
`.trimStart(),
          },
        };
      } else if (round === 2) {
        yield {
          type: "tool_call",
          callId: "summary",
          name: "run_code",
          arguments: {
            code: `const report = load('report'); text({id: report.id, successes: report.rows.filter(r => r.status === 'ok').length, failures: report.rows.filter(r => r.status === 'failed').length, sum: report.rows.reduce((sum, r) => sum + (r.value ?? 0), 0), urlsRoundTrip: report.rows.filter(r => r.url).every(r => new URL(r.url).searchParams.get('file') === r.file)});`,
          },
        };
      } else yield { type: "text_delta", delta: "done" };
    },
  };
  const server = new ZenAppServer({
    journal: new InMemoryThreadJournal(),
    runtime: new AgentRuntime({ toolEnvironment: env }),
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
  const summary = results.find((item) => item.callId === "summary");
  assert.equal(summary?.exitCode, 0);
  const value = JSON.parse(summary!.output);
  assert.match(
    value.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.deepEqual(
    { ...value, id: undefined },
    { id: undefined, successes: 10, failures: 1, sum: 55, urlsRoundTrip: true },
  );
  assert.equal(results.filter((item) => item.exitCode !== 0).length, 1);
  assert.match(
    results.find((item) => item.callId === "report")!.output,
    /\| File \| Value \| Status \|/,
  );
});
