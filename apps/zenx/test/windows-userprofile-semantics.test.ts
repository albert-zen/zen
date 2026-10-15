import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  compare,
  environments,
  parseReceipt,
  QUERY,
  QUERY_ARGS,
  runQuery,
} from "../scripts/windows-userprofile-semantics.js";
const line = (values: string) =>
  `ZEN_USERPROFILE_V1|5.1.26100.33438|Desktop|${values}\r\n`;
const a = parseReceipt(line("False|True|False|False|False|False|True"))!;
const b = parseReceipt(line("True|False|False|True|True|True|True"))!;
function fake(
  action: (
    child: EventEmitter & { stdout: PassThrough; stderr: PassThrough },
  ) => void,
  closes = true,
) {
  let kills = 0;
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      kills++;
      if (closes) queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    },
    unref() {},
  });
  const launch = (() => {
    queueMicrotask(() => action(child));
    return child;
  }) as unknown as typeof spawn;
  return { launch, kills: () => kills };
}
test("A/B changes only USERPROFILE; credentials and module paths never propagate", () => {
  const pair = environments(
    {
      PATH: "/safe",
      USERPROFILE: "private-user-path",
      APPDATA: "private-app",
      LOCALAPPDATA: "private-local",
      PSModulePath: "pwsh7",
      OPENAI_API_KEY: "secret",
    },
    "/fixture",
  )!;
  assert.deepEqual(pair.a, {
    PATH: "/safe",
    HOME: "/fixture",
    SHELL: "/bin/sh",
  });
  assert.deepEqual(pair.b, { ...pair.a, USERPROFILE: "private-user-path" });
  assert.equal(environments({}, "/fixture"), undefined);
  assert.equal(
    environments({ USERPROFILE: "x", userprofile: "y" }, "/fixture"),
    undefined,
  );
});
test("receipt parser emits only fixed scalars and rejects path/error/extra output", () => {
  assert.equal(a.homeEmpty, true);
  for (const raw of [
    "C:\\Users\\Private",
    line("False|True|False|False|False|False|True") + "secret",
    line("False|True|False|False|False|False|True").replace("Desktop", "Core"),
    line("False|True|False|False|False|False|True").replace("5.1", "7.6"),
  ])
    assert.equal(parseReceipt(raw), undefined);
});
test("comparison separates corrected relationship, same, and inconclusive", () => {
  assert.equal(compare(a, b), "compatibility-difference");
  assert.equal(
    compare(
      { ...b, envUserProfilePresent: false, homeEqualsEnvUserProfile: false },
      b,
    ),
    "same",
  );
  assert.equal(compare(a, { ...b, version: "5.1.0.1" }), "inconclusive");
  assert.equal(compare(b, b), "inconclusive");
});
test("query completes once and never exposes stderr", async () => {
  const f = fake((child) => {
    child.stderr.write("private username error");
    child.stdout.write(line("False|True|False|False|False|False|True"));
    child.emit("close", 0, null);
  });
  assert.deepEqual(await runQuery({}, "/fixture", { launch: f.launch }), {
    status: "observed",
    receipt: a,
  });
  assert.equal(f.kills(), 0);
});
test("timeout waits for exact child close; failed close remains uncertainty", async () => {
  for (const closes of [true, false]) {
    const f = fake(() => {}, closes);
    assert.deepEqual(
      await runQuery({}, "/fixture", {
        launch: f.launch,
        queryMs: 5,
        cleanupMs: 5,
      }),
      { status: closes ? "timeout" : "cleanup-unconfirmed" },
    );
    assert.equal(f.kills(), 1);
  }
});
test("bounded output and query failure do not leak data", async () => {
  const f = fake((child) => child.stdout.write("secret".repeat(1000)));
  assert.deepEqual(await runQuery({}, "/fixture", { launch: f.launch }), {
    status: "output-limit",
  });
  const e = fake((child) => {
    child.stderr.write("private");
    child.emit("close", 2, null);
  });
  assert.deepEqual(await runQuery({}, "/fixture", { launch: e.launch }), {
    status: "query-error",
  });
});
test("probe cannot prewarm/replace acceptance or load profiles and Utility", async () => {
  assert.deepEqual(QUERY_ARGS, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
  ]);
  assert.doesNotMatch(
    QUERY,
    /ConvertTo-Json|Get-Content|Import-Module|Write-Output/,
  );
  const workflow = await readFile(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const probe = workflow.indexOf("One-shot Windows USERPROFILE");
  assert(probe > workflow.indexOf("Verify owned ConPTY cleanup"));
  assert.match(
    workflow.slice(probe, probe + 500),
    /!cancelled\(\).*github\.head_ref == 'diagnostic\/windows-userprofile-semantics-20261015'.*github\.run_attempt == 1/,
  );
  assert.match(
    workflow,
    /--test-timeout=30000 apps\/zenx\/test\/shell-panel-service.test.ts/,
  );
});
