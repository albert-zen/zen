import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHostedAppServer } from "../apps/cli/src/host.js";
import { ToolOutputSpool } from "../src/tool-output-spool.js";
import {
  ShellToolRuntime,
  ToolEnvironment,
  type ToolInvocation,
} from "../src/tool.js";

function invocation(
  name: string,
  arguments_: Record<string, unknown>,
  options: { signal?: AbortSignal; threadId?: string } = {},
) {
  return {
    callId: `call-${name}`,
    name,
    arguments: arguments_,
    cwd: process.cwd(),
    signal: options.signal ?? new AbortController().signal,
    threadId: options.threadId ?? "thread-a",
  };
}

function sessionId(output: string): string {
  const match = /^task_id: ([a-f0-9-]+)$/mu.exec(output);
  assert(match?.[1], `missing task_id in ${JSON.stringify(output)}`);
  return match[1];
}

function status(result: { structuredContent?: unknown }): unknown {
  const content = result.structuredContent;
  return typeof content === "object" && content !== null && "status" in content
    ? content.status
    : undefined;
}

function structuredSessionId(value: unknown): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    "task_id" in value &&
    typeof value.task_id === "string"
    ? value.task_id
    : undefined;
}

async function within<T>(operation: Promise<T>, milliseconds = 1_000) {
  return await Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`operation exceeded ${String(milliseconds)}ms`)),
        milliseconds,
      ).unref();
    }),
  ]);
}

async function waitForProcessExit(pid: number, milliseconds = 1_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
      throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`process ${String(pid)} survived shell termination`);
}

test(
  "inherited background pipes yield a session and wait reports completion",
  { skip: process.platform === "win32" },
  async () => {
    const shell = createShell({ initialYieldMs: 25 });
    try {
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        'setTimeout(() => process.stdout.write("later"), 80)',
      )} &`;
      const started = await within(
        shell.execute(invocation("shell", { command })),
        500,
      );

      assert.equal(started.exitCode, 0);
      assert.match(started.output, /tool task running/u);
      const firstWait = await within(
        shell.waitRuntime.execute(
          invocation("wait", {
            task_id: sessionId(started.output),
            yield_time_ms: 500,
          }),
        ),
      );
      const completed =
        status(firstWait) === "completed"
          ? firstWait
          : await within(
              shell.waitRuntime.execute(
                invocation("wait", {
                  task_id: sessionId(firstWait.output),
                  yield_time_ms: 500,
                }),
              ),
            );
      assert.match(`${firstWait.output}${completed.output}`, /later/u);
      assert.equal(status(completed), "completed");
    } finally {
      await shell.close();
    }
  },
);

test(
  "a hard timeout returns partial output and kills the owned process group",
  { skip: process.platform === "win32" },
  async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "zen-shell-timeout-"),
    );
    const marker = path.join(temporaryDirectory, "pid");
    const shell = createShell({
      initialYieldMs: 500,
      defaultTimeoutMs: 60,
      terminationGraceMs: 20,
    });
    try {
      const command = [
        "trap '' TERM",
        `printf '%s' "$$" > ${JSON.stringify(marker)}`,
        "printf partial",
        "while :; do :; done",
      ].join("; ");
      const result = await within(
        shell.execute(invocation("shell", { command })),
      );
      const pid = Number(await readFile(marker, "utf8"));

      assert.equal(result.exitCode, 124);
      assert.match(result.output, /partial/u);
      assert.match(result.output, /timed_out/u);
      await waitForProcessExit(pid);
    } finally {
      await shell.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "aborting shell returns partial output and kills a redirected TERM-ignoring descendant",
  { skip: process.platform === "win32" },
  async () => {
    const controller = new AbortController();
    const shell = createShell({
      initialYieldMs: 500,
      terminationGraceMs: 20,
    });
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "zen-shell-abort-"),
    );
    const marker = path.join(temporaryDirectory, "pid");
    const descendantReady = path.join(temporaryDirectory, "descendant-ready");
    try {
      const command = [
        `(trap '' TERM; printf ready > ${JSON.stringify(descendantReady)}; while :; do :; done) >/dev/null 2>&1 & descendant=$!`,
        "printf before-abort",
        `printf '%s|%s' "$$" "$descendant" > ${JSON.stringify(marker)}`,
        "wait",
      ].join("; ");
      const operation = shell.execute(
        invocation("shell", { command }, { signal: controller.signal }),
      );
      const pids = (await waitForFile(marker))
        .split("|")
        .map((value) => Number(value));
      await waitForFile(descendantReady);
      controller.abort();
      const result = await within(operation);

      assert.equal(result.exitCode, 130);
      assert.match(result.output, /before-abort/u);
      assert.match(result.output, /cancelled/u);
      for (const pid of pids) await waitForProcessExit(pid);
    } finally {
      await shell.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  },
);

test("wait sessions are owned by one thread", async () => {
  const shell = createShell({ initialYieldMs: 20 });
  try {
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      "setTimeout(() => undefined, 150)",
    )}`;
    const started = await shell.execute(invocation("shell", { command }));
    const id = sessionId(started.output);

    await assert.rejects(
      shell.waitRuntime.execute(
        invocation("wait", { task_id: id }, { threadId: "thread-b" }),
      ),
      /not found for this thread/u,
    );
    const completed = await shell.waitRuntime.execute(
      invocation("wait", {
        task_id: id,
        yield_time_ms: 500,
        terminate: true,
      }),
    );
    assert.equal(completed.exitCode, 130);
    assert.equal(status(completed), "cancelled");
  } finally {
    await shell.close();
  }
});

test(
  "the originating turn signal still cancels a yielded session",
  { skip: process.platform === "win32" },
  async () => {
    const controller = new AbortController();
    const shell = createShell({
      initialYieldMs: 20,
      terminationGraceMs: 20,
    });
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "zen-shell-yield-abort-"),
    );
    const marker = path.join(temporaryDirectory, "pid");
    try {
      const started = await shell.execute(
        invocation(
          "shell",
          {
            command: `printf '%s' "$$" > ${JSON.stringify(marker)}; while :; do :; done`,
          },
          { signal: controller.signal },
        ),
      );
      const pid = Number(await waitForFile(marker));
      controller.abort();
      const completed = await shell.waitRuntime.execute(
        invocation("wait", {
          task_id: sessionId(started.output),
          yield_time_ms: 500,
        }),
      );

      assert.equal(completed.exitCode, 130);
      assert.equal(status(completed), "cancelled");
      await waitForProcessExit(pid);
    } finally {
      await shell.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  },
);

test("the host-local session count is bounded", async () => {
  const shell = createShell({ initialYieldMs: 10, maxSessions: 1 });
  try {
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      "setTimeout(() => undefined, 500)",
    )}`;
    const started = await shell.execute(invocation("shell", { command }));
    await assert.rejects(
      shell.execute(invocation("shell", { command })),
      /task limit reached/u,
    );
    await shell.waitRuntime.execute(
      invocation("wait", {
        task_id: sessionId(started.output),
        terminate: true,
      }),
    );
  } finally {
    await shell.close();
  }
});

test("completion during a delayed running capture keeps the session waitable", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zen-shell-capture-race-"),
  );
  const spool = new ToolOutputSpool({
    rootDirectory: path.join(temporaryDirectory, "spool"),
  });
  const originalBeginCapture = spool.beginCapture.bind(spool);
  let captureFinishStarted!: () => void;
  const finishStarted = new Promise<void>((resolve) => {
    captureFinishStarted = resolve;
  });
  let releaseCaptureFinish!: () => void;
  const captureFinishGate = new Promise<void>((resolve) => {
    releaseCaptureFinish = resolve;
  });
  let delayFirstFinish = true;
  Object.defineProperty(spool, "beginCapture", {
    value: (...arguments_: Parameters<ToolOutputSpool["beginCapture"]>) => {
      const capture = originalBeginCapture(...arguments_);
      if (delayFirstFinish) {
        delayFirstFinish = false;
        const finish = capture.finish.bind(capture);
        Object.defineProperty(capture, "finish", {
          value: async (...finishArguments: Parameters<typeof finish>) => {
            captureFinishStarted();
            await captureFinishGate;
            return await finish(...finishArguments);
          },
        });
      }
      return capture;
    },
  });
  const shell = createShell({
    toolOutputSpool: spool,
    initialYieldMs: 10,
    retentionMs: 1,
  });
  try {
    const release = path.join(temporaryDirectory, "release");
    const completedMarker = path.join(temporaryDirectory, "completed");
    const command = [
      "printf head",
      `while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.005; done`,
      "printf tail",
      `printf done > ${JSON.stringify(completedMarker)}`,
    ].join("; ");
    const operation = shell.execute(invocation("shell", { command }));
    await finishStarted;
    await writeFile(release, "release");
    await waitForFile(completedMarker);
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseCaptureFinish();
    const yielded = await operation;
    assert.equal(status(yielded), "running");
    const id = structuredSessionId(yielded.structuredContent);
    assert(id !== undefined);

    const completed = await shell.waitRuntime.execute(
      invocation("wait", {
        task_id: id,
        yield_time_ms: 500,
      }),
    );
    assert.equal(status(completed), "completed");
    assert.match(completed.output, /tail/u);
  } finally {
    await shell.close();
    await spool.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("legacy unscoped quick shell execution keeps exact output", async () => {
  const shell = createShell();
  try {
    const result = await shell.execute({
      callId: "legacy-shell",
      name: "shell",
      arguments: { command: "printf exact" },
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    assert.deepEqual(result, { output: "exact", exitCode: 0 });
  } finally {
    await shell.close();
  }
});

test(
  "Host shutdown terminates its active shell sessions",
  { skip: process.platform === "win32" },
  async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "zen-shell-host-close-"),
    );
    const marker = path.join(temporaryDirectory, "pid");
    const server = createHostedAppServer({
      cwd: temporaryDirectory,
      dataDirectory: path.join(temporaryDirectory, "data"),
      provider: { type: "fake" },
      model: "fake",
      approvalPolicy: "never",
    });
    try {
      const command = `printf '%s' "$$" > ${JSON.stringify(marker)}; while :; do :; done`;
      const thread = await server.startThread();
      await (
        await server.startTurn(
          thread.id,
          `!tool shell ${JSON.stringify({ command, yield_time_ms: 10 })}`,
        )
      ).done;
      const pid = Number(await waitForFile(marker));

      await within(server.closeHostResources());
      await waitForProcessExit(pid);
    } finally {
      await server.closeHostResources();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  },
);

async function waitForFile(filename: string): Promise<string> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(filename, "utf8");
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("file was not created");
}

function createShell(
  options: {
    initialYieldMs?: number;
    defaultTimeoutMs?: number;
    maxSessions?: number;
    retentionMs?: number;
    terminationGraceMs?: number;
    toolOutputSpool?: ToolOutputSpool;
    maxOutputBytes?: number;
  } = {},
) {
  const {
    initialYieldMs,
    defaultTimeoutMs,
    maxSessions,
    retentionMs,
    ...bodyOptions
  } = options;
  const env = new ToolEnvironment({
    runtimes: [new ShellToolRuntime(bodyOptions)],
    taskOptions: {
      ...(initialYieldMs === undefined ? {} : { yieldTimeMs: initialYieldMs }),
      ...(defaultTimeoutMs === undefined
        ? {}
        : { timeoutMs: defaultTimeoutMs }),
      ...(maxSessions === undefined ? {} : { maxTasks: maxSessions }),
      ...(retentionMs === undefined ? {} : { retentionMs }),
      ...(bodyOptions.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: bodyOptions.maxOutputBytes }),
    },
    ...(bodyOptions.toolOutputSpool === undefined
      ? {}
      : { toolOutputSpool: bodyOptions.toolOutputSpool }),
  });
  return {
    execute: (invocation: ToolInvocation) =>
      env.execute(env.prepare(invocation)),
    waitRuntime: env.waitRuntime,
    close: () => env.close(),
  };
}
