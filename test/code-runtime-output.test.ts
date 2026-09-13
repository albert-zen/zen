import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodeRuntime } from "../src/code-runtime.js";
import { ToolOutputSpool } from "../src/tool-output-spool.js";
import { ShellToolRuntime, ToolEnvironment } from "../src/tool.js";

test("nested shell preserves raw payload across the model preview boundary", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "zen-nested-output-"));
  const spool = new ToolOutputSpool({ rootDirectory: join(cwd, "spool") });
  const env = new ToolEnvironment({
    runtimes: [new ShellToolRuntime()],
    toolOutputSpool: spool,
  });
  t.after(async () => {
    await env.close();
    await spool.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const samples = [
    "x".repeat(8192),
    "x".repeat(8193),
    "中".repeat(3000),
    JSON.stringify({
      items: Array.from({ length: 20000 }, (_, i) => ({
        id: i,
        label: "中文数据",
      })),
    }),
  ];
  for (const [i, sample] of samples.entries())
    await writeFile(join(cwd, `sample-${i}`), sample);
  let call = 0;
  const result = await new CodeRuntime().execute({
    code: `const results = await Promise.all([0,1,2,3].map(i => tools.shell({command: 'cat sample-' + i + (i === 3 ? '; exit 7' : '')}))); for (const r of results) text(r); text({count: JSON.parse(results[3].output).items.length});`,
    signal: new AbortController().signal,
    nested: {
      async invoke(name, args, signal) {
        return await env.execute(
          env.prepare({
            name,
            arguments: args,
            signal: signal ?? new AbortController().signal,
            cwd,
            callId: String(++call),
            threadId: "test",
            task: { waitForCompletion: true },
          }),
        );
      },
    },
  });
  const rows = result.text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(rows.pop().count, 20000);
  assert.equal(rows.length, samples.length);
  for (const [i, row] of rows.entries()) {
    assert.equal(row.exitCode, i === 3 ? 7 : 0);
    assert.equal(row.output, samples[i]);
    assert.equal(row.outputInfo.complete, true);
    assert.equal(row.outputInfo.capturedBytes, Buffer.byteLength(samples[i]!));
  }
});

test("shell rejects whitespace but permits comment-only commands", async () => {
  const shell = new ShellToolRuntime();
  const invoke = (command: string) =>
    shell.execute({
      name: "shell",
      callId: "blank",
      cwd: process.cwd(),
      arguments: { command },
      signal: new AbortController().signal,
    });
  for (const command of ["", "   ", "\n"])
    await assert.rejects(invoke(command), /must be a non-empty string/);
  const comment = await invoke("# comment");
  assert.equal(comment.output, "");
  assert.equal(comment.exitCode, 0);
});

test("program limits and unavailable captures are explicit without overwriting tool content", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "zen-program-info-"));
  const spool = new ToolOutputSpool({ rootDirectory: cwd });
  t.after(async () => {
    await spool.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const { attachToolOutputCapture } = await import("../src/tool.js");
  const { readFile } = await import("node:fs/promises");
  const exact = await spool.captureText("x".repeat(1024 * 1024));
  const large = await spool.captureText("x".repeat(1024 * 1024 + 1));
  const limited = spool.beginCapture({ maxCaptureBytes: 10000 });
  limited.write("中".repeat(5000));
  const truncated = await limited.finish();
  const missing = await spool.captureText("x".repeat(9000));
  await rm(missing.path!);
  const changed = await spool.captureText("x".repeat(9000));
  await writeFile(changed.path!, "y".repeat(9000));
  const captures = [exact, large, truncated, missing, changed];
  const result = await new CodeRuntime().execute({
    signal: new AbortController().signal,
    nested: {
      async invoke(_name, args) {
        return attachToolOutputCapture(
          {
            output: "",
            exitCode: 7,
            contentType: "application/json",
            structuredContent: { business: true },
          },
          captures[Number(args.i)]!,
          "\ncontrol diagnostic",
        );
      },
    },
    code: `for(let i=0;i<5;i++){const r=await tools.sample({i});text({...r, output:r.output === null ? null : r.output.length});}`,
  });
  const rows = result.text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(rows[0].output, 1024 * 1024);
  assert.equal(rows[0].outputInfo.complete, true);
  for (const [i, reason] of [
    "program_limit",
    "source_truncated",
    "unavailable",
    "unavailable",
  ].entries()) {
    assert.equal(rows[i + 1].output, null);
    assert.equal(rows[i + 1].outputInfo.complete, false);
    assert.equal(rows[i + 1].outputInfo.reason, reason);
  }
  assert.equal(rows[2].outputInfo.capturedBytes, 9999);
  assert.equal(rows[2].outputInfo.sourceTruncated, true);
  assert.equal(
    (await readFile(rows[1].outputInfo.fullOutput.path)).length,
    1024 * 1024 + 1,
  );
  for (const row of rows) {
    assert.equal(row.exitCode, 7);
    assert.equal(row.diagnostic, "\ncontrol diagnostic");
    assert.equal(row.contentType, "application/json");
    assert.deepEqual(row.structuredContent, { business: true });
  }
});
