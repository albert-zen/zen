import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import {
  ShellToolRuntime,
  ToolEnvironment,
  type ShellLifecycleFacts,
  type ToolExecutionResult,
  type ToolInvocation,
} from "../src/tool.js";

function invocation(
  name: string,
  args: Record<string, unknown>,
): ToolInvocation {
  return {
    callId: name,
    name,
    arguments: args,
    cwd: process.cwd(),
    threadId: "shell-facts",
    signal: new AbortController().signal,
  };
}
function createShell(
  options: {
    initialYieldMs?: number;
    timeoutMs?: number;
    terminationGraceMs?: number;
  } = {},
) {
  const env = new ToolEnvironment({
    runtimes: [
      new ShellToolRuntime({
        terminationGraceMs: options.terminationGraceMs ?? 20,
      }),
    ],
    taskOptions: {
      yieldTimeMs: options.initialYieldMs ?? 10,
      timeoutMs: options.timeoutMs ?? 10_000,
    },
  });
  return {
    execute: (call: ToolInvocation) => env.execute(env.prepare(call)),
    waitRuntime: env.waitRuntime,
    close: () => env.close(),
  };
}
function facts(result: ToolExecutionResult): Record<string, unknown> {
  assert(
    result.structuredContent && typeof result.structuredContent === "object",
  );
  return result.structuredContent as Record<string, unknown>;
}
function sessionId(output: string): string {
  const id = /^task_id: (.+)$/mu.exec(output)?.[1];
  assert(id);
  return id;
}
async function waitForFile(filename: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(filename, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`File not created: ${filename}`);
}
async function observe(
  shell: ReturnType<typeof createShell>,
  result: ToolExecutionResult,
  matches: (value: Record<string, unknown>) => boolean,
) {
  const deadline = Date.now() + 5_000;
  while (!matches(facts(result))) {
    assert.equal(facts(result).status, "running");
    assert(Date.now() < deadline, JSON.stringify(facts(result)));
    result = await shell.waitRuntime.execute(
      invocation("wait", {
        task_id: sessionId(result.output),
        yield_time_ms: 10,
      }),
    );
  }
  return result;
}

test(
  "shell lifecycle reports all four foreground/stdio combinations without settling early",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zen-shell-facts-"));
    const shell = createShell({ initialYieldMs: 10 });
    try {
      for (const foreground of ["running", "exited"] as const) {
        for (const stdio of ["open", "eof"] as const) {
          const gate = path.join(directory, `${foreground}-${stdio}`);
          const loop = `while [ ! -f ${JSON.stringify(gate)} ]; do sleep 0.01; done`;
          const command =
            foreground === "exited"
              ? stdio === "open"
                ? `(${loop}; printf late-output) & exit 7`
                : "exit 7"
              : `${stdio === "eof" ? "exec 1>&- 2>&-; " : ""}${loop}; exit 7`;
          let result = await shell.execute(invocation("shell", { command }));
          // The exited/eof command may take the unchanged quick-result path.
          if (
            foreground === "exited" &&
            stdio === "eof" &&
            !result.structuredContent
          ) {
            assert.equal(result.exitCode, 7);
            continue;
          }
          const taskId = sessionId(result.output);
          const deadline = Date.now() + 2_000;
          while (true) {
            const facts = result.structuredContent as Record<string, unknown>;
            if (facts.foreground === foreground && facts.stdio === stdio) break;
            assert(Date.now() < deadline, JSON.stringify(facts));
            assert.equal(facts.status, "running");
            result = await shell.waitRuntime.execute(
              invocation("wait", {
                task_id: taskId,
                yield_time_ms: 10,
              }),
            );
          }
          const facts = result.structuredContent as Record<string, unknown>;
          if (foreground === "exited" && stdio === "open") {
            assert.equal(facts.status, "running");
            assert.equal(facts.exit_code, null);
            assert.equal(facts.foreground_exit_code, 7);
            assert.equal(facts.foreground_signal, null);
            assert.match(result.output, /running \(foreground_exited\)/);
          } else assert.doesNotMatch(result.output, /\(foreground_exited\)/);
          if (foreground === "running") {
            assert.equal(facts.status, "running");
            assert.equal(facts.foreground_exit_code, undefined);
          }
          if (facts.status === "running") {
            await writeFile(gate, "release");
            const completed = await shell.waitRuntime.execute(
              invocation("wait", {
                task_id: taskId,
                yield_time_ms: 2_000,
              }),
            );
            const final = completed.structuredContent as Record<
              string,
              unknown
            >;
            assert.equal(final.status, "failed");
            assert.equal(final.foreground, "exited");
            assert.equal(final.stdio, "eof");
            assert.equal(final.foreground_exit_code, 7);
            assert.equal(final.exit_code, 7);
            assert.doesNotMatch(completed.output, /\(foreground_exited\)/);
            if (foreground === "exited")
              assert.match(completed.output, /late-output/);
          }
        }
      }
    } finally {
      await shell.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("shell lifecycle ordinary process reports spawn and exit on every platform", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-shell-normal-"));
  const gate = path.join(directory, "release");
  const shell = createShell();
  try {
    const script =
      "const fs = require('node:fs'); const t = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(t); process.stdout.write('done'); process.exitCode = 9; } }, 10)";
    const started = await shell.execute(
      invocation("shell", {
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)} ${JSON.stringify(gate)}`,
      }),
    );
    const running = await observe(
      shell,
      started,
      (value) => value.foreground === "running",
    );
    assert.equal(facts(running).stdio, "open");
    assert.equal(facts(running).foreground_exit_code, undefined);
    await writeFile(gate, "release");
    const completed = await shell.waitRuntime.execute(
      invocation("wait", {
        task_id: sessionId(running.output),
        yield_time_ms: 5_000,
      }),
    );
    assert.equal(facts(completed).foreground, "exited");
    assert.equal(facts(completed).stdio, "eof");
    assert.equal(facts(completed).foreground_exit_code, 9);
    assert.equal(facts(completed).foreground_signal, null);
    assert.equal(facts(completed).status, "failed");
    assert.match(completed.output, /done/);
  } finally {
    await shell.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("shell lifecycle spawn failure does not invent a running or exited foreground", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-shell-spawn-"));
  const observations: ShellLifecycleFacts[] = [];
  let output = "";
  try {
    const runtime = new ShellToolRuntime();
    const result = await runtime.execute({
      ...invocation("shell", { command: "echo should-not-run" }),
      cwd: path.join(directory, "missing"),
      taskContext: {
        onOutput: (text) => {
          output += text;
        },
        onShellLifecycle: (value) => observations.push(value),
      },
    });
    assert.equal(result.exitCode, 1);
    assert.match(output, /shell spawn failed/);
    assert.deepEqual(observations, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const cancellation of ["terminate", "timeout"] as const) {
  test(
    `shell lifecycle ${cancellation} preserves the already observed foreground exit code`,
    { skip: process.platform === "win32" },
    async () => {
      const shell = createShell({
        timeoutMs: cancellation === "timeout" ? 300 : 10_000,
      });
      try {
        const started = await shell.execute(
          invocation("shell", { command: "(sleep 30) & exit 7" }),
        );
        const exited = await observe(
          shell,
          started,
          (value) => value.foreground === "exited",
        );
        assert.equal(facts(exited).status, "running");
        assert.equal(facts(exited).foreground_exit_code, 7);
        assert.equal(facts(exited).stdio, "open");
        const stopped = await shell.waitRuntime.execute(
          invocation("wait", {
            task_id: sessionId(exited.output),
            yield_time_ms: 5_000,
            terminate: cancellation === "terminate",
          }),
        );
        assert.equal(
          facts(stopped).status,
          cancellation === "terminate" ? "cancelled" : "timed_out",
        );
        assert.equal(
          facts(stopped).exit_code,
          cancellation === "terminate" ? 130 : 124,
        );
        assert.equal(facts(stopped).foreground_exit_code, 7);
        assert.equal(facts(stopped).foreground_signal, null);
        assert.doesNotMatch(stopped.output, /\(foreground_exited\)/);
      } finally {
        await shell.close();
      }
    },
  );
}

test(
  "shell lifecycle signal termination is not a fabricated numeric exit code",
  { skip: process.platform === "win32" },
  async () => {
    const shell = createShell();
    try {
      const started = await shell.execute(
        invocation("shell", { command: "while :; do sleep 1; done" }),
      );
      const running = await observe(
        shell,
        started,
        (value) => value.foreground === "running",
      );
      const stopped = await shell.waitRuntime.execute(
        invocation("wait", {
          task_id: sessionId(running.output),
          yield_time_ms: 5_000,
          terminate: true,
        }),
      );
      assert.equal(facts(stopped).foreground, "exited");
      assert.equal(facts(stopped).foreground_exit_code, null);
      assert.equal(facts(stopped).foreground_signal, "SIGTERM");
      assert.equal(facts(stopped).status, "cancelled");
    } finally {
      await shell.close();
    }
  },
);

test(
  "shell lifecycle forced pipe destruction does not claim EOF from an escaped holder",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zen-shell-escaped-"),
    );
    const marker = path.join(directory, "pid");
    const shell = createShell();
    let escapedPid: number | undefined;
    try {
      const childScript = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`;
      const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { detached: true, stdio: ['ignore', 1, 2] }).unref()`;
      const started = await shell.execute(
        invocation("shell", {
          command: `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
        }),
      );
      escapedPid = Number(await waitForFile(marker));
      const exited = await observe(
        shell,
        started,
        (value) => value.foreground === "exited",
      );
      assert.equal(facts(exited).foreground_exit_code, 0);
      const cancelled = await shell.waitRuntime.execute(
        invocation("wait", {
          task_id: sessionId(exited.output),
          yield_time_ms: 5_000,
          terminate: true,
        }),
      );
      assert.equal(facts(cancelled).status, "cancelled");
      assert.equal(facts(cancelled).foreground_exit_code, 0);
      assert.equal(facts(cancelled).stdio, "open");
      // The existing POSIX process-group boundary does not contain this new group.
      process.kill(escapedPid, 0);
    } finally {
      await shell.close();
      if (escapedPid !== undefined) process.kill(-escapedPid, "SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "shell lifecycle journal replay preserves receipts but cannot resume old tasks",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zen-shell-replay-"),
    );
    const options = {
      cwd: directory,
      dataDirectory: path.join(directory, "data"),
      provider: { type: "fake" as const },
      model: "fake",
      approvalPolicy: "never" as const,
    };
    const first = createHostedAppServer(options);
    let second: ReturnType<typeof createHostedAppServer> | undefined;
    try {
      const thread = await first.startThread();
      const command = "sleep 30 & exit 7";
      await (
        await first.startTurn(
          thread.id,
          `!tool shell ${JSON.stringify({ command, yield_time_ms: 100 })}`,
        )
      ).done;
      const before = (await first.readThread(thread.id)).items;
      const receipt = before.find(
        (item) =>
          item.type === "tool_result" &&
          item.structuredContent &&
          typeof item.structuredContent === "object" &&
          "task_id" in item.structuredContent,
      );
      assert(receipt?.type === "tool_result");
      const data = receipt.structuredContent as Record<string, unknown>;
      assert.equal(data.foreground, "exited");
      assert.equal(data.foreground_exit_code, 7);
      assert.equal(data.stdio, "open");
      await first.closeHostResources();
      second = createHostedAppServer(options);
      assert.deepEqual((await second.readThread(thread.id)).items, before);
      await (
        await second.startTurn(
          thread.id,
          `!tool wait ${JSON.stringify({ task_id: data.task_id, yield_time_ms: 1 })}`,
        )
      ).done;
      const after = (await second.readThread(thread.id)).items;
      const result = after.findLast((item) => item.type === "tool_result");
      assert(result?.type === "tool_result");
      assert.notEqual(result.exitCode, 0);
      assert.match(result.output, /not found for this thread/);
    } finally {
      await first.closeHostResources();
      await second?.closeHostResources();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
