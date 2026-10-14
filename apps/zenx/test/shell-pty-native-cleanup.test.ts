import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

for (const mode of ["natural", "stop"]) {
  test(
    `Windows owned ConPTY ${mode} releases its reader and exits without PID helpers`,
    {
      skip: process.platform !== "win32",
      timeout: 20000,
    },
    async () => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(
            new URL("./fixtures/conpty-owned-cleanup.ts", import.meta.url),
          ),
          mode,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let output = "";
      let stderr = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      const started = Date.now();
      let timedOut = false;
      // Whole-process guard catches retained native handles after assertions pass.
      // This kills only this test-owned subprocess handle, never a discovered PID.
      const guard = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 15000);
      try {
        const result = await new Promise<{
          code: number | null;
          signal: string | null;
        }>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        });
        const diagnostic = JSON.stringify({
          mode,
          result,
          timedOut,
          output,
          stderr,
        });
        assert.equal(timedOut, false, diagnostic);
        assert.equal(result.code, 0, diagnostic);
        assert.equal(result.signal, null, diagnostic);
        assert.match(output, /"ownedPidGone":true/, diagnostic);
        assert.doesNotMatch(
          stderr,
          /AttachConsole|conpty_console_list_agent/,
          diagnostic,
        );
        console.log(
          `ConPTY ${mode} native lifecycle and subprocess settled in ${Date.now() - started} ms`,
        );
      } finally {
        clearTimeout(guard);
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    },
  );
}
