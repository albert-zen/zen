import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import ts from "typescript";
import { startupDiagnosticMacNative } from "../src/main/browser-startup-diagnostic.js";

const source = readFileSync(
  new URL("../src/main/browser-parallel-input-smoke.ts", import.meta.url),
  "utf8",
);
const native = source
  .split("const MAC_NATIVE = String.raw`")[1]!
  .split("`;\n\nconst WINDOWS_NATIVE")[0]!;

function fixtureReadiness() {
  const start = source.indexOf(
    "    await poll(async () => {",
    source.indexOf('phase = "startup-user-document"'),
  );
  const end = source.indexOf(
    '    await browserRpc.send("Target.activateTarget"',
    start,
  );
  assert(start > 0 && end > start);
  const compiled = ts.transpileModule(
    `async function run(startupDiagnostic, userRpc, poll) { let phase; ${source.slice(start, end)} }`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  return new Function(`${compiled}; return run;`)() as (
    diagnostic: boolean,
    rpc: { evaluate: (expression: string) => Promise<boolean> },
    poll: (read: () => Promise<boolean | undefined>) => Promise<void>,
  ) => Promise<void>;
}

test("actual diagnostic readiness stops on an unknown evaluate outcome without replay or focus", async () => {
  const unknown = new Error("CDP Runtime.evaluate timed out; outcome unknown");
  const calls: string[] = [];
  let cleaned = false;
  const run = fixtureReadiness();
  await assert.rejects(
    async () => {
      try {
        await run(
          true,
          {
            evaluate: async (expression) => {
              calls.push(expression);
              if (calls.length === 1) throw unknown;
              return true;
            },
          },
          async (read) => {
            for (let attempt = 0; attempt < 2; attempt++)
              if (await read()) return;
            throw new Error("Readiness did not settle");
          },
        );
      } finally {
        cleaned = true;
      }
    },
    (error: unknown) => error === unknown,
  );
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0]!, /\.focus\(/);
  assert.equal(cleaned, true);
});

test("ordinary smoke keeps its existing readiness retry after navigation rejection", async () => {
  const calls: string[] = [];
  await fixtureReadiness()(
    false,
    {
      evaluate: async (expression) => {
        calls.push(expression);
        if (calls.length === 1) throw new Error("navigation changed context");
        return true;
      },
    },
    async (read) => {
      for (let attempt = 0; attempt < 2; attempt++) if (await read()) return;
      throw new Error("Readiness did not settle");
    },
  );
  assert.equal(calls.length, 3);
  assert.match(calls[2]!, /\.focus\(/);
});

test("AX instrumentation affects only the explicitly selected private diagnostic helper", () => {
  assert.doesNotMatch(native, /diagnosticPidOnly|axTotalMs|systemUptime/);
  const instrumented = startupDiagnosticMacNative(native);
  assert.match(instrumented, /defer \{ let elapsed =/);
  assert.match(
    instrumented,
    /guard currentPid\(\) == expectedPid else \{ return false \}/,
  );
  assert.match(instrumented, /if diagnosticPidOnly \{ return true \}/);
  assert.match(
    instrumented,
    /No OS input is allowed in the PID-only diagnostic/,
  );
  assert.match(instrumented, /withTimeInterval:0\.01,repeats:true/);
  assert.match(
    source,
    /diagnostic\s*\? startupDiagnosticMacNative\(MAC_NATIVE\)\s*:\s*MAC_NATIVE/,
  );
  assert.match(
    source,
    /native = await startNative\(directory, startupDiagnostic\)/,
  );
  const diagnostic = source.slice(
    source.indexOf("    if (startupDiagnostic) {"),
    source.indexOf('    phase = "startup-connect-provider";'),
  );
  assert.match(diagnostic, /throughIsolatedWorld: true/);
  assert.match(diagnostic, /ownedPageUrl: `\$\{origin\}\/agent`/);
  assert.match(diagnostic, /return; \/\/ A late reply is never permission/);
});

test("native instrumentation refuses missing, repeated or already-instrumented seams", () => {
  for (const invalid of [
    "",
    native + native,
    startupDiagnosticMacNative(native),
    native.replace('  case "type":', '  case "changed":'),
  ])
    assert.throws(
      () => startupDiagnosticMacNative(invalid),
      /seam|already instrumented/,
    );
});

test("diagnostic workflow is one opened draft PR attempt and at most two fresh-profile processes", () => {
  const workflow = parse(
    readFileSync(
      new URL(
        "../../../.github/workflows/browser-startup-diagnostic.yml",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(workflow.on, {
    pull_request: { types: ["opened"], branches: ["main"] },
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const jobs = Object.values(workflow.jobs) as {
    if: string;
    steps: { name?: string; run?: string; with?: Record<string, unknown> }[];
  }[];
  assert.equal(jobs.length, 1);
  const job = jobs[0]!;
  assert.match(
    job.if,
    /head\.ref == 'diagnostic\/browser-startup-latency-pair-20261015'/,
  );
  assert.match(job.if, /head\.repo\.full_name == 'albert-zen\/zen'/);
  assert.match(job.if, /draft == true/);
  assert.match(job.if, /run_attempt == 1/);
  const observation = job.steps.find((step) =>
    step.name?.startsWith("Observe one case"),
  )!;
  assert.match(observation.run!, /for mode in title pid-only; do/);
  assert.match(observation.run!, /test "\$GITHUB_RUN_ATTEMPT" = 1/);
  assert.equal(
    observation.run!.match(/run diagnose:browser-startup/g)?.length,
    1,
  );
  assert.match(
    observation.run!,
    /ARTIFACT_DIR="\$ZENX_PARALLEL_INPUT_ARTIFACT_DIR\/\$mode"/,
  );
  assert.match(source, /const directory = await mkdtemp\(/);
  assert.match(
    source,
    /const profile = path\.join\(directory, "browser-profile"\)/,
  );
});
