import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { sanitizeToolEnvironment } from "../../../src/tool.js";
import { desktopShellPty } from "../src/main/shell-pty.js";

// A separate test subprocess measures cold module loading without spending the
// service regression's file-level budget. The original five-second assertion
// and the CI step's whole-process watchdog remain unchanged.
test(
  "Windows PowerShell cold, hot and resized Utility execution timings",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zen-pty-cold-"));
    const terminal = await desktopShellPty.spawn({
      cwd: directory,
      env: sanitizeToolEnvironment({ ...process.env, HOME: directory }),
      cols: 80,
      rows: 24,
    });
    let output = "";
    let exitCode: number | undefined;
    const data = terminal.onData((chunk) => {
      output = (output + chunk).slice(-32768);
    });
    const exit = terminal.onExit((event) => {
      exitCode = event.exitCode;
    });
    const observe = async (
      predicate: () => boolean,
      budget: number,
      stage: string,
    ) => {
      const start = Date.now();
      while (!predicate()) {
        assert(
          Date.now() - start < budget,
          `${stage} timed out; exit=${exitCode}; output=${JSON.stringify(output)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return Date.now() - start;
    };
    const promptAfter = (marker: string) => {
      const plain = stripVTControlCharacters(output);
      const index = plain.lastIndexOf(marker);
      return (
        index >= 0 && /PS [^\r\n]*> /u.test(plain.slice(index + marker.length))
      );
    };
    try {
      await observe(
        () => /PS [^\r\n]*> /u.test(stripVTControlCharacters(output)),
        5000,
        "initial prompt",
      );
      terminal.write(
        "[Console]::WriteLine($PSVersionTable.PSVersion.ToString());[Console]::WriteLine($env:PSModulePath);[Console]::WriteLine(('ENV_'+'READY'))\r",
      );
      await observe(
        () => promptAfter("ENV_READY"),
        5000,
        "version and module paths",
      );
      console.info(`[PowerShell cold probe] ${JSON.stringify(output)}`);
      for (const [name, budget, resize] of [
        ["COLD", 20000, false],
        ["HOT", 5000, false],
        ["RESIZED", 5000, true],
      ] as const) {
        if (resize) terminal.resize(92, 30);
        const marker = `${name}_UTILITY`;
        const start = Date.now();
        terminal.write(
          `Write-Output ('${name}_'+'UTILITY'); 'ok'>${name}.txt\r`,
        );
        await observe(
          () => promptAfter(marker),
          budget,
          `${name} Utility command`,
        );
        assert(
          (await readFile(path.join(directory, `${name}.txt`))).length > 0,
        );
        console.info(
          `[PowerShell Utility timing] ${JSON.stringify({ phase: name, elapsedMs: Date.now() - start, cols: resize ? 92 : 80, rows: resize ? 30 : 24 })}`,
        );
      }
      terminal.write("exit\r");
      await observe(() => exitCode !== undefined, 5000, "natural exit");
      assert.equal(exitCode, 0);
    } finally {
      if (exitCode === undefined) {
        terminal.kill();
        await observe(() => exitCode !== undefined, 5000, "fixture cleanup");
      }
      data.dispose();
      exit.dispose();
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  },
);
