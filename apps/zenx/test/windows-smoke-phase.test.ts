import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
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
    await publishWindowsSmokePhase(directory, "uia-set-value");
    const old = await open(path.join(directory, "phase"), "r");
    try {
      await publishWindowsSmokePhase(directory, "uia-refresh");
      assert.equal(await old.readFile("utf8"), "uia-set-value");
      assert.equal(
        await readFile(path.join(directory, "phase"), "utf8"),
        "uia-refresh",
      );
      assert.deepEqual(await readdir(directory), ["phase"]);
    } finally {
      await old.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed publication rejects and removes only its owned temporary file", async () => {
  const directory = await fixture();
  try {
    await mkdir(path.join(directory, "phase"));
    await writeFile(
      path.join(directory, "phase", "owned-by-fixture"),
      "retained",
    );
    await assert.rejects(publishWindowsSmokePhase(directory, "uia-refresh"));
    assert.deepEqual(await readdir(directory), ["phase"]);
    assert.equal(
      await readFile(path.join(directory, "phase", "owned-by-fixture"), "utf8"),
      "retained",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Compile the exact sampler declaration from the actual smoke harness, without
// creating its windows or invoking native input. Hold its real read handle open
// across publication so this regression does not depend on winning a race.
test(
  "Windows sampler shares replacement while retaining its original snapshot",
  {
    skip:
      process.platform !== "win32" ? "Windows file-sharing contract" : false,
  },
  async () => {
    const directory = await fixture();
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
    try {
      for (const shared of [false, true]) {
        await publishWindowsSmokePhase(directory, "uia-set-value");
        const ready = path.join(
          directory,
          shared ? "shared-ready" : "old-ready",
        );
        const release = path.join(
          directory,
          shared ? "shared-release" : "old-release",
        );
        const script: string = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System,System.Drawing,System.Windows.Forms -TypeDefinition @'
${declaration}
'@
$directory = ${quote(directory)}
$stream = ${shared ? "[ZenXCaptureSampler]::OpenPhase($directory)" : "[IO.File]::OpenRead((Join-Path $directory 'phase'))"}
try {
  [IO.File]::WriteAllText(${quote(ready)}, 'ready')
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not [IO.File]::Exists(${quote(release)})) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Held phase reader timed out' }
    Start-Sleep -Milliseconds 10
  }
  $reader = New-Object IO.StreamReader($stream)
  try { [Console]::Out.WriteLine($reader.ReadToEnd()) } finally { $reader.Dispose() }
} finally { $stream.Dispose() }
`;
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
        const watchdog = setTimeout(() => child.kill(), 20000);
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        const closed = once(child, "close");
        // Observe immediately, including failed process creation, before waiting.
        void closed.catch(() => {});
        try {
          const deadline = Date.now() + 15000;
          for (;;) {
            try {
              await readFile(ready);
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
            assert.equal(child.exitCode, null, stderr);
            assert.ok(
              Date.now() < deadline,
              `Native reader never became ready: ${stderr}`,
            );
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (shared) {
            await publishWindowsSmokePhase(directory, "uia-refresh");
            assert.equal(
              await readFile(path.join(directory, "phase"), "utf8"),
              "uia-refresh",
            );
          } else {
            // File.ReadAllText uses this read-only sharing mode. Holding it makes
            // the old in-place write fail deterministically, reproducing CI EBUSY.
            await assert.rejects(
              writeFile(path.join(directory, "phase"), "uia-refresh"),
              { code: "EBUSY" },
            );
          }
        } finally {
          try {
            await writeFile(release, "release");
          } finally {
            try {
              const exited = await closed;
              assert.equal(exited[0], 0, stderr);
            } finally {
              clearTimeout(watchdog);
            }
          }
        }
        assert.equal(
          stdout.trim(),
          "uia-set-value",
          "held handle must keep its complete original version",
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
