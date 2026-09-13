import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ToolEnvironment,
  ShellToolRuntime,
  attachToolOutputCapture,
  type ToolRuntime,
} from "../src/tool.js";
import { ToolOutputSpool } from "../src/tool-output-spool.js";
import { CodeRuntime, RunCodeToolRuntime } from "../src/code-runtime.js";
const invocation = (
  cwd: string,
  name: string,
  args: Record<string, unknown> = {},
) => ({
  cwd,
  name,
  arguments: args,
  callId: randomUUID(),
  threadId: "payload",
  signal: new AbortController().signal,
});
async function guest(env: ToolEnvironment, cwd: string, code: string) {
  return (
    await new CodeRuntime().execute({
      code,
      signal: new AbortController().signal,
      nested: {
        invoke: async (name, args, signal) =>
          env.execute(
            env.prepare({
              ...invocation(cwd, name, args),
              signal: signal!,
              task: { waitForCompletion: true },
            }),
          ),
      },
    })
  ).text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("unspooled shell truncation is never a complete program payload", async (t) => {
  const env = new ToolEnvironment({
    runtimes: [new ShellToolRuntime()],
    taskOptions: { maxOutputBytes: 100 },
  });
  t.after(() => env.close());
  const [r] = await guest(
    env,
    process.cwd(),
    `text(await tools.shell({command:"printf '%0200d' 0"}));`,
  );
  assert.equal(r.output, null);
  assert.equal(r.outputInfo.complete, false);
  assert.equal(r.outputInfo.sourceTruncated, true);
  assert.equal(r.outputInfo.capturedBytes, 100);
});

test("unspooled wait keeps raw JSON apart from control diagnostics", async (t) => {
  const cwd = process.cwd();
  const env = new ToolEnvironment({
    runtimes: [new ShellToolRuntime()],
    taskOptions: { yieldTimeMs: 1 },
  });
  t.after(() => env.close());
  const first = await env.execute(
    env.prepare(
      invocation(cwd, "shell", { command: `sleep 0.05; printf '{"ok":true}'` }),
    ),
  );
  const id = (first.structuredContent as { task_id: string }).task_id;
  const [r] = await guest(
    env,
    cwd,
    `text(await tools.wait({task_id:${JSON.stringify(id)},yield_time_ms:500}));`,
  );
  assert.deepEqual(JSON.parse(r.output), { ok: true });
  assert.match(r.diagnostic, /tool task completed/);
  assert.equal(r.outputInfo.capturedBytes, 11);
});

test("concurrent cancellation snapshot keeps control text out of program payload", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "zen-snapshot-"));
  const spool = new ToolOutputSpool({ rootDirectory: cwd });
  let resolve!: (r: { output: string; exitCode: number }) => void;
  const pending = new Promise<{ output: string; exitCode: number }>((r) => {
    resolve = r;
  });
  const tool: ToolRuntime = {
    name: "remote",
    specification: {
      name: "remote",
      description: "remote",
      inputSchema: { type: "object" },
    },
    execute: async () => pending,
  };
  const env = new ToolEnvironment({
    runtimes: [tool],
    toolOutputSpool: spool,
    taskOptions: { yieldTimeMs: 1, shutdownWaitMs: 1 },
  });
  t.after(async () => {
    resolve({ output: "finished", exitCode: 0 });
    await env.close();
    await spool.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const first = await env.execute(env.prepare(invocation(cwd, "remote")));
  const id = (first.structuredContent as { task_id: string }).task_id;
  const rows = await guest(
    env,
    cwd,
    `const id=${JSON.stringify(id)};for(const r of await Promise.all([tools.wait({task_id:id,yield_time_ms:50}),tools.wait({task_id:id,terminate:true,yield_time_ms:1})]))text(r);`,
  );
  for (const r of rows) {
    assert.equal(r.output, "");
    assert.match(r.diagnostic, /tool task/);
    assert.equal(r.outputInfo.complete, true);
  }
  assert.ok(
    rows.some((r) => r.structuredContent.status === "cancellation_unconfirmed"),
  );
});

test("progress and a captured final result combine raw bytes without rendering receipts", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "zen-progress-"));
  const spool = new ToolOutputSpool({ rootDirectory: cwd });
  const payload = JSON.stringify({ s: "x".repeat(9000) });
  const tool: ToolRuntime = {
    name: "sample",
    specification: {
      name: "sample",
      description: "sample",
      inputSchema: { type: "object" },
    },
    async execute(call) {
      call.taskContext!.onOutput("progress\n");
      return attachToolOutputCapture(
        { output: "", exitCode: 7 },
        await spool.captureText(payload),
        "\ncontrol diagnostic",
      );
    },
  };
  const env = new ToolEnvironment({ runtimes: [tool], toolOutputSpool: spool });
  t.after(async () => {
    await env.close();
    await spool.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const direct = await env.execute(
    env.prepare({
      ...invocation(cwd, "sample"),
      task: { waitForCompletion: true },
    }),
  );
  assert.match(direct.output, /control diagnostic$/);
  const [r] = await guest(env, cwd, `text(await tools.sample({}));`);
  assert.equal(r.output, "progress\n" + payload);
  assert.equal(r.diagnostic, "\ncontrol diagnostic");
  assert.equal(r.outputInfo.complete, true);
  assert.equal(r.exitCode, 7);
});

for (const spooled of [false, true])
  test(`failed run_code wait preserves only emitted text (spool=${spooled})`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "zen-code-failed-"));
    const spool = spooled
      ? new ToolOutputSpool({ rootDirectory: cwd })
      : undefined;
    const env = new ToolEnvironment({
      runtimes: [new RunCodeToolRuntime()],
      ...(spool === undefined ? {} : { toolOutputSpool: spool }),
      taskOptions: { yieldTimeMs: 1 },
    });
    t.after(async () => {
      await env.close();
      await spool?.close();
      await rm(cwd, { recursive: true, force: true });
    });
    const first = await env.execute(
      env.prepare(
        invocation(cwd, "run_code", {
          code: 'text("RAW"); throw new Error("QA_CODE_FAILURE");',
        }),
      ),
      {
        invoke: async () => {
          throw new Error("Unexpected child tool call");
        },
      },
    );
    const id = (first.structuredContent as { task_id: string }).task_id;
    const [r] = await guest(
      env,
      cwd,
      `text(await tools.wait({task_id:${JSON.stringify(id)},yield_time_ms:1000}));`,
    );
    assert.equal(r.output, "RAW");
    assert.equal(r.outputInfo.capturedBytes, 3);
    assert.match(r.diagnostic, /QA_CODE_FAILURE/);
    assert.equal(r.exitCode, 1);
  });
