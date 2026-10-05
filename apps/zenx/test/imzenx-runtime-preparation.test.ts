import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runTrustedImRuntimeSetup,
  ImRuntimeSetupOwnershipError,
} from "../src/main/imzenx-runtime-preparation.js";
import {
  ZenXTriggerProgramRunner,
  type TriggerProgramRunResult,
} from "../src/main/trigger-program-runner.js";

test("runtime setup uses the existing tree-owned runner with locked own environment and discards diagnostics", async () => {
  let invocation: any;
  const project = path.resolve("synthetic-im-runtime");
  await runTrustedImRuntimeSetup(project, new AbortController().signal, {
    runner: {
      run: async (spec) => {
        invocation = spec;
        return {
          status: "malformed_output",
          exitCode: 0,
          output: "synthetic-secret",
          error: "synthetic-secret",
        };
      },
    },
  });
  assert.equal(invocation.command, "uv");
  assert.ok(invocation.args.includes("--locked"));
  assert.equal(
    invocation.env.UV_PROJECT_ENVIRONMENT,
    path.join(project, ".venv"),
  );
  assert.equal(
    invocation.env.UV_PYTHON_INSTALL_DIR,
    path.join(project, ".python"),
  );
  assert.equal(invocation.env.GIT_TERMINAL_PROMPT, "0");
  for (const result of [
    { status: "nonzero_exit", exitCode: 1, error: "synthetic-secret" },
    { status: "timed_out", exitCode: null, error: "synthetic-secret" },
  ])
    await assert.rejects(
      runTrustedImRuntimeSetup(project, new AbortController().signal, {
        runner: {
          run: async () =>
            ({
              ...result,
              output: "synthetic-secret",
            }) as TriggerProgramRunResult,
        },
      }),
      (error: any) =>
        /failed or was cancelled/.test(error.message) &&
        !error.message.includes("synthetic-secret"),
    );
  await assert.rejects(
    runTrustedImRuntimeSetup(project, new AbortController().signal, {
      runner: {
        run: async () => ({
          status: "cancelled",
          exitCode: null,
          output: null,
          error: "process-tree containment was not proven: synthetic-secret",
        }),
      },
    }),
    ImRuntimeSetupOwnershipError,
  );
});

test(
  "runtime cancellation contains a SIGTERM-resistant descendant after its leader exits",
  { skip: process.platform === "win32", timeout: 15000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "imzenx-setup-tree-"));
    const ready = path.join(root, "ready"),
      late = path.join(root, "late");
    const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{});setTimeout(()=>fs.writeFileSync(${JSON.stringify(late)},'late'),5000);setInterval(()=>{},1000);`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
    const controller = new AbortController();
    let pid = 0;
    try {
      const runner = new ZenXTriggerProgramRunner();
      const running = runTrustedImRuntimeSetup(root, controller.signal, {
        runner: {
          run: (spec, input, signal) =>
            runner.run(
              { ...spec, command: process.execPath, args: ["-e", parent] },
              input,
              signal,
            ),
        },
      });
      const outcome = assert.rejects(running, /failed or was cancelled/);
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        try {
          pid = Number(await readFile(ready, "utf8"));
          if (pid > 0) break;
        } catch {
          /* Await the synthetic ready receipt. */
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(pid > 0);
      controller.abort();
      await outcome;
      assert.throws(
        () => process.kill(pid, 0),
        (error: any) => error.code === "ESRCH",
      );
      await assert.rejects(stat(late), { code: "ENOENT" });
    } finally {
      if (pid > 0)
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      await rm(root, { recursive: true, force: true });
    }
  },
);
