import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
  createWindowsGuardDiagnostic,
  GUARD_STAGE_FILE,
  projectGuardStages,
} from "../src/main/windows-foreground-input-diagnostic.js";
import {
  startWindowsForegroundInputProbe,
  WINDOWS_FOREGROUND_GUARD,
} from "../src/main/windows-foreground-input-probe.js";

const stage = (phase: string, elapsedMs = 0, pid = 123) => ({
  phase,
  pid,
  elapsedMs,
});

test("guard receipts allow only fixed phases, exact PID and monotonic integer time", () => {
  const result = projectGuardStages(
    [
      { ...stage("script-entry"), title: "synthetic-private-content" },
      stage("assemblies-loaded", 2),
      stage("compile-start", 1), // Clock regression is not trustworthy.
      stage("assemblies-loaded", 3), // A phase is recorded at most once.
      stage("compiled", 4, 999),
      stage("secret-as-phase", 5),
      stage("compiled", -1),
      stage("compiled", 4.5),
      stage("compiled", 6),
    ]
      .map((value) => JSON.stringify(value))
      .concat("not-json synthetic-private-content", "{partial")
      .join("\r\n"),
    123,
  );
  assert.deepEqual(result.stages, [
    stage("script-entry"),
    stage("assemblies-loaded", 2),
    stage("compiled", 6),
  ]);
  assert.equal(result.rejectedRecords, 8);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|999/);
  assert.equal(
    projectGuardStages(JSON.stringify(stage("script-entry")), undefined).stages
      .length,
    0,
  );
});

const terminal = {
  childPid: 123,
  closed: false,
  forced: true,
  killAccepted: false,
  exitCode: null,
  exitSignal: null,
  spawnError: false,
  childError: false,
  stderrBytes: 31,
} as const;

test("failure snapshot bounds reads and parent events and never invents tree cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zenx-diagnostic-test-"));
  const output = await mkdtemp(join(tmpdir(), "zenx-diagnostic-output-"));
  try {
    await writeFile(join(directory, GUARD_STAGE_FILE), "x".repeat(16_385));
    await writeFile(join(directory, "private-unrelated.txt"), "never upload");
    const diagnostic = createWindowsGuardDiagnostic(directory);
    for (let index = 0; index < 100; index++) diagnostic.mark("spawn-returned");
    await diagnostic.retainFailure(output, terminal);
    const files = await readdir(output);
    assert.deepEqual(files, [`${basename(directory)}.json`]);
    const json = await readFile(join(output, files[0]!), "utf8");
    const result = JSON.parse(json);
    assert.equal(result.parentStages.length, 64);
    assert.equal(result.droppedRecords, 37);
    assert.equal(result.guardStages.status, "oversized");
    assert.deepEqual(result.guardStages.stages, []);
    assert.equal(result.directChildClosed, false);
    assert.equal(result.descendantCleanup, "not-observed");
    assert.equal(result.forcedTerminationRequested, true);
    assert.doesNotMatch(json, /never upload|private-unrelated|xxxxxxxx|\/tmp/);
    assert.ok(Buffer.byteLength(json) < 16_384);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

// Real Node children exercise the production handshake, timeout and settlement.
// They do not substitute for PowerShell/WinForms/SendInput native verification.
const childSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const directory = process.argv[1];
const mode = process.argv[2];
for (const [index, phase] of ['script-entry','assemblies-loaded','compile-start'].entries()) {
  fs.appendFileSync(path.join(directory,'startup-stages.jsonl'), JSON.stringify({phase,pid:process.pid,elapsedMs:index,private:'synthetic-private-content'})+'\n');
}
if (mode === 'stall') {
  // Deliberately unresponsive to the normal close marker, like the failed run.
  setInterval(() => {},100);
} else {
  process.stderr.write('synthetic-private-stderr');
  fs.writeFileSync(path.join(directory,'ready.json'),JSON.stringify({kind:'windows-os-routed-input',phase:'ready',guardPid:mode === 'valid' ? process.pid : 1,samples:20,sampledFocusChanges:0,foregroundEvents:[],injectedClicks:1,guardMouseDown:1,guardMouseUp:1}));
  const timer=setInterval(() => {
    if (fs.existsSync(path.join(directory,'close'))) { clearInterval(timer);process.exit(0); }
  },5);
}
`;

for (const mode of ["foreign", "stall"] as const) {
  test(`real ${mode} child preserves original failure and bounded startup/close evidence`, async () => {
    const output = await mkdtemp(join(tmpdir(), "zenx-diagnostic-output-"));
    let directory = "";
    let childPid: number | undefined;
    try {
      await assert.rejects(
        startWindowsForegroundInputProbe({
          platform: "win32",
          diagnosticDirectory: output,
          spawnGuard(_script, location) {
            directory = location;
            const child = spawn(process.execPath, [
              "-e",
              childSource,
              location,
              mode,
            ]);
            childPid = child.pid;
            return child;
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.match(
            String(error.cause),
            mode === "stall" ? /Timed out.*ready.json/ : /exact external guard/,
          );
          assert.equal(
            error.errors.some((cause) =>
              /forced termination/.test(String(cause)),
            ),
            mode === "stall",
          );
          return true;
        },
      );
      const [file] = await readdir(output);
      const json = await readFile(join(output, file!), "utf8");
      const result = JSON.parse(json);
      assert.equal(result.guardPid, childPid);
      assert.equal(result.directChildClosed, true);
      assert.equal(result.descendantCleanup, "not-observed");
      assert.equal(result.forcedTerminationRequested, mode === "stall");
      assert.deepEqual(
        result.guardStages.stages.map(
          (record: { phase: string }) => record.phase,
        ),
        ["script-entry", "assemblies-loaded", "compile-start"],
      );
      assert.ok(
        result.guardStages.stages.every(
          (record: { pid: number }) => record.pid === childPid,
        ),
      );
      const phases = result.parentStages.map(
        (record: { phase: string }) => record.phase,
      );
      assert.ok(phases.includes("spawned"));
      assert.ok(phases.includes("close-written"));
      assert.ok(phases.includes("child-close"));
      assert.ok(phases.includes("child-exit"));
      assert.equal(result.killAccepted, mode === "stall" ? true : null);
      assert.ok(!phases.includes("report-validated"));
      assert.ok(
        phases.includes(
          mode === "stall" ? "report-timeout" : "report-observed",
        ),
      );
      if (mode === "stall") {
        const timeout = result.parentStages.find(
          (record: { phase: string }) => record.phase === "report-timeout",
        );
        assert.ok(
          timeout.elapsedMs >= 12_000,
          "original deadline is unchanged",
        );
        assert.ok(
          phases.indexOf("kill-requested") > phases.indexOf("close-written"),
        );
      }
      assert.doesNotMatch(
        json,
        /synthetic-private|guard.ps1|error.json|ready.*guardPid/,
      );
      assert.equal(result.stderrBytes, mode === "stall" ? 0 : 24);
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });
}

test("successful exact-child readiness and cleanup produce no failure artifact", async () => {
  const output = await mkdtemp(join(tmpdir(), "zenx-diagnostic-output-"));
  try {
    const probe = await startWindowsForegroundInputProbe({
      platform: "win32",
      diagnosticDirectory: output,
      spawnGuard(_script, location) {
        return spawn(process.execPath, ["-e", childSource, location, "valid"]);
      },
    });
    await probe.close();
    assert.deepEqual(await readdir(output), []);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("a genuine spawn failure is distinct from a helper with no ready report", async () => {
  const output = await mkdtemp(join(tmpdir(), "zenx-diagnostic-output-"));
  let directory = "";
  try {
    await assert.rejects(
      startWindowsForegroundInputProbe({
        platform: "win32",
        diagnosticDirectory: output,
        spawnGuard(_script, location) {
          directory = location;
          return spawn(join(location, "nonexistent-owned-executable"));
        },
      }),
      /ENOENT/,
    );
    const [file] = await readdir(output);
    const snapshot = JSON.parse(await readFile(join(output, file!), "utf8"));
    assert.equal(snapshot.spawnError, true);
    assert.equal(snapshot.childError, true);
    assert.equal(snapshot.guardPid, null);
    assert.equal(snapshot.directChildClosed, true);
    assert.equal(snapshot.forcedTerminationRequested, false);
    assert.equal(snapshot.guardStages.status, "unavailable");
    assert.ok(
      snapshot.parentStages.some(
        (record: { phase: string }) => record.phase === "spawn-error",
      ),
    );
    assert.ok(
      !snapshot.parentStages.some(
        (record: { phase: string }) => record.phase === "spawned",
      ),
    );
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

test("artifact write failure cannot replace the original guard assertion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zenx-diagnostic-output-"));
  const unavailable = join(directory, "not-a-directory");
  await writeFile(unavailable, "synthetic-private-content");
  let ownedDirectory = "";
  try {
    await assert.rejects(
      startWindowsForegroundInputProbe({
        platform: "win32",
        diagnosticDirectory: unavailable,
        spawnGuard(_script, location) {
          ownedDirectory = location;
          return spawn(process.execPath, [
            "-e",
            childSource,
            location,
            "foreign",
          ]);
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(String(error.cause), /exact external guard/);
        assert.equal(error.errors.length, 1);
        return true;
      },
    );
  } finally {
    if (ownedDirectory)
      await rm(ownedDirectory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("PowerShell and managed stages share one stopwatch and preserve native guards", () => {
  assert.ok(
    WINDOWS_FOREGROUND_GUARD.includes(
      "$diagnosticClock = [System.Diagnostics.Stopwatch]::StartNew()",
    ),
  );
  assert.ok(
    WINDOWS_FOREGROUND_GUARD.includes("$line + [System.Environment]::NewLine"),
  );
  assert.ok(
    WINDOWS_FOREGROUND_GUARD.includes(
      "[ZenXOverlayGuard]::Run($Directory,$ParentPid,$diagnosticClock)",
    ),
  );
  for (const [before, after] of [
    ['Write-GuardStage "script-entry"', "Add-Type -AssemblyName"],
    ['Write-GuardStage "compile-start"', "Add-Type -ReferencedAssemblies"],
    ["'@", 'Write-GuardStage "compiled"'],
    ['Stage("first-tick")', 'if(Has("close"))'],
    ['if(Has("close"))', "if(state==0)"],
    ["GetForegroundWindow()!=guard) return", 'Stage("foreground-confirmed")'],
  ])
    assert.ok(
      WINDOWS_FOREGROUND_GUARD.indexOf(before!) <
        WINDOWS_FOREGROUND_GUARD.indexOf(after!),
    );
  assert.ok(
    WINDOWS_FOREGROUND_GUARD.includes("clock.ElapsedMilliseconds>30000"),
  );
  assert.ok(
    WINDOWS_FOREGROUND_GUARD.includes(
      "if(SendInput(3,inputs,Marshal.SizeOf(typeof(Input)))!=3)",
    ),
  );
  assert.ok(
    WINDOWS_FOREGROUND_GUARD.includes(
      "if(SendInput(2,inputs,Marshal.SizeOf(typeof(Input)))!=2)",
    ),
  );
  assert.ok(
    WINDOWS_FOREGROUND_GUARD.includes(
      "state==1 && down==1 && up==1 && clock.ElapsedMilliseconds-changedAt>=150",
    ),
  );
  assert.ok(!WINDOWS_FOREGROUND_GUARD.includes("Console.Write"));
});

test("CI uploads only failure JSON from the dedicated same-step diagnostic directory", async () => {
  const workflow = parse(
    await readFile(
      new URL("../../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  const jobs = Object.values(workflow.jobs) as {
    steps: {
      name?: string;
      env?: Record<string, string>;
      with?: Record<string, string>;
      if?: string;
    }[];
  }[];
  const steps = jobs.find((job) =>
    job.steps.some(
      (step) => step.name === "Package and diagnose Windows smoke publication",
    ),
  )!.steps;
  const smokeIndex = steps.findIndex(
    (step) => step.name === "Package and diagnose Windows smoke publication",
  );
  const smoke = steps[smokeIndex]!;
  const artifact = steps[smokeIndex + 1]!;
  const directory =
    "${{ runner.temp }}/zenx-native-guard-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}";
  assert.equal(smoke.env?.ZENX_NATIVE_GUARD_DIAGNOSTICS_DIR, directory);
  assert.equal(artifact.if, "${{ failure() }}");
  assert.equal(artifact.with?.path, `${directory}/*.json`);
  assert.equal(artifact.with?.["if-no-files-found"], "ignore");
  assert.equal(artifact.with?.["retention-days"], 14);
});
