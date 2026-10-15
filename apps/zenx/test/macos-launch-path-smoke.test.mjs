import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  instrumentLaunchPathEntry,
  prepareLaunchPathApp,
} from "../scripts/macos-launch-path-instrumentation.mjs";
import {
  createLaunchFixture,
  launchServicesArguments,
  SPARSE_PATH,
  validateLaunchRound,
  validateRelaunch,
} from "../scripts/smoke-macos-launch-path.mjs";
import { observeLaunchHostShell } from "../scripts/macos-launch-path-host-observation.mjs";
import { packageZenX } from "../scripts/package-zenx-portable.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const mainSource = `import { app } from "electron";
const hostLifecycle = new ZenXHostLifecycle({ reportStopFailure: (error) => console.error("Stop failed", error) });
async function bootstrapZenX() {
  const shellPath = await restoreLoginShellPath({environment: process.env});
  initializeHost();
}
void app.whenReady().then(async () => {
  createWindow();
  await bootstrapFence.run(bootstrapZenX);
});
`;
const hostSource = `import { createHostedAppServer } from "./host.js";
async function handleCommand(command) {
  const toolComposition = createZenXHostToolEnvironment({send});
  targetToolEnvironment = toolComposition.toolEnvironment;
  appServer = createHostedAppServer({ ...command.config, toolEnvironment: toolComposition.toolEnvironment });
}
`;

function goodRecords(
  round = "initial",
  receiptId = "owned",
  appPid = 100,
  hostPids = [101, 102],
) {
  const record = (extra, pid = appPid) => ({ round, receiptId, pid, ...extra });
  return {
    entry: record({
      packaged: true,
      platform: "darwin",
      sparsePath: true,
      hasFixturePath: false,
      terminal: false,
      noProfileSecrets: true,
      isolatedHome: true,
      isolatedUserData: true,
    }),
    capture: record({
      result: "restored",
      hasFixturePath: true,
      noProfileSecrets: true,
    }),
    complete: record({
      ok: true,
      rendererSafeRestart: true,
      hostPids,
      noProfileSecrets: true,
    }),
    quit: record({ event: "will-quit", exitCode: 0, shutdownFailureCount: 0 }),
    ...Object.fromEntries(
      hostPids.map((pid) => [
        `host-${pid}`,
        record(
          {
            parentPid: appPid,
            hasFixturePath: true,
            noProfileSecrets: true,
            owner: { kind: "builtin", id: "shell" },
            exitCode: 0,
            markerMatched: true,
          },
          pid,
        ),
      ]),
    ),
  };
}

async function temporary(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-launch-path-test-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("strict AST observer inserts around the real main bootstrap without replacing it", () => {
  const observed = instrumentLaunchPathEntry(mainSource, "main");
  assert(
    observed.indexOf(".observeMain(app)") <
      observed.indexOf("async function bootstrapZenX"),
  );
  assert(
    observed.indexOf("await restoreLoginShellPath") <
      observed.indexOf(".observeCapture(shellPath)"),
  );
  assert(
    observed.indexOf(".observeCapture(shellPath)") <
      observed.indexOf("initializeHost()"),
  );
  assert(
    observed.indexOf("await bootstrapFence.run(bootstrapZenX)") <
      observed.indexOf("await __zenxLaunchPathObserver.completeMain"),
  );
  assert.equal(
    observed
      .replace(/^import \* as __zenxLaunchPathObserver.*\n/u, "")
      .replace(/\n(?:await )?__zenxLaunchPathObserver\.[^\n]+\n/gu, "")
      .replace(
        '(__zenxLaunchPathObserver.observeShutdownFailure(error), console.error("Stop failed", error))',
        'console.error("Stop failed", error)',
      ),
    mainSource,
  );
});

test("strict AST observer uses the exact production Host composition before App Server creation", () => {
  const observed = instrumentLaunchPathEntry(hostSource, "host");
  assert(
    observed.indexOf("const toolComposition =") <
      observed.indexOf(
        "await __zenxLaunchPathObserver.observeHost(toolComposition.toolEnvironment)",
      ),
  );
  assert(
    observed.indexOf(".observeHost(") <
      observed.indexOf("appServer = createHostedAppServer"),
  );
  assert.equal(
    observed
      .replace(/^import \* as __zenxLaunchPathObserver.*\n/u, "")
      .replace(/await __zenxLaunchPathObserver\.observeHost\([^\n]+\n/u, ""),
    hostSource,
  );
});

for (const [label, source, kind] of [
  [
    "missing capture",
    mainSource.replace("restoreLoginShellPath", "otherCapture"),
    "main",
  ],
  [
    "unawaited capture",
    mainSource.replace("await restoreLoginShellPath", "restoreLoginShellPath"),
    "main",
  ],
  [
    "duplicate capture",
    mainSource.replace("initializeHost();", "await restoreLoginShellPath({});"),
    "main",
  ],
  [
    "unawaited bootstrap",
    mainSource.replace("await bootstrapFence", "bootstrapFence"),
    "main",
  ],
  [
    "renamed app binding",
    mainSource.replace("{ app }", "{ app as other }"),
    "main",
  ],
  [
    "substituted Host environment",
    hostSource.replace(
      "toolEnvironment: toolComposition.toolEnvironment",
      "toolEnvironment: syntheticToolEnvironment",
    ),
    "host",
  ],
  [
    "duplicate Host construction",
    hostSource.replace(
      "targetToolEnvironment =",
      "createHostedAppServer({}); targetToolEnvironment =",
    ),
    "host",
  ],
  ["malformed JavaScript", mainSource + "const = ;", "main"],
])
  test(`observer fails closed for ${label}`, () => {
    assert.throws(() => instrumentLaunchPathEntry(source, kind));
  });

test("observer rejects duplicate instrumentation and ignores anchor-shaped comments", () => {
  assert.throws(
    () =>
      instrumentLaunchPathEntry(
        instrumentLaunchPathEntry(mainSource, "main"),
        "main",
      ),
    /already instrumented/u,
  );
  assert.doesNotThrow(() =>
    instrumentLaunchPathEntry(
      mainSource + "// await bootstrapFence.run(bootstrapZenX);\n",
      "main",
    ),
  );
});

test("staging validates both entries before writing and copies the observer before signing", async (t) => {
  const directory = await temporary(t);
  const main = path.join(directory, "out", "main");
  await mkdir(main, { recursive: true });
  await writeFile(path.join(main, "index.js"), mainSource);
  await writeFile(path.join(main, "app-server-host.js"), "invalid = ;");
  await assert.rejects(prepareLaunchPathApp(directory));
  assert.equal(await readFile(path.join(main, "index.js"), "utf8"), mainSource);
  await writeFile(path.join(main, "app-server-host.js"), hostSource);
  await prepareLaunchPathApp(directory);
  assert.match(
    await readFile(path.join(main, "launch-path-observer.mjs"), "utf8"),
    /toolEnvironment\.execute\(prepared\)/u,
  );
  assert.equal(
    await readFile(
      path.join(main, "macos-launch-path-host-observation.mjs"),
      "utf8",
    ),
    await readFile(
      new URL(
        "../scripts/macos-launch-path-host-observation.mjs",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const packager = await readFile(
    new URL("../scripts/package-zenx-portable.mjs", import.meta.url),
    "utf8",
  );
  assert(
    packager.indexOf("await stagePackage({") <
      packager.indexOf("await options.prepareApp?.(appDir)"),
  );
  assert(
    packager.indexOf("await options.prepareApp?.(appDir)") <
      packager.indexOf("const macOsSigningConfiguration ="),
  );
  assert(
    packager.indexOf("await options.prepareApp?.(appDir)") <
      packager.indexOf("await packager({"),
  );
});

test("the internal observer cannot be requested without an app and isolated publication target", async () => {
  await assert.rejects(
    packageZenX([], { prepareApp() {} }),
    /isolated artifact directory/u,
  );
  await assert.rejects(
    packageZenX(["--app"], { prepareApp() {} }),
    /isolated artifact directory/u,
  );
});

test("LaunchServices receives explicit sparse GUI environment and isolated profile arguments", () => {
  const fixture = {
    home: "/tmp/home with spaces",
    userData: "/tmp/user-data",
    zenData: "/tmp/zen-data",
    receiptId: "round-id",
  };
  const args = launchServicesArguments(
    "/tmp/fixture/ZenX.app",
    "/tmp/config.json",
    fixture,
  );
  assert.deepEqual(args.slice(0, 4), [
    "-n",
    "-W",
    "-a",
    "/tmp/fixture/ZenX.app",
  ]);
  for (const value of [
    `PATH=${SPARSE_PATH}`,
    "TERM=",
    "TERM_PROGRAM=",
    `HOME=${fixture.home}`,
    `ZDOTDIR=${fixture.home}`,
    "SHELL=/bin/zsh",
  ])
    assert.equal(args[args.indexOf(value) - 1], "--env");
  assert.deepEqual(args.slice(-3), [
    "--args",
    `--user-data-dir=${fixture.userData}`,
    `--zenx-launch-path-instance=${fixture.receiptId}`,
  ]);
});

test("acceptance requires complete GUI/capture/tool/restart/normal-quit evidence", () => {
  assert.deepEqual(validateLaunchRound(goodRecords(), "initial", "owned"), {
    appPid: 100,
    hostPids: [101, 102],
  });
  validateRelaunch(
    { appPid: 100, hostPids: [101, 102] },
    { appPid: 200, hostPids: [201, 202] },
  );
});

for (const [label, mutate] of [
  ["terminal launch", (r) => (r.entry.terminal = true)],
  ["pre-recovered PATH", (r) => (r.entry.hasFixturePath = true)],
  ["capture skipped", (r) => (r.capture.result = "skipped")],
  ["imported profile secret", (r) => (r.capture.noProfileSecrets = false)],
  ["failed real shell command", (r) => (r["host-101"].exitCode = 127)],
  ["wrong shell marker", (r) => (r["host-102"].markerMatched = false)],
  ["substituted tool owner", (r) => (r["host-101"].owner.id = "synthetic")],
  ["wrong Host parent", (r) => (r["host-101"].parentPid = 999)],
  ["stale receipt", (r) => (r.capture.receiptId = "old")],
  ["missing second Host", (r) => delete r["host-102"]],
  ["reused Host PID", (r) => (r.complete.hostPids = [101, 101])],
  ["no normal quit", (r) => delete r.quit],
  ["recorded observer failure", (r) => (r["failure-100"] = { ok: false })],
])
  test(`native receipts fail closed for ${label}`, () => {
    const records = goodRecords();
    mutate(records);
    assert.throws(() => validateLaunchRound(records, "initial", "owned"));
  });

test("reopening requires a new main PID and new Host PIDs", () => {
  assert.throws(() =>
    validateRelaunch(
      { appPid: 100, hostPids: [101, 102] },
      { appPid: 100, hostPids: [201, 202] },
    ),
  );
  assert.throws(() =>
    validateRelaunch(
      { appPid: 100, hostPids: [101, 102] },
      { appPid: 200, hostPids: [102, 202] },
    ),
  );
});

test(
  "real Host tool observer is red before recovery and green with fixture PATH (not native acceptance)",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await temporary(t);
    const fixture = await createLaunchFixture(directory);
    const evidence = path.join(directory, "evidence");
    await mkdir(evidence);
    const configPath = path.join(directory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        ...fixture,
        evidence,
        round: "unit",
        receiptId: "unit",
      }),
    );
    const observer = pathToFileURL(
      fileURLToPath(
        new URL("../scripts/macos-launch-path-observer.mjs", import.meta.url),
      ),
    ).href;
    const composition = pathToFileURL(
      fileURLToPath(
        new URL("../src/main/capability-tool-executor.ts", import.meta.url),
      ),
    ).href;
    const spool = pathToFileURL(
      path.join(root, "src/tool-output-spool.ts"),
    ).href;
    const source = `
    import { createZenXHostToolEnvironment } from ${JSON.stringify(composition)};
    import { ToolOutputSpool } from ${JSON.stringify(spool)};
    import { observeHost } from ${JSON.stringify(observer)};
    const output = new ToolOutputSpool();
    const composition = createZenXHostToolEnvironment({capabilities:{definitions:[]},send(){},toolOutputSpool:output});
    try { await observeHost(composition.toolEnvironment); }
    finally { await composition.close(); await output.close(); }
  `;
    const env = {
      ...process.env,
      HOME: fixture.home,
      ZDOTDIR: fixture.home,
      ZENX_LAUNCH_PATH_FIXTURE: configPath,
      PATH: SPARSE_PATH,
    };
    delete env.ZENX_SYNTHETIC_PROFILE_SECRET;
    delete env.ZENX_SYNTHETIC_PROFILE_TOKEN;
    const args = ["--import", "tsx", "--input-type=module", "-e", source];
    await assert.rejects(
      run(process.execPath, args, { cwd: root, env }),
      /did not inherit recovered PATH/u,
    );
    // This unit test supplies PATH deliberately; only macOS open exercises capture.
    const recovered = { ...env, PATH: `${fixture.bin}:${SPARSE_PATH}` };
    await run(process.execPath, args, { cwd: root, env: recovered });
    const shellRecords = async () =>
      Promise.all(
        (await readdir(evidence))
          .filter((name) => /^shell-result-\d+\.json$/u.test(name))
          .map(async (name) =>
            JSON.parse(await readFile(path.join(evidence, name), "utf8")),
          ),
      );
    const success = await shellRecords();
    assert.equal(success.length, 1);
    // waitForCompletion may return a direct Shell result without task facts.
    assert.equal(success[0].result.status, null);
    assert.equal(success[0].result.exitCode, 0);
    assert.equal(success[0].result.markerMatched, true);
    assert.equal(success[0].outerSignal.aborted, false);
    const fixtureCommand = path.join(fixture.bin, "zenx-path-fixture");
    const originalCommand = await readFile(fixtureCommand, "utf8");
    try {
      // Exercise an actual Shell runtime exit 130, not a synthesized receipt.
      await writeFile(fixtureCommand, "#!/bin/sh\nexit 130\n");
      await assert.rejects(
        run(process.execPath, args, { cwd: root, env: recovered }),
        /The first real Host shell command failed/u,
      );
      const failure = (await shellRecords()).find(
        (record) => record.result.exitCode === 130,
      );
      assert.equal(failure.result.status, null);
      assert.equal(failure.result.foreground_exit_code, null);
      assert.equal(failure.result.markerMatched, false);
      assert.equal(failure.outerSignal.aborted, false);
      assert.deepEqual(
        failure.events.map((event) => event.event),
        ["shell-start", "shell-result"],
      );
      assert.doesNotMatch(
        JSON.stringify(failure),
        new RegExp(fixture.marker, "u"),
      );
    } finally {
      await writeFile(fixtureCommand, originalCommand);
    }
    await assert.rejects(
      run(process.execPath, args, {
        cwd: root,
        env: { ...recovered, ZENX_SYNTHETIC_PROFILE_SECRET: "synthetic" },
      }),
      /imported synthetic profile secrets/u,
    );
    await assert.rejects(
      run(path.join(fixture.bin, "zenx-path-fixture"), [], {
        env: { ...recovered, ZENX_SYNTHETIC_PROFILE_SECRET: "synthetic" },
      }),
      (error) => error.code === 91,
    );
  },
);

function shellObservationHarness() {
  const emitter = new EventEmitter();
  const controller = new AbortController();
  const records = [];
  let time = 100;
  const invoke = (execute, extra = {}) =>
    observeLaunchHostShell({
      execute,
      signal: controller.signal,
      marker: "synthetic-marker",
      emitter,
      now: () => time,
      record: (phase, facts) => records.push({ phase, ...facts }),
      ...extra,
    });
  return {
    emitter,
    controller,
    records,
    invoke,
    at(value) {
      time = value;
    },
  };
}

function assertObservationListenersRemoved(h) {
  for (const name of ["message", "disconnect", "SIGINT", "SIGTERM"])
    assert.equal(h.emitter.listenerCount(name), 0, name);
  assert.equal(getEventListeners(h.controller.signal, "abort").length, 0);
}

test("Host shell diagnostics return the exact result with only allowlisted facts", async () => {
  const h = shellObservationHarness();
  const result = {
    output: "synthetic-marker\n",
    exitCode: 0,
    structuredContent: {
      status: "completed",
      exit_code: 0,
      cancellation: "confirmable",
      foreground: "exited",
      stdio: "eof",
      foreground_exit_code: 0,
      foreground_signal: null,
      task_id: "private-task",
      result: { secret: "private-result" },
      payload: "private-payload",
    },
  };
  let calls = 0;
  assert.equal(
    await h.invoke(async () => {
      calls++;
      h.at(107);
      return result;
    }),
    result,
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    h.records.map((r) => [r.phase, r.elapsedMs]),
    [
      ["start", 0],
      ["result", 7],
    ],
  );
  assert.deepEqual(h.records[1].result, {
    exitCode: 0,
    outputBytes: 17,
    markerMatched: true,
    status: "completed",
    exit_code: 0,
    cancellation: "confirmable",
    foreground: "exited",
    stdio: "eof",
    foreground_exit_code: 0,
    foreground_signal: null,
  });
  assert.doesNotMatch(JSON.stringify(h.records), /synthetic-marker|private-/u);
  assertObservationListenersRemoved(h);
});

for (const [status, code] of [
  ["cancelled", 130],
  ["timed_out", 124],
  ["failed", 130],
]) {
  test(`Host shell diagnostics preserve ${status} and exit ${code} without re-execution`, async () => {
    const h = shellObservationHarness();
    const result = {
      output: "sensitive output",
      exitCode: code,
      structuredContent: {
        status,
        exit_code: code,
        foreground: "exited",
        foreground_exit_code: null,
        foreground_signal: "SIGTERM",
        stdio: "eof",
      },
    };
    let calls = 0;
    assert.equal(
      await h.invoke(async () => {
        calls++;
        return result;
      }),
      result,
    );
    assert.equal(calls, 1);
    assert.equal(h.records[1].result.status, status);
    assert.equal(h.records[1].result.exitCode, code);
    assert.equal(h.records[1].result.foreground_signal, "SIGTERM");
    assert.equal(h.records[1].result.markerMatched, false);
    assert.doesNotMatch(JSON.stringify(h.records), /sensitive output/u);
    assertObservationListenersRemoved(h);
  });
}

test("Host shell diagnostics correlate outer abort and passive control events without inspecting payloads", async () => {
  const h = shellObservationHarness();
  const originalEvents = [];
  const onMessage = (message) => originalEvents.push(message);
  const onDisconnect = () => originalEvents.push("disconnected");
  h.emitter.on("message", onMessage);
  h.emitter.once("disconnect", onDisconnect);
  await h.invoke(async () => {
    h.at(103);
    h.emitter.emit("message", { type: "unrelated", payload: "private" });
    h.at(105);
    h.emitter.emit("message", { type: "shutdown", payload: "private" });
    h.at(108);
    h.controller.abort(new DOMException("private reason", "TimeoutError"));
    h.at(109);
    h.emitter.emit("disconnect");
    h.at(111);
    return { output: "", exitCode: 130 };
  });
  assert.deepEqual(h.records[1].events, [
    { event: "shell-start", elapsedMs: 0 },
    { event: "shutdown-message", elapsedMs: 5 },
    { event: "outer-abort", elapsedMs: 8 },
    { event: "disconnect", elapsedMs: 9 },
    { event: "shell-result", elapsedMs: 11 },
  ]);
  assert.deepEqual(h.records[1].outerSignal, {
    aborted: true,
    reasonName: "TimeoutError",
  });
  assert.equal(originalEvents.length, 3);
  assert.equal(h.emitter.listenerCount("message"), 1);
  h.emitter.off("message", onMessage);
  assertObservationListenersRemoved(h);
  assert.doesNotMatch(JSON.stringify(h.records), /private/u);
});

test("Host shell signal observation preserves one-shot handlers and does not install default-suppressing handlers", async () => {
  const h = shellObservationHarness();
  let calls = 0;
  h.emitter.once("SIGTERM", () => calls++);
  await h.invoke(async () => {
    assert.equal(h.emitter.listenerCount("SIGINT"), 0);
    assert.equal(h.emitter.listenerCount("SIGTERM"), 2);
    h.at(102);
    h.emitter.emit("SIGTERM");
    assert.equal(h.emitter.listenerCount("SIGTERM"), 0);
    h.emitter.emit("SIGTERM");
    return { output: "", exitCode: 130 };
  });
  assert.equal(calls, 1);
  assert.deepEqual(h.records[0].observedSignals, ["SIGTERM"]);
  assert.equal(
    h.records[1].events.filter((e) => e.event === "SIGTERM").length,
    1,
  );
  assertObservationListenersRemoved(h);
});

test("Host shell diagnostics keep first and last events within a fixed bound", async () => {
  const h = shellObservationHarness();
  await h.invoke(async () => {
    for (let index = 1; index <= 40; index++) {
      h.at(100 + index);
      h.emitter.emit("message", { type: "shutdown" });
    }
    return { output: "", exitCode: 130 };
  });
  const result = h.records[1];
  assert.equal(result.events.length, 16);
  assert.equal(result.droppedEvents, 26);
  assert.deepEqual(
    result.events.slice(0, 8).map((e) => e.elapsedMs),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  assert.deepEqual(
    result.events.slice(8).map((e) => e.elapsedMs),
    [34, 35, 36, 37, 38, 39, 40, 40],
  );
  assertObservationListenersRemoved(h);
});

for (const thrown of [new Error("private exception"), undefined]) {
  test(`Host shell diagnostics rethrow the original ${thrown === undefined ? "undefined" : "error"} and clean up`, async () => {
    const h = shellObservationHarness();
    let rejected = false;
    try {
      await h.invoke(async () => {
        throw thrown;
      });
    } catch (error) {
      rejected = true;
      assert.equal(error, thrown);
    }
    assert.equal(rejected, true);
    assert.equal(h.records[1].outcome, "threw");
    assert.equal(h.records[1].result, null);
    assert.doesNotMatch(JSON.stringify(h.records), /private exception/u);
    assertObservationListenersRemoved(h);
  });
}

test("Host shell diagnostic write failure fails closed without losing the execution exception", async () => {
  const h = shellObservationHarness();
  const execution = new Error("original");
  const recording = new Error("record failed");
  await assert.rejects(
    h.invoke(
      async () => {
        throw execution;
      },
      {
        record(phase) {
          if (phase === "result") throw recording;
        },
      },
    ),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === execution &&
      error.errors[1] === recording,
  );
  assertObservationListenersRemoved(h);
});

test("Host shell passive sampling faults cannot throw into product event handling", async () => {
  const h = shellObservationHarness();
  let completed = false;
  await assert.rejects(
    h.invoke(async () => {
      assert.doesNotThrow(() =>
        h.emitter.emit("message", {
          get type() {
            throw new Error("private");
          },
        }),
      );
      completed = true;
      return { output: "", exitCode: 130 };
    }),
    /Host shell observation failed/u,
  );
  assert.equal(completed, true);
  assert.equal(h.records[1].diagnosticErrorCount, 1);
  assert.doesNotMatch(JSON.stringify(h.records), /private/u);
  assertObservationListenersRemoved(h);
});

test("Host shell diagnostics exclude unknown labels and custom abort names", async () => {
  const h = shellObservationHarness();
  h.controller.abort({ name: "private reason", message: "private message" });
  await h.invoke(async () => ({
    output: "é",
    exitCode: NaN,
    structuredContent: {
      status: "private status",
      cancellation: "private cancellation",
      foreground: "private foreground",
      stdio: "private stdio",
      foreground_signal: "private signal",
      foreground_exit_code: Infinity,
    },
  }));
  assert.deepEqual(h.records[1].outerSignal, {
    aborted: true,
    reasonName: "other",
  });
  assert.equal(h.records[1].result.outputBytes, 2);
  assert.equal(h.records[1].result.exitCode, null);
  assert.equal(h.records[1].result.status, null);
  assert.doesNotMatch(JSON.stringify(h.records), /private/u);
  assertObservationListenersRemoved(h);
});

test("Host shell start receipt failure prevents execution and removes its listeners", async () => {
  const h = shellObservationHarness();
  const recording = new Error("record failed");
  let calls = 0;
  await assert.rejects(
    h.invoke(
      async () => {
        calls++;
      },
      {
        record() {
          throw recording;
        },
      },
    ),
    (error) => error instanceof AggregateError && error.errors[0] === recording,
  );
  assert.equal(calls, 0);
  assertObservationListenersRemoved(h);
});

test("Host shell clock failure keeps the original thrown result and cleans up", async () => {
  const h = shellObservationHarness();
  const execution = new Error("original");
  await assert.rejects(
    h.invoke(async () => {
      h.at(99);
      throw execution;
    }),
    (error) => error instanceof AggregateError && error.errors[0] === execution,
  );
  assertObservationListenersRemoved(h);
});
