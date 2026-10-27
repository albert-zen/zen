import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import {
  fakeHostProfile,
  portableExecutable,
  syntheticEnvironment,
  writeControl,
} from "../scripts/smoke-portable-artifact.js";

test("delivery smoke selects a real native app entrypoint, not source or a smoke app", () => {
  assert.equal(portableExecutable("darwin"), "ZenX.app/Contents/MacOS/ZenX");
  assert.equal(portableExecutable("win32"), "ZenX.exe");
  assert.throws(() => portableExecutable("linux"), /native macOS or Windows/u);
});

test("the delivery profile selects fake default and title models with no workspace or credentials", () => {
  assert.deepEqual(fakeHostProfile(), {
    version: 1,
    onboardingComplete: true,
    provider: { type: "fake", displayName: "Local demo" },
    defaultModel: "fake",
    titleModel: "fake",
    models: ["fake"],
    workspace: null,
    workspaces: [],
    lastUsedWorkspace: null,
    approvalPolicy: "never",
  });
});

test("child environment isolates all profile roots and drops credentials and acceptance hooks", () => {
  const fixture = path.resolve("synthetic-fixture");
  const core = path.join(fixture, "core");
  const environment = syntheticEnvironment(fixture, core, {
    PATH: "synthetic-public-toolchain",
    SystemRoot: "synthetic-system",
    HOME: "real-home-must-not-pass",
    USERPROFILE: "real-profile-must-not-pass",
    ZENX_DATA_DIR: "real-core-must-not-pass",
    ZENX_PROJECT_ACCEPTANCE_CONFIG: "fixture-hook-must-not-pass",
    ZENX_EXTERNAL_ZAS_ACCEPTANCE_CONFIG: "fixture-hook-must-not-pass",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_OPTIONS: "--require=fixture-hook",
    OPENAI_API_KEY: "synthetic-key-must-not-pass",
    SSH_AUTH_SOCK: "synthetic-agent-must-not-pass",
  });
  assert.equal(environment.PATH, "synthetic-public-toolchain");
  assert.equal(environment.SystemRoot, "synthetic-system");
  assert.equal(environment.ZENX_DATA_DIR, core);
  for (const key of [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "TMP",
    "TEMP",
    "TMPDIR",
  ]) {
    assert.equal(
      path.relative(fixture, environment[key]!).startsWith(".."),
      false,
    );
  }
  for (const key of [
    "ZENX_PROJECT_ACCEPTANCE_CONFIG",
    "ZENX_EXTERNAL_ZAS_ACCEPTANCE_CONFIG",
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "OPENAI_API_KEY",
    "SSH_AUTH_SOCK",
  ]) {
    assert.equal(environment[key], undefined, `${key} must not be inherited`);
  }
});

test("existing acceptance control is atomically replaced without artifact writes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-control-test-"));
  try {
    const file = path.join(directory, "control.json");
    await writeControl(file, {
      phase: "turn-started",
      threadId: "synthetic-thread",
      turnId: "synthetic-turn",
    });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      phase: "turn-started",
      threadId: "synthetic-thread",
      turnId: "synthetic-turn",
    });
    await writeControl(file, { phase: "quit", threadId: "synthetic-thread" });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      phase: "quit",
      threadId: "synthetic-thread",
    });
    assert.deepEqual(await readdir(directory), ["control.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-artifact smoke reuses the existing product hook without packaging or debugger injection", async () => {
  const source = await readFile(
    new URL("../scripts/smoke-portable-artifact.ts", import.meta.url),
    "utf8",
  );
  assert.equal(
    /packageZenX|createBuildSnapshot|execFile|--inspect|executeJavaScript/u.test(
      source,
    ),
    false,
  );
  assert.ok(source.includes("ZENX_EXTERNAL_ZAS_ACCEPTANCE_CONFIG: configPath"));
  assert.ok(source.includes("verifyArtifacts: true"));
  assert.ok(source.includes('phase: "turn-started"'));
  assert.ok(source.includes('phase: "quit"'));
});

test("cancellation observes an owned dispatch marker, not terminal-only protocol output", async () => {
  const source = await readFile(
    new URL("../scripts/smoke-portable-artifact.ts", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes('path.join(workspace, "portable-cancel-ready")'));
  assert.ok(
    source.includes("echo portable-cancel-started > portable-cancel-ready"),
  );
  assert.equal(source.includes('"item/commandExecution/outputDelta"'), false);
});
