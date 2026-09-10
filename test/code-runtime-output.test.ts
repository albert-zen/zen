import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodeRuntime } from "../src/code-runtime.js";
import { ToolOutputSpool } from "../src/tool-output-spool.js";
import { ShellToolRuntime, ToolEnvironment } from "../src/tool.js";

test("nested shell preserves small output and returns readable receipts above the spool preview", async (t) => {
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
    "row\n".repeat(75000),
  ];
  for (const [i, sample] of samples.entries())
    await writeFile(join(cwd, `sample-${i}`), sample);
  let call = 0;
  const result = await new CodeRuntime().execute({
    code: `const results = await Promise.all([0,1,2,3].map(i => tools.shell({command: 'cat sample-' + i + (i === 3 ? '; exit 7' : '')}))); for (const r of results) text(r);`,
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
  assert.equal(rows.length, samples.length);
  for (const [i, row] of rows.entries()) {
    assert.equal(row.exitCode, i === 3 ? 7 : 0);
    if (i === 0) {
      assert.equal(row.output, samples[i]);
      continue;
    }
    assert.match(row.output, /\[tool output receipt\]/);
    assert.match(
      row.output,
      new RegExp(`captured_bytes: ${Buffer.byteLength(samples[i]!)}`),
    );
    assert.match(row.output, /source_truncated: false/);
    const path = /^full_output: (.+)$/m.exec(row.output)?.[1];
    assert.ok(path);
    assert.equal(await readFile(path, "utf8"), samples[i]);
    assert.ok(
      row.output.includes(
        createHash("sha256").update(samples[i]!).digest("hex"),
      ),
    );
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
  assert.deepEqual(await invoke("# comment"), { output: "", exitCode: 0 });
});
