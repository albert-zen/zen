import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CodeRuntime,
  CodeRuntimeError,
  RunCodeToolRuntime,
} from "../src/code-runtime.js";
import { ToolEnvironment } from "../src/tool.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import { createMediaOutputConverter } from "../src/model-content.js";
import { png1x1 } from "./fixtures.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const nested = { invoke: async () => ({ output: "", exitCode: 0 }) };

test("default code output capture keeps text beyond the former 256KiB ceiling", async () => {
  let bytes = 0;
  const result = await new CodeRuntime().execute({
    code: 'text("x".repeat(1024*1024));',
    signal: new AbortController().signal,
    nested,
    onOutput: (delta) => {
      bytes += Buffer.byteLength(delta);
    },
  });
  assert.equal(bytes, 1024 * 1024);
  assert.equal(result.text.length, bytes);
  assert.equal(result.outputTruncated, false);
});

for (const failure of ["throw new Error('crash')", "process.exit(7)"]) {
  test(`worker failure settles an already started store before returning: ${failure}`, async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "zen-code-crash-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "worker.mjs");
    await writeFile(
      file,
      `import {workerData} from 'node:worker_threads'; workerData.port.postMessage(JSON.stringify({type:'store',key:'saved',value:3})); setTimeout(() => { ${failure}; }, 15);`,
    );
    const started = deferred(),
      release = deferred();
    let settled = false,
      committed = false;
    const running = new CodeRuntime({ workerUrl: pathToFileURL(file) })
      .execute({
        code: "text(1)",
        signal: new AbortController().signal,
        nested,
        onStore: async () => {
          started.resolve();
          await release.promise;
          committed = true;
        },
      })
      .catch((error) => {
        settled = true;
        return error;
      });
    await started.promise;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(settled, false);
    release.resolve();
    const error = await running;
    assert(error instanceof CodeRuntimeError);
    assert.equal(committed, true);
    assert.deepEqual(error.result?.stateWrites, { saved: 3 });
  });
}

test("explicit image reaches the first yield and is not repeated at completion", async (t) => {
  const gate = deferred();
  const store = new InMemoryAttachmentStore();
  const env = new ToolEnvironment({
    runtimes: [new RunCodeToolRuntime()],
    taskOptions: { yieldTimeMs: 1000 },
  });
  t.after(() => env.close());
  const invoke = (name: string, args: Record<string, unknown>) => ({
    callId: name,
    name,
    arguments: args,
    threadId: "media",
    cwd: process.cwd(),
    signal: new AbortController().signal,
  });
  const first = await env.execute(
    env.prepare(
      invoke("run_code", {
        code: `image(${JSON.stringify(`data:image/png;base64,${Buffer.from(png1x1()).toString("base64")}`)}); await yield_control(); await tools.pause({});`,
      }),
    ),
    {
      codeContext: {
        tools: [{ name: "pause", description: "pause" }],
        storedValues: {},
        store: async () => {},
        resolveMedia: createMediaOutputConverter(store),
      },
      invoke: async () => {
        await gate.promise;
        return { output: "", exitCode: 0 };
      },
    },
  );
  assert.equal(first.modelContent?.[0]?.type, "image");
  assert.equal(
    (first.structuredContent as { status: string }).status,
    "running",
  );
  gate.resolve();
  const final = await env.waitRuntime.execute(
    invoke("wait", {
      task_id: (first.structuredContent as { task_id: string }).task_id,
      yield_time_ms: 1000,
    }),
  );
  assert.equal(
    (final.structuredContent as { status: string }).status,
    "completed",
  );
  assert.equal(final.modelContent, undefined);
});
