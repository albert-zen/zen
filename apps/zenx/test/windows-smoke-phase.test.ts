import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishWindowsSmokePhase } from "../src/main/windows-smoke-phase.js";

async function fixture() {
  return await mkdtemp(path.join(os.tmpdir(), "zenx-phase-snapshot-"));
}

test("phase publication preserves complete old and new snapshots", async () => {
  const directory = await fixture();
  try {
    const original = await publishWindowsSmokePhase(directory, "uia-set-value");
    const old = await open(original, "r");
    try {
      const updated = await publishWindowsSmokePhase(directory, "uia-refresh");
      assert.equal(await old.readFile("utf8"), "uia-set-value");
      assert.equal(await readFile(updated, "utf8"), "uia-refresh");
      assert.deepEqual((await readdir(directory)).sort(), [
        path.basename(original),
        path.basename(updated),
      ]);
      assert.notEqual(updated, original);
    } finally {
      await old.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed publication preserves existing snapshots and unrelated files", async () => {
  const directory = await fixture();
  try {
    const original = await publishWindowsSmokePhase(directory, "uia-set-value");
    const blocked = path.join(directory, "not-a-directory");
    await writeFile(blocked, "retained");
    await assert.rejects(publishWindowsSmokePhase(blocked, "uia-refresh"));
    assert.equal(await readFile(original, "utf8"), "uia-set-value");
    assert.equal(await readFile(blocked, "utf8"), "retained");
    assert.deepEqual(
      (await readdir(directory)).sort(),
      ["not-a-directory", path.basename(original)].sort(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Compile the exact sampler declaration from the actual smoke harness, without
// creating its windows or invoking native input. Hold its real read handle open
// across publication so this regression does not depend on winning a race.
// The historical in-place writer's EBUSY negative control is not a product
// contract: do not compile/run a second PowerShell process just to re-prove it.
test(
  "Windows sampler reads immutable generations while retaining its original snapshot",
  {
    skip:
      process.platform !== "win32" ? "Windows file-sharing contract" : false,
    timeout: 30000,
  },
  async (t) => {
    const directory = await fixture();
    const started = performance.now();
    let stage = "declaration";
    let stdout = "",
      stderr = "";
    const diagnostic = () =>
      `Native sampler ${stage} after ${Math.round(performance.now() - started)}ms\nstdout: ${stdout}\nstderr: ${stderr}`;
    const enter = (next: string) => {
      stage = next;
      t.diagnostic(
        `Native sampler ${stage} at ${Math.round(performance.now() - started)}ms`,
      );
    };
    const failures: unknown[] = [];
    try {
      const harness = await readFile(
        new URL("../scripts/windows-winapp-smoke.ps1", import.meta.url),
        "utf8",
      );
      const declaration = harness.match(
        /-TypeDefinition @"\r?\n([\s\S]*?)\r?\n"@/u,
      )?.[1];
      assert.ok(
        declaration,
        "actual native sampler declarations must be present",
      );
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      await publishWindowsSmokePhase(directory, "uia-set-value");
      const ready = path.join(directory, "shared-ready");
      const release = path.join(directory, "shared-release");
      const script = `
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('startup: compiling native sampler')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System,System.Drawing,System.Windows.Forms -TypeDefinition @'
${declaration}
'@
$directory = ${quote(directory)}
$stream = [ZenXCaptureSampler]::OpenPhase($directory)
try {
  [Console]::Error.WriteLine('ready: original snapshot held')
  [IO.File]::WriteAllText(${quote(ready)}, 'ready')
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not [IO.File]::Exists(${quote(release)})) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Held phase reader timed out' }
    Start-Sleep -Milliseconds 10
  }
  $reader = New-Object IO.StreamReader($stream)
  try { [Console]::Out.WriteLine($reader.ReadToEnd()) } finally { $reader.Dispose() }
  [Console]::Out.WriteLine('latest:')
  $latest = New-Object IO.StreamReader([ZenXCaptureSampler]::OpenPhase($directory))
  try { [Console]::Out.WriteLine($latest.ReadToEnd()) } finally { $latest.Dispose() }
} finally { $stream.Dispose() }
`;
      enter("startup/readiness");
      const child = spawn(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      let hasClosed = false;
      const settled = new Promise<void>((resolve) => {
        child.once("close", () => {
          hasClosed = true;
          resolve();
        });
      });
      const closed = once(child, "close");
      // Observe failed creation immediately, rather than hiding it behind readiness.
      let processError: unknown;
      void closed.catch((error: unknown) => {
        processError = error;
      });
      // One process, one total budget. Leave 3s for forced close and room for
      // fixture cleanup before the CI runner's unchanged 30s outer timeout.
      const deadline = started + 20000;
      let timedOut = false;
      let expire: (error: Error) => void;
      const expired = new Promise<never>((_, reject) => {
        expire = reject;
      });
      const completed = Promise.race([closed, expired]);
      void completed.catch(() => {});
      const watchdog = setTimeout(
        () => {
          timedOut = true;
          expire(new Error(diagnostic()));
          child.kill();
        },
        Math.max(0, deadline - performance.now()),
      );
      try {
        const readyDeadline = Math.min(deadline, performance.now() + 15000);
        for (;;) {
          if (processError) throw processError;
          assert.ok(
            !timedOut && child.exitCode === null && child.signalCode === null,
            diagnostic(),
          );
          assert.ok(performance.now() < readyDeadline, diagnostic());
          try {
            await readFile(ready);
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        enter("publication");
        // A deliberately incomplete temporary file must never be sampled.
        await writeFile(path.join(directory, ".phase-incomplete"), "partial");
        const updated = await publishWindowsSmokePhase(
          directory,
          "uia-refresh",
        );
        assert.equal(await readFile(updated, "utf8"), "uia-refresh");
        enter("release/exit");
        await writeFile(release, "release");
        const exited = await completed;
        assert.ok(!timedOut, diagnostic());
        assert.equal(exited[0], 0, diagnostic());
        assert.equal(
          stdout.trim(),
          "uia-set-value\r\nlatest:\r\nuia-refresh",
          "held native handle retains old bytes and fresh sampler selects complete latest generation",
        );
      } catch (error) {
        failures.push(new Error(diagnostic(), { cause: error }));
      } finally {
        clearTimeout(watchdog);
        enter("process cleanup");
        if (!hasClosed) child.kill();
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          // A spawn error was already captured above. Still wait for close so
          // pipes and native handles cannot outlive the fixture on failure.
          await Promise.race([
            settled,
            new Promise<never>((_, reject) => {
              cleanupTimer = setTimeout(
                () => reject(new Error(diagnostic())),
                3000,
              );
            }),
          ]);
        } catch (error) {
          failures.push(error);
        } finally {
          clearTimeout(cleanupTimer);
        }
      }
    } catch (error) {
      failures.push(error);
    } finally {
      enter("fixture cleanup");
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    // TAP does not reliably render AggregateError.errors. Keep the original
    // thrown failures, but expose bounded synthetic-runner diagnostics first.
    if (failures.length > 0) {
      for (const [index, error] of failures.slice(0, 4).entries()) {
        t.diagnostic(
          `Native sampler failure ${index + 1}: ${String(error).slice(0, 4000)}`,
        );
        if (error instanceof Error && error.cause !== undefined)
          t.diagnostic(
            `Native sampler cause ${index + 1}: ${String(error.cause).slice(0, 4000)}`,
          );
      }
      t.diagnostic(`Native sampler stdout tail: ${stdout.slice(-2000)}`);
      t.diagnostic(`Native sampler stderr tail: ${stderr.slice(-2000)}`);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Native sampler failed; original failure is first",
      );
  },
);
