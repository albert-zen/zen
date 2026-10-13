import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { ShellToolRuntime, ToolEnvironment } from "../../../src/tool.js";
import type { ShellSessionRead } from "../../../src/shell-session.js";
import { desktopShellPty } from "../src/main/shell-pty.js";
import {
  trackWindowsShellProcess,
  WINDOWS_SHELL_SHUTDOWN_WAIT_MS,
} from "../src/main/shell-process-termination.js";

// Evidence gathering only. The original service suite retains its 5s bounds.
// Run on a separate runner so this probe cannot warm the original service suite.
test(
  "observe default Windows PTY cold startup without changing shell configuration",
  {
    skip:
      process.platform !== "win32" ||
      process.env.ZENX_SHELL_STARTUP_DIAGNOSTIC !== "1",
  },
  async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "zen-pty-cold-start-"));
    const tools = new ToolEnvironment({
      shellSessions: true,
      runtimes: [
        new ShellToolRuntime({
          pty: desktopShellPty,
          trackProcess: trackWindowsShellProcess,
          ownedCleanupWaitMs: WINDOWS_SHELL_SHUTDOWN_WAIT_MS,
          environment: { ...process.env, SHELL: "/bin/sh", HOME: cwd },
        }),
      ],
    });
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    let taskId: string | undefined;
    const snapshot = (): ShellSessionRead => {
      assert(taskId);
      return tools.taskManager.readShellSession("cold-start", taskId);
    };
    const report = (stage: string) => {
      const read = snapshot();
      console.info(
        "Windows PTY startup observation",
        JSON.stringify({
          stage,
          elapsedMs: elapsed(),
          status: read.session.status,
          output: read.output.slice(-4096),
        }),
      );
    };
    const until = async (
      stage: string,
      budgetMs: number,
      predicate: (read: ShellSessionRead) => boolean,
      samples: number[] = [],
    ) => {
      const began = performance.now();
      let nextSample = 0;
      while (performance.now() - began < budgetMs) {
        const read = snapshot();
        if (predicate(read)) {
          report(stage);
          return;
        }
        if (
          nextSample < samples.length &&
          performance.now() - began >= samples[nextSample]!
        ) {
          report(`${stage}: ${samples[nextSample]}ms pending`);
          nextSample++;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      report(`${stage}: deadline`);
      throw new Error(
        `Windows PTY ${stage} did not finish within ${budgetMs}ms`,
      );
    };
    try {
      console.info(
        "Windows PTY startup configuration",
        JSON.stringify({
          os: os.release(),
          node: process.version,
          shell: "powershell.exe",
          args: ["-NoLogo"],
          columns: 80,
          rows: 24,
          backend: "default desktop adapter",
          environment: "existing sanitized Shell environment",
        }),
      );
      const result = await tools.execute(
        tools.prepare({
          name: "shell",
          callId: "cold-start",
          threadId: "cold-start",
          cwd,
          sandbox: "danger-full-access",
          arguments: { command: "Interactive shell" },
          userTerminal: { cols: 80, rows: 24 },
          task: { yieldTimeMs: 1 },
          signal: new AbortController().signal,
        }),
      );
      taskId = (result.structuredContent as { task_id?: string } | undefined)
        ?.task_id;
      assert(taskId, result.output);
      await until(
        "first prompt",
        20_000,
        (read) => /PS [^\r\n]*> /u.test(stripVTControlCharacters(read.output)),
        [5_000, 10_000],
      );
      const marker = path.join(cwd, "executed.txt").replaceAll("'", "''");
      tools.taskManager.writeShellSession(
        "cold-start",
        taskId,
        `[IO.File]::WriteAllText('${marker}','ok');[Console]::WriteLine(('BOOT_'+'READY'));[Console]::WriteLine($PSVersionTable.PSVersion.ToString())\r`,
      );
      await until("computed output and fresh prompt", 5_000, (read) =>
        /BOOT_READY[\s\S]*PS [^\r\n]*> /u.test(
          stripVTControlCharacters(read.output),
        ),
      );
      assert.equal(
        await readFile(path.join(cwd, "executed.txt"), "utf8"),
        "ok",
      );
      tools.taskManager.writeShellSession("cold-start", taskId, "exit\r");
      await until(
        "natural exit",
        5_000,
        (read) => read.session.status === "completed",
      );
    } finally {
      await tools.close();
      await rm(cwd, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
      console.info(
        `Windows PTY tool environment close returned after ${elapsed()}ms`,
      );
    }
  },
);
