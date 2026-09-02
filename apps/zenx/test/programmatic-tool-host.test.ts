import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AppServerManager } from "../src/main/app-server-manager.js";

test("ZenX source Host runs the CLI programmatic tool contract", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-programmatic-host-"),
  );
  const manager = new AppServerManager({
    entryPath: fileURLToPath(
      new URL("../src/main/app-server-host.ts", import.meta.url),
    ),
    tokenFile: path.join(directory, "app-server.token"),
    hostConfig: {
      cwd: directory,
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      provider: { type: "fake" },
      toolPresentation: "both",
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
  try {
    await manager.start();
    const started = await manager.request("thread/start", {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const completed = deferred<void>();
    const dispose = manager.onNotification((method) => {
      if (method === "turn/completed") completed.resolve();
    });
    await manager.request("turn/start", {
      threadId: started.thread.id,
      input: [
        {
          type: "text",
          text: '!tool run_code {"code":"const value: number = 40 + 2; const nested = await tools.shell({ command: \\"printf child\\" }); text(`${value}:${nested.output}`);","description":"host composition tracer"}',
        },
      ],
    });
    await within(completed.promise);
    dispose();

    const read = await manager.request("thread/read", {
      threadId: started.thread.id,
      includeTurns: true,
    });
    const commands = read.thread.turns.flatMap((turn) =>
      turn.items.filter((item) => item.type === "commandExecution"),
    );
    assert.deepEqual(
      commands.map((command) => [
        command.toolName,
        command.parentCallId ?? null,
        command.status,
      ]),
      [
        ["run_code", null, "completed"],
        ["shell", commands[0]?.callId, "completed"],
      ],
    );
    assert.equal(commands[0]?.command.includes("const value: number"), true);
    assert.equal(commands[0]?.aggregatedOutput, "42:child");
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, milliseconds = 10_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for ZenX Host Turn")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
