import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ShellToolRuntime,
  ToolEnvironment,
  capturedToolOutput,
} from "../src/tool.js";
import { ToolOutputSpool, renderToolOutput } from "../src/tool-output-spool.js";
import {
  RtkShellOutputFilter,
  RTK_EXPERIMENT_SHA256,
  type ShellOutputFilter,
} from "../src/shell-output-filter.js";

async function fixture(filterOutput: ShellOutputFilter["filter"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-filter-test-"));
  const marker = path.join(root, "runs.txt");
  const script = path.join(root, "fixture.cjs");
  await writeFile(
    script,
    `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'once\\n');process.stdout.write('raw-only-marker\\n'.repeat(1000));setTimeout(()=>{process.stdout.write('failure detail\\n');process.exitCode=7;},100);`,
  );
  let filtered = 0;
  const filter: ShellOutputFilter = {
    id: "test-filter/v1",
    maxInputBytes: 1024 * 1024,
    matches: () => true,
    filter: async (raw, signal) => {
      filtered++;
      return await filterOutput(raw, signal);
    },
  };
  const spool = new ToolOutputSpool({
    rootDirectory: path.join(root, "spool"),
  });
  const shell = new ShellToolRuntime({
    toolOutputSpool: spool,
    experimentalOutputFilter: filter,
  });
  const env = new ToolEnvironment({
    runtimes: [shell],
    taskOptions: { yieldTimeMs: 1 },
    toolOutputSpool: spool,
  });
  const invocation = {
    callId: "filter",
    name: "shell",
    arguments: { command: `"${process.execPath}" "${script}"` },
    cwd: root,
    threadId: "t",
    signal: new AbortController().signal,
  };
  return {
    root,
    marker,
    spool,
    shell,
    env,
    invocation,
    count: () => filtered,
    close: async () => {
      await env.close();
      await spool.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("model shell yields without raw output, then publishes one compact result and original exit/readback", async () => {
  const f = await fixture(async (raw) => {
    assert.match(raw, /failure detail/);
    return "failure detail";
  });
  try {
    let result = await f.env.execute(
      f.env.prepare({ ...f.invocation, outputAudience: "model" }),
    );
    assert.doesNotMatch(result.output, /raw-only-marker/);
    const taskId = (result.structuredContent as { task_id: string }).task_id;
    const receipts = [result.output];
    while (
      (result.structuredContent as { status: string }).status === "running"
    ) {
      result = await f.env.waitRuntime.execute({
        ...f.invocation,
        name: "wait",
        arguments: { task_id: taskId, yield_time_ms: 1000 },
      });
      receipts.push(result.output);
    }
    assert.equal(result.exitCode, 7);
    assert.match(result.output, /failure detail/);
    assert.doesNotMatch(receipts.join(""), /raw-only-marker/);
    assert.equal(f.count(), 1);
    assert.equal(await readFile(f.marker, "utf8"), "once\n");
    const rawPath = /^raw_output: (.+)$/mu.exec(result.output)?.[1];
    assert(rawPath);
    assert.match(await readFile(rawPath, "utf8"), /raw-only-marker/);
    assert(
      Buffer.byteLength(receipts.join("")) <
        Buffer.byteLength(await readFile(rawPath)),
    );
  } finally {
    await f.close();
  }
});

test("filter failure returns captured diagnostics without executing the command again", async () => {
  const f = await fixture(async () => {
    throw new Error("filter failed");
  });
  try {
    const result = await f.shell.execute({
      ...f.invocation,
      outputAudience: "model",
    });
    assert.equal(result.exitCode, 7);
    assert.match(result.output, /raw-only-marker/);
    assert.match(result.output, /failure detail/);
    assert.equal(await readFile(f.marker, "utf8"), "once\n");
    assert.match(JSON.stringify(result.structuredContent), /filter failed/);
  } finally {
    await f.close();
  }
});

test("programmatic shell consumers and callers without explicit model audience keep raw strings", async () => {
  const f = await fixture(async () => {
    throw new Error("must not filter program data");
  });
  try {
    for (const outputAudience of [undefined, "program"] as const) {
      const result = await f.shell.execute({
        ...f.invocation,
        ...(outputAudience === undefined ? {} : { outputAudience }),
      });
      assert.equal(result.exitCode, 7);
      assert.match(
        renderToolOutput(capturedToolOutput(result)!),
        /raw-only-marker/,
      );
    }
    assert.equal(f.count(), 0);
  } finally {
    await f.close();
  }
});

test("cancelling during filtering returns already captured diagnostics and settles once", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const f = await fixture(async (_raw, signal) => {
    entered();
    return await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), {
        once: true,
      });
    });
  });
  const controller = new AbortController();
  try {
    const pending = f.shell.execute({
      ...f.invocation,
      outputAudience: "model",
      signal: controller.signal,
    });
    await ready;
    controller.abort();
    const result = await pending;
    assert.equal(result.exitCode, 7);
    assert.match(result.output, /failure detail/);
    assert.equal(await readFile(f.marker, "utf8"), "once\n");
  } finally {
    await f.close();
  }
});

test("RTK experimental matching excludes scripts, redirection and unsupported formats", () => {
  const filter = new RtkShellOutputFilter({
    executable: path.resolve("rtk"),
    sha256: RTK_EXPERIMENT_SHA256,
  });
  for (const command of [
    "cargo test --message-format=json",
    "cargo test | cat",
    "cargo test > log",
    "cargo test && echo done",
    "cargo test\n",
    "go test",
    "npm test",
    "git diff",
  ])
    assert.equal(filter.matches(command), false, command);
  assert.equal(
    filter.matches("cargo test --offline"),
    process.platform === "darwin" && process.arch === "arm64",
  );
});

test("task wait cancellation during presentation keeps diagnostics and the cancellation exit contract", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await fixture(async (_raw, signal) => {
    entered();
    return await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), {
        once: true,
      });
    });
  });
  try {
    const first = await f.env.execute(
      f.env.prepare({ ...f.invocation, outputAudience: "model" }),
    );
    const taskId = (first.structuredContent as { task_id: string }).task_id;
    await ready;
    const last = await f.env.waitRuntime.execute({
      ...f.invocation,
      name: "wait",
      arguments: { task_id: taskId, terminate: true, yield_time_ms: 1000 },
    });
    assert.equal(last.exitCode, 130);
    assert.equal(
      (last.structuredContent as { status: string }).status,
      "cancelled",
    );
    assert.match(renderToolOutput(capturedToolOutput(last)!), /failure detail/);
    assert.equal(await readFile(f.marker, "utf8"), "once\n");
  } finally {
    await f.close();
  }
});
