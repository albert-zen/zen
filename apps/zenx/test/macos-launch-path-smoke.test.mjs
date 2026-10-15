import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
