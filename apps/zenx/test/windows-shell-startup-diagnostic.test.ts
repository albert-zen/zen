import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { sanitizeToolEnvironment } from "../../../src/tool.js";
import { verifyShellPtyPatch } from "../scripts/shell-pty-patch.mjs";
import { createShellDiagnosticCleanup } from "./fixtures/shell-diagnostic-cleanup.js";
import { createShellStartupTrace } from "./fixtures/shell-startup-trace.js";
import {
  parseWindowsShellStartupFacts,
  windowsShellStartupProbe,
} from "./fixtures/windows-shell-startup-probe.js";

// Temporary, explicit diagnostic only. Never run before the acceptance fixture
// on its runner: this would warm the state that its first-shell assertion tests.
test(
  "diagnose cold Windows PowerShell engine and PSReadLine separately",
  { skip: process.env.ZENX_WINDOWS_SHELL_STARTUP_PROBE !== "1" },
  async () => {
    assert.equal(process.platform, "win32", "native Windows runner required");
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zen-shell-startup-"),
    );
    const metadataFile = path.join(directory, "startup-facts.txt");
    const trace = createShellStartupTrace({ enabled: true });
    const env = sanitizeToolEnvironment({
      ...process.env,
      SHELL: "/bin/sh",
      HOME: directory,
    });
    const cleanup = createShellDiagnosticCleanup();
    let output = "";
    let exited = false;
    let timedOut = false;
    const stages = new Set<string>();
    let guard: ReturnType<typeof setTimeout> | undefined;
    let facts: Record<string, string> | undefined;
    let primaryFailure: { error: unknown } | undefined;
    try {
      console.info(
        `[Shell diagnostic configuration] ${JSON.stringify({
          osRelease: os.release(),
          nodeVersion: process.version,
          shell: "powershell.exe",
          flags: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
          ],
          useConpty: true,
          useConptyDll: false,
          environmentKeys: Object.keys(env).sort(),
          interactiveReadinessVerified: false,
        })}`,
      );
      const require = createRequire(import.meta.url);
      trace.stage("dependency verification started");
      await verifyShellPtyPatch(
        path.dirname(require.resolve("node-pty/package.json")),
      );
      const { spawn } = await import("node-pty");
      trace.stage("spawn started");
      const terminal = cleanup.wrap(
        spawn(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(
              windowsShellStartupProbe(metadataFile),
              "utf16le",
            ).toString("base64"),
          ],
          {
            cwd: directory,
            env,
            cols: 80,
            rows: 24,
            name: "xterm-256color",
            useConpty: true,
            useConptyDll: false,
          },
        ),
      );
      trace.stage("spawn returned");
      cleanup.register(
        terminal.onData((chunk) => {
          trace.onData(chunk);
          output = (output + chunk).slice(-16384);
          for (const stage of [
            "ENGINE_READY",
            "READLINE_IMPORT_STARTED",
            "READLINE_IMPORTED",
          ]) {
            if (
              !stages.has(stage) &&
              output.includes(`ZEN_SHELL_STARTUP_${stage}`)
            ) {
              stages.add(stage);
              trace.stage(stage);
            }
          }
        }),
      );
      // Measurement only: the independent interactive acceptance still fails at 10s.
      const exitCode = await new Promise<number>((resolve, reject) => {
        cleanup.register(
          terminal.onExit((event) => {
            exited = true;
            trace.stage("observed exit");
            resolve(event.exitCode);
          }),
        );
        guard = setTimeout(() => {
          timedOut = true;
          reject(
            new Error(
              "Windows Shell diagnostic exceeded its 25s observation bound",
            ),
          );
        }, 25000);
      });
      assert.equal(exitCode, 0, output);
      assert.equal(stages.size, 3, "diagnostic stages were not all observed");
      facts = parseWindowsShellStartupFacts(
        await readFile(metadataFile, "utf8"),
      );
      assert.match(facts.version ?? "", /^5\.1\./u);
      assert.equal(facts.edition, "Desktop");
      assert.match(
        facts.executable ?? "",
        /WindowsPowerShell\\v1\.0\\powershell\.exe$/iu,
      );
      assert(
        facts.readlinePath && facts.readlineVersion,
        "PSReadLine identity is unknown",
      );
      assert.match(facts.readlineImportMs ?? "", /^\d+$/u);
    } catch (error) {
      primaryFailure = { error };
    } finally {
      if (guard) clearTimeout(guard);
      await cleanup.finish({
        exited,
        primaryFailure,
        observe: async () => ({
          exited,
          timedOut,
          stages: [...stages],
          output: stripVTControlCharacters(output),
          metadata: await readFile(metadataFile, "utf8")
            .then(parseWindowsShellStartupFacts)
            .catch((error: unknown) => ({ unavailable: String(error) })),
        }),
        removeDirectory: () =>
          rm(directory, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 50,
          }),
        report: (result) =>
          console.info(
            `[Shell diagnostic final observation] ${JSON.stringify(result)}`,
          ),
      });
    }
    console.info(
      `[Shell diagnostic result] ${JSON.stringify({
        outcome: "control_completed",
        cause:
          "unresolved; compare with the independent untouched interactive run",
        interactiveReadinessVerified: false,
        facts,
      })}`,
    );
  },
);
