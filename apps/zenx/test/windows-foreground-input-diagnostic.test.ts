import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { after } from "node:test";
import { parse } from "yaml";
import {
  createWindowsGuardDiagnostic,
  GUARD_STAGE_FILE,
  projectGuardStages,
} from "../src/main/windows-foreground-input-diagnostic.js";
import {
  startWindowsForegroundInputProbe,
  WINDOWS_FOREGROUND_GUARD,
  WINDOWS_FOREGROUND_GUARD_SOURCE,
} from "../src/main/windows-foreground-input-probe.js";

// This fake assembly is only consumed by the explicitly injected Node children.
// Production assembly validation still runs before spawning every test child.
const assemblyDirectory = await mkdtemp(join(tmpdir(), "zenx-test-assembly-"));
const assemblyBytes = Buffer.from("synthetic-node-child-assembly");
const assemblyPath = join(assemblyDirectory, "guard.dll");
await writeFile(assemblyPath, assemblyBytes);
after(() => rm(assemblyDirectory, { recursive: true, force: true }));
const assembly = {
  path: assemblyPath,
  sourceSha256: createHash("sha256")
    .update(WINDOWS_FOREGROUND_GUARD_SOURCE)
    .digest("hex"),
  assemblySha256: createHash("sha256").update(assemblyBytes).digest("hex"),
};
const guardSource = WINDOWS_FOREGROUND_GUARD + WINDOWS_FOREGROUND_GUARD_SOURCE;

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
          assembly,
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
      assembly,
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
        assembly,
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
        assembly,
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
    guardSource.includes(
      "$diagnosticClock = [System.Diagnostics.Stopwatch]::StartNew()",
    ),
  );
  assert.ok(guardSource.includes("$line + [System.Environment]::NewLine"));
  assert.ok(
    guardSource.includes(
      "[ZenXOverlayGuard]::Run($Directory,$ParentPid,$diagnosticClock)",
    ),
  );
  for (const [before, after] of [
    ['Write-GuardStage "script-entry"', "Add-Type -AssemblyName"],
    [
      'Write-GuardStage "assembly-load-start"',
      "[System.IO.File]::ReadAllBytes",
    ],
    ["if ($digest -cne", "[System.Reflection.Assembly]::Load"],
    [
      "[System.Reflection.Assembly]::Load",
      'Write-GuardStage "assembly-loaded"',
    ],
    ['Stage("first-tick")', 'if(Has("close"))'],
    ['if(Has("close"))', "if(state==0)"],
    ["GetForegroundWindow()!=guard) return", 'Stage("foreground-confirmed")'],
  ])
    assert.ok(guardSource.indexOf(before!) < guardSource.indexOf(after!));
  assert.ok(guardSource.includes("clock.ElapsedMilliseconds>30000"));
  assert.ok(
    guardSource.includes(
      "if(SendInput(3,inputs,Marshal.SizeOf(typeof(Input)))!=3)",
    ),
  );
  assert.ok(
    guardSource.includes(
      "if(SendInput(2,inputs,Marshal.SizeOf(typeof(Input)))!=2)",
    ),
  );
  assert.ok(
    guardSource.includes(
      "state==1 && down==1 && up==1 && clock.ElapsedMilliseconds-changedAt>=150",
    ),
  );
  assert.ok(!guardSource.includes("Console.Write"));
});

test("ready chain observations preserve one Evidence/serialize/write/rename and final state order", () => {
  const ready = guardSource.slice(
    guardSource.indexOf(
      "if(state==1 && down==1 && up==1 && clock.ElapsedMilliseconds-changedAt>=150)",
    ),
    guardSource.indexOf('else if(state==2 && Has("edge"))'),
  );
  const save = guardSource.slice(
    guardSource.indexOf("void Save(string name,object value)"),
    guardSource.indexOf("void OnForeground("),
  );
  for (const [source, sequence] of [
    [
      ready,
      [
        'Stage("ready-condition-met")',
        'var evidence=Evidence("ready")',
        'Stage("evidence-built")',
        'Save("ready.json",evidence)',
        'Stage("ready-written")',
        "state=2",
      ],
    ],
    [
      save,
      [
        "var serialized=Json.Serialize(value)",
        'if(name=="ready.json") Stage("serialized")',
        "File.WriteAllText(temp,serialized)",
        'if(name=="ready.json") Stage("temp-written")',
        "File.Move(temp,target)",
      ],
    ],
  ] as const) {
    let previous = -1;
    for (const fragment of sequence) {
      const at = source.indexOf(fragment);
      assert.ok(at > previous, `missing/out-of-order ${fragment}`);
      assert.equal(
        source.indexOf(fragment, at + 1),
        -1,
        `duplicated ${fragment}`,
      );
      previous = at;
    }
    assert.doesNotMatch(
      source,
      /catch|Thread.Sleep|Task\.|DoEvents|while\s*\(/,
    );
  }
  assert.equal(guardSource.match(/Json\.Serialize\(value\)/g)?.length, 1);
  const records = [
    "ready-condition-met",
    "evidence-built",
    "serialized",
    "temp-written",
    "ready-written",
  ].map((phase, index) => stage(phase, index));
  assert.deepEqual(
    projectGuardStages(
      records.map((value) => JSON.stringify(value)).join("\n"),
      123,
    ),
    { stages: records, rejectedRecords: 0 },
  );
});

test("a failed observer write cannot invent a later ready milestone or replace failure evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zenx-diagnostic-test-"));
  const output = await mkdtemp(join(tmpdir(), "zenx-diagnostic-output-"));
  try {
    await writeFile(
      join(directory, GUARD_STAGE_FILE),
      JSON.stringify(stage("ready-condition-met")) +
        '\n{"phase":"evidence-built"',
    );
    const diagnostic = createWindowsGuardDiagnostic(directory);
    diagnostic.mark("report-timeout", "ready.json");
    await diagnostic.retainFailure(output, terminal);
    const [file] = await readdir(output);
    const result = JSON.parse(await readFile(join(output, file!), "utf8"));
    assert.deepEqual(result.guardStages.stages, [stage("ready-condition-met")]);
    assert.equal(result.guardStages.rejectedRecords, 1);
    assert.equal(result.directChildClosed, false);
    assert.equal(result.forcedTerminationRequested, true);
    assert.ok(
      result.parentStages.some(
        (record: { phase: string }) => record.phase === "report-timeout",
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /evidence-built|serialized|temp-written|ready-written/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
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
