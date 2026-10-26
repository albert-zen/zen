import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ComputerZenXCapabilityPackage,
  type ComputerInspection,
} from "../src/main/capabilities/computer-provider.js";
import { MemoryZenXPluginCatalogStore } from "../src/main/capabilities/plugin-catalog-store.js";
import { ZenXPluginCatalog } from "../src/main/capabilities/plugin-catalog.js";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { createDelegatingFirstPartyProfileLoader } from "../src/main/first-party-profile-loader.js";
import { createZenXTrustedPlugin } from "../../../packages/zenx-computer-plugin/src/runtime.js";
import {
  runBoundedProcess,
  windowsComputerCapabilityManifest,
  WinAppCliComputerBackend,
  type WinAppCliRunner,
  type WinAppCliRunOptions,
  type WinAppCliRunResult,
} from "../src/main/capabilities/windows-computer-provider.js";

import {
  WINDOWS_BACKGROUND_CAPTURE_SCRIPT,
  windowsBackgroundCaptureCommand,
} from "../src/main/capabilities/windows-background-capture.js";

const target = {
  pid: 4242,
  applicationId: "FixtureApp",
  windowTitle: "Fixture Window",
};

test("public Computer discovery returns targets usable for inspection without prior target knowledge", async () => {
  const runner = new FixtureWinAppRunner();
  const capability = new ComputerZenXCapabilityPackage(
    new WinAppCliComputerBackend({ platform: "win32", runner }),
    windowsComputerCapabilityManifest,
  );
  assert.ok(
    capability.manifest.tools.some(
      (tool) => tool.name === "computer_list_windows",
    ),
  );
  const result = (await capability.invoke(
    "computer_list_windows",
    invocation({}),
  )) as {
    windows: Array<{ target: typeof target }>;
    truncated: boolean;
  };
  assert.equal(result.truncated, false);
  assert.deepEqual(result.windows[0]?.target, target);
  await capability.invoke(
    "computer_inspect",
    invocation({ target: result.windows[0]!.target }),
  );
  assert.deepEqual(runner.commands[0], ["ui", "list-windows", "--json"]);
});

test("Windows provider maps WinApp JSON into opaque bounded UIA controls", async () => {
  const runner = new FixtureWinAppRunner();
  const backend = new WinAppCliComputerBackend({
    platform: "win32",
    runner,
  });
  const capability = new ComputerZenXCapabilityPackage(
    backend,
    windowsComputerCapabilityManifest,
    true,
  );

  const inspected = (await capability.invoke(
    "computer_inspect",
    invocation({ target }),
  )) as ComputerInspection;
  assert.equal(inspected.platform, "win32");
  assert.equal(inspected.target.applicationId, "FixtureApp");
  assert.equal(inspected.controls.length, 3);
  assert.equal(inspected.controls[0]?.title, "Save");
  assert.deepEqual(inspected.controls[0]?.actions, ["press"]);
  assert.deepEqual(inspected.controls[1]?.actions, ["set_value"]);
  assert.deepEqual(inspected.controls[2]?.actions, ["set_value"]);
  assert.doesNotMatch(JSON.stringify(inspected), /existing private value/u);
  assert.doesNotMatch(JSON.stringify(inspected), /provider-button-selector/u);

  await capability.invoke(
    "computer_press",
    invocation({ target, control: inspected.controls[0]!.selector }),
  );
  const refreshed = (await capability.invoke(
    "computer_inspect",
    invocation({ target }),
  )) as ComputerInspection;
  const set = await capability.invoke(
    "computer_set_value",
    invocation({
      target,
      control: refreshed.controls[1]!.selector,
      value: "deliberate non-secret text",
    }),
  );
  assert.equal((set as { characterCount: number }).characterCount, 26);
  assert.doesNotMatch(JSON.stringify(set), /deliberate non-secret/u);

  const invokeCommand = runner.commands.find((args) => args[1] === "invoke");
  assert.deepEqual(invokeCommand, [
    "ui",
    "invoke",
    "provider-button-selector",
    "--window",
    "9001",
    "--json",
  ]);
  const setCommand = runner.commands.find((args) => args[1] === "set-value");
  assert.deepEqual(setCommand?.slice(0, 3), [
    "ui",
    "set-value",
    "provider-field-selector",
  ]);
});

test("verifies each WinApp process launch once at the runner boundary", async () => {
  const fixture = new FixtureWinAppRunner();
  let verifications = 0;
  const runner: WinAppCliRunner = {
    run: async (executable, args, options) => {
      await options.verifyBeforeSpawn?.();
      return await fixture.run(executable, args, {
        ...options,
        verifyBeforeSpawn: undefined,
      });
    },
  };
  const backend = new WinAppCliComputerBackend({
    platform: "win32",
    runner,
    verifyExecutable: async () => {
      verifications += 1;
    },
  });

  await backend.inspect(target);

  assert.equal(fixture.commands.length, 2);
  assert.equal(verifications, 2);
});

test("discovery narrows a truncated desktop and preserves sibling windows and exact long or empty titles", async () => {
  const runner = new FixtureWinAppRunner();
  runner.windows = Array.from({ length: 40 }, (_, index) => ({
    ...fixtureWindow(),
    hwnd: String(9001 + index),
    title: `Document ${index}`,
  }));
  const capability = new ComputerZenXCapabilityPackage(
    new WinAppCliComputerBackend({ platform: "win32", runner }),
    windowsComputerCapabilityManifest,
  );
  const listed = (await capability.invoke(
    "computer_list_windows",
    invocation({}),
  )) as { windows: unknown[]; truncated: boolean };
  assert.equal(listed.windows.length, 32);
  assert.equal(listed.truncated, true);
  const narrowed = (await capability.invoke(
    "computer_list_windows",
    invocation({ query: "DOCUMENT 39" }),
  )) as { windows: Array<{ target: typeof target }>; truncated: boolean };
  assert.equal(narrowed.windows[0]?.target.windowTitle, "Document 39");
  assert.equal(narrowed.truncated, false);
  for (const title of ["Long title ".repeat(40), ""]) {
    runner.windows = [{ ...fixtureWindow(), title }];
    const discovery = (await capability.invoke(
      "computer_list_windows",
      invocation({}),
    )) as { windows: Array<{ target: typeof target }> };
    assert.equal(discovery.windows[0]?.target.windowTitle, title);
    await capability.invoke(
      "computer_inspect",
      invocation({ target: discovery.windows[0]!.target }),
    );
  }
});

test("discovery reports invalid native results and respects cancellation before dispatch", async () => {
  const runner = new FixtureWinAppRunner();
  const capability = new ComputerZenXCapabilityPackage(
    new WinAppCliComputerBackend({ platform: "win32", runner }),
    windowsComputerCapabilityManifest,
  );
  runner.schemaProbeOutput = '{"bad":true}';
  await assert.rejects(
    capability.invoke("computer_list_windows", invocation({})),
    /invalid JSON shape/u,
  );
  const calls = runner.commands.length;
  const cancelled = {
    ...invocation({}),
    signal: AbortSignal.abort(new Error("cancel discovery")),
  };
  await assert.rejects(
    capability.invoke("computer_list_windows", cancelled),
    /cancel discovery/u,
  );
  assert.equal(runner.commands.length, calls);
});

test("Windows screenshot uses a strict background helper instead of WinApp activation fallback", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-winapp-test-"));
  try {
    const runner = new FixtureWinAppRunner();
    const backend = new WinAppCliComputerBackend({
      artifactDirectory: directory,
      platform: "win32",
      runner,
      captureRunner: runner,
    });
    const result = await backend.screenshot(target);
    assert.equal(result.target.windowTitle, "Fixture Window");
    assert.equal(result.width, 1280);
    assert.equal(result.height, 720);
    assert.equal(result.bytes, 33);
    assert.equal(
      runner.commands.some((args) => args[1] === "screenshot"),
      false,
    );
    assert.equal(
      runner.commands.some((args) => args.includes("-EncodedCommand")),
      true,
    );
    assert.deepEqual(runner.captureRequest, {
      hwnd: "9001",
      pid: 4242,
      title: "Fixture Window",
    });
    await backend.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows background capture transports Unicode and source-like titles as stdin data", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-background-unicode-"),
  );
  const runner = new FixtureWinAppRunner();
  const title = '中文 😀 "quoted" \\ $literal';
  runner.windows = [{ ...fixtureWindow(), title }];
  const backend = new WinAppCliComputerBackend({
    platform: "win32",
    runner,
    captureRunner: runner,
    artifactDirectory: directory,
  });
  try {
    await backend.screenshot({ ...target, windowTitle: title });
    assert.equal(runner.captureRequest?.title, title);
    const script = Buffer.from(
      runner.commands.find((args) => args.includes("-EncodedCommand"))!.at(-1)!,
      "base64",
    ).toString("utf16le");
    assert.equal(script.includes(title), false);
    assert.match(script, /Console\]::InputEncoding/u);
    assert.match(script, /Console\]::OutputEncoding/u);
  } finally {
    await backend.close();
  }
});

test("strict Windows capture has no activation/input API and bounded stdin transport", () => {
  assert.doesNotMatch(
    WINDOWS_BACKGROUND_CAPTURE_SCRIPT,
    /ShowWindow|SetForegroundWindow|SendInput|SetCursorPos|SwitchDesktop/u,
  );
  assert.match(WINDOWS_BACKGROUND_CAPTURE_SCRIPT, /IsIconic/u);
  assert.match(WINDOWS_BACKGROUND_CAPTURE_SCRIPT, /PrintWindow/u);
  assert.match(
    WINDOWS_BACKGROUND_CAPTURE_SCRIPT,
    /finally \{ graphics.ReleaseHdc/u,
  );
  const command = windowsBackgroundCaptureCommand();
  assert.equal(path.win32.isAbsolute(command.executable), true);
  assert.equal(command.args.includes("-ExecutionPolicy"), false);
  assert.ok(command.args.join(" ").length < 30_000);
});

test("unavailable Windows background frames fail without WinApp or foreground fallback", async () => {
  for (const failure of [
    "capture_minimized",
    "capture_blank",
    "capture_unrendered",
    "capture_protected",
    "capture_target_changed",
  ]) {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-background-fail-"),
    );
    const runner = new FixtureWinAppRunner();
    runner.captureError = new Error(failure);
    const backend = new WinAppCliComputerBackend({
      platform: "win32",
      runner,
      captureRunner: runner,
      artifactDirectory: directory,
    });
    try {
      await assert.rejects(backend.screenshot(target), new RegExp(failure));
      assert.equal(
        runner.commands.some(
          (args) =>
            args[1] === "screenshot" || args.includes("--capture-screen"),
        ),
        false,
      );
      assert.deepEqual(
        (
          await readdir(directory, { recursive: true, withFileTypes: true })
        ).filter((entry) => !entry.isDirectory()),
        [],
      );
    } finally {
      await backend.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("Windows capture rejects unconfirmed target identity and invalid PNG before publishing", async () => {
  for (const override of [
    { processId: 12 },
    { hwnd: "99" },
    { method: "foreground" },
    { pngBase64: "invalid!" },
    { pngBase64: "A".repeat(5_592_408) },
    { width: 3 },
  ]) {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-background-invalid-"),
    );
    const runner = new FixtureWinAppRunner();
    runner.captureOverride = override;
    const backend = new WinAppCliComputerBackend({
      platform: "win32",
      runner,
      captureRunner: runner,
      artifactDirectory: directory,
    });
    try {
      await assert.rejects(backend.screenshot(target), /Background capture/u);
      assert.deepEqual(
        (
          await readdir(directory, { recursive: true, withFileTypes: true })
        ).filter((entry) => !entry.isDirectory()),
        [],
      );
    } finally {
      await backend.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("Windows provider trims only trailing transparent screenshot padding", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-winapp-test-"));
  try {
    const runner = new FixtureWinAppRunner();
    const bitmap = Buffer.alloc(1280 * 720 * 4);
    for (let y = 20; y < 380; y += 1) {
      for (let x = 10; x < 650; x += 1) {
        bitmap[(y * 1280 + x) * 4 + 3] = 255;
      }
    }
    let crop:
      { x: number; y: number; width: number; height: number } | undefined;
    const backend = new WinAppCliComputerBackend({
      artifactDirectory: directory,
      platform: "win32",
      runner,
      captureRunner: runner,
      loadScreenshotImage: () => ({
        getSize: () => ({ width: 1280, height: 720 }),
        toBitmap: () => bitmap,
        crop: (bounds) => {
          crop = bounds;
          return {
            getSize: () => ({ width: bounds.width, height: bounds.height }),
            toBitmap: () => Buffer.alloc(bounds.width * bounds.height * 4),
            crop: () => {
              throw new Error("unexpected nested crop");
            },
            toPNG: () => Buffer.from("trimmed"),
          };
        },
        toPNG: () => Buffer.from("original"),
      }),
    });

    const result = await backend.screenshot(target);

    assert.deepEqual(crop, { x: 0, y: 0, width: 650, height: 380 });
    assert.equal(result.width, 650);
    assert.equal(result.height, 380);
    assert.equal(result.bytes, 7);
    await backend.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows screenshot artifact is host-owned and does not trust a helper output path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-winapp-test-"));
  const artifactDirectory = path.join(directory, "artifacts");
  const aliasDirectory = path.join(directory, "artifact-alias");
  try {
    await mkdir(artifactDirectory);
    await symlink(
      artifactDirectory,
      aliasDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const runner = new FixtureWinAppRunner();
    runner.captureOverride = {
      filePath: path.join(aliasDirectory, "untrusted.png"),
    };
    const backend = new WinAppCliComputerBackend({
      artifactDirectory,
      platform: "win32",
      runner,
      captureRunner: runner,
    });

    const result = await backend.screenshot(target);

    assert.equal(
      path.dirname(path.dirname(result.artifactPath)),
      artifactDirectory,
    );
    await backend.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows provider rejects ambiguous windows and stale selectors while dispatching ordinary values", async () => {
  const runner = new FixtureWinAppRunner();
  const backend = new WinAppCliComputerBackend({
    platform: "win32",
    runner,
  });
  const inspected = await backend.inspect(target);
  const secure = inspected.controls[2]!;
  await backend.setValue(target, secure.selector, "must-run-normally");
  assert.equal(
    runner.commands.some((args) => args.includes("must-run-normally")),
    true,
  );

  const first = inspected.controls[0]!.selector;
  await backend.inspect(target);
  await assert.rejects(backend.press(target, first), /stale, unknown/u);

  runner.ambiguous = true;
  await assert.rejects(backend.inspect(target), /ambiguous/u);
});

test("Windows provider revalidates secure state and semantic identity immediately before acting", async () => {
  const runner = new FixtureWinAppRunner();
  const backend = new WinAppCliComputerBackend({
    platform: "win32",
    runner,
  });
  const first = await backend.inspect(target);
  runner.secureField = true;
  await assert.rejects(
    backend.setValue(target, first.controls[1]!.selector, "must-not-run"),
    /changed since the observation/u,
  );
  assert.equal(
    runner.commands.some(
      (args) => args[1] === "set-value" && args.includes("must-not-run"),
    ),
    false,
  );

  runner.secureField = false;
  const second = await backend.inspect(target);
  runner.buttonX = 99;
  await assert.rejects(
    backend.press(target, second.controls[0]!.selector),
    /changed since the observation/u,
  );
  assert.equal(
    runner.commands.some((args) => args[1] === "invoke"),
    false,
  );
});

test("Windows provider rejects legacy inspect envelopes instead of silently misparsing them", async () => {
  const runner = new FixtureWinAppRunner();
  runner.legacyInspectEnvelope = true;
  const backend = new WinAppCliComputerBackend({
    platform: "win32",
    runner,
  });
  await assert.rejects(
    backend.inspect(target),
    /incompatible JSON shape.*0\.3\.1/u,
  );
});

test("Windows activating mutations are classified without removing read-only UIA or capture", () => {
  const tools = windowsComputerCapabilityManifest.tools;
  for (const name of ["computer_press", "computer_set_value"]) {
    const tool = tools.find((entry) => entry.name === name)!;
    assert.equal(tool.interactionMode, "foreground_required");
    assert.ok(tool.permissions.includes("computer.foreground.control"));
    assert.ok(tool.capabilities?.includes("may_activate_target"));
  }
  assert.ok(
    windowsComputerCapabilityManifest.provider.interactionModes.includes(
      "foreground_required",
    ),
  );
  for (const name of [
    "computer_list_windows",
    "computer_inspect",
    "computer_screenshot",
  ]) {
    assert.equal(
      tools.find((tool) => tool.name === name)?.interactionMode,
      "background_safe",
    );
  }
  assert.equal(
    tools.some((tool) => tool.name.startsWith("computer_foreground_")),
    false,
  );
});

for (const toolName of ["computer_press", "computer_set_value"] as const) {
  test(`Windows ${toolName} refuses before resolving or consuming the inspected control without foreground permission`, async () => {
    const runner = new FixtureWinAppRunner();
    const capability = new ComputerZenXCapabilityPackage(
      new WinAppCliComputerBackend({ platform: "win32", runner }),
      windowsComputerCapabilityManifest,
    );
    const inspected = (await capability.invoke(
      "computer_inspect",
      invocation({ target }),
    )) as ComputerInspection;
    const value = '中文 😀 "quoted" \\';
    const args = {
      target,
      control:
        inspected.controls[toolName === "computer_press" ? 0 : 1]!.selector,
      ...(toolName === "computer_set_value" ? { value } : {}),
    };
    const before = runner.commands.length;
    await assert.rejects(
      capability.invoke(toolName, invocation(args)),
      /foreground_required.*enable Foreground computer control/u,
    );
    assert.equal(
      runner.commands.length,
      before,
      "denial must precede every native call and preserve the observation",
    );
    assert.equal(runner.writtenValue, "");
    capability.setForegroundControlAllowed(true);
    const result = (await capability.invoke(toolName, invocation(args))) as {
      impact: string;
      characterCount?: number;
    };
    assert.equal(result.impact, "foreground_takeover");
    if (toolName === "computer_set_value") {
      assert.equal(result.characterCount, value.length);
      assert.equal(runner.writtenValue, value);
    } else {
      assert.equal(
        runner.commands.filter((args) => args[1] === "invoke").length,
        1,
      );
    }
    capability.setForegroundControlAllowed(false);
    await assert.rejects(
      capability.invoke(toolName, invocation(args)),
      /foreground_required/u,
    );
    await capability.close();
  });

  test(`Windows ${toolName} foreground permission can be revoked during its cancellation notice`, async () => {
    const runner = new FixtureWinAppRunner();
    const capability = new ComputerZenXCapabilityPackage(
      new WinAppCliComputerBackend({ platform: "win32", runner }),
      windowsComputerCapabilityManifest,
      true,
    );
    const inspected = (await capability.invoke(
      "computer_inspect",
      invocation({ target }),
    )) as ComputerInspection;
    const before = runner.commands.length;
    const execution = capability.invoke(
      toolName,
      invocation({
        target,
        control:
          inspected.controls[toolName === "computer_press" ? 0 : 1]!.selector,
        ...(toolName === "computer_set_value"
          ? { value: "must not be written" }
          : {}),
      }),
    );
    capability.setForegroundControlAllowed(false);
    capability.setForegroundControlAllowed(true);
    await assert.rejects(execution, /foreground_required/u);
    assert.equal(runner.commands.length, before);
    await capability.close();
  });
}

test("Windows host catalog hides activating mutations until explicit foreground permission and removes them on revoke", async () => {
  const runner = new FixtureWinAppRunner();
  const capability = new ComputerZenXCapabilityPackage(
    new WinAppCliComputerBackend({ platform: "win32", runner }),
    windowsComputerCapabilityManifest,
  );
  const catalog = new ZenXPluginCatalog(new MemoryZenXPluginCatalogStore(), {
    platform: "win32",
  });
  await catalog.initialize();
  await catalog.install(capability, "bundled");
  const exposed = (name: string) =>
    catalog.hostSnapshot().definitions.some((tool) => tool.name === name);
  assert.equal(exposed("computer_inspect"), true);
  assert.equal(exposed("computer_screenshot"), true);
  for (const name of ["computer_press", "computer_set_value"]) {
    assert.equal(exposed(name), false);
    assert.throws(
      () => catalog.assertToolExposed(name),
      /foreground_required/u,
    );
  }
  catalog.setForegroundRequiredAllowed(true);
  for (const name of ["computer_press", "computer_set_value"]) {
    assert.equal(exposed(name), true);
    catalog.assertToolExposed(name);
  }
  catalog.setForegroundRequiredAllowed(false);
  for (const name of ["computer_press", "computer_set_value"]) {
    assert.equal(exposed(name), false);
  }
  assert.equal(exposed("computer_inspect"), true);
  await catalog.close();
});

test("Windows activating mutations reject stale background-safe profile metadata at the actual delegated service", async () => {
  const runner = new FixtureWinAppRunner();
  const service = new ComputerZenXCapabilityPackage(
    new WinAppCliComputerBackend({ platform: "win32", runner }),
    windowsComputerCapabilityManifest,
  );
  const runtime = createDelegatingFirstPartyProfileLoader(() => service)({
    createZenXTrustedPlugin,
  });
  const staleManifest = structuredClone(windowsComputerCapabilityManifest);
  staleManifest.version = "1.1.3";
  for (const tool of staleManifest.tools) {
    if (tool.name !== "computer_press" && tool.name !== "computer_set_value")
      continue;
    tool.interactionMode = "background_safe";
    tool.permissions = tool.permissions.filter(
      (permission) => permission !== "computer.foreground.control",
    );
  }
  const catalog = new ZenXPluginCatalog(new MemoryZenXPluginCatalogStore(), {
    platform: "win32",
  });
  await catalog.initialize();
  await catalog.install(
    { manifest: staleManifest, invoke: runtime.invoke },
    "bundled",
  );
  try {
    for (const name of ["computer_press", "computer_set_value"]) {
      catalog.assertToolExposed(name);
      await assert.rejects(
        runtime.invoke(
          name,
          invocation({
            target,
            control: { observationId: "old", targetId: "old" },
            ...(name === "computer_set_value"
              ? { value: "must not be written" }
              : {}),
          }),
        ),
        /foreground_required/u,
      );
    }
    assert.equal(runner.commands.length, 0);
  } finally {
    await catalog.close();
    await service.close();
  }
});

test("WinApp diagnostic is actionable without installing on non-Windows test hosts", async () => {
  const ready = await new WinAppCliComputerBackend({
    platform: "win32",
    command: "fixture-winapp",
    runner: new FixtureWinAppRunner(),
  }).diagnose();
  assert.equal(ready.ready, true);
  assert.equal(ready.version, "1.2.3");
  assert.equal(ready.requiredVersion, "0.3.1");
  assert.equal(ready.schemaCompatible, true);

  const pinnedMismatch = await new WinAppCliComputerBackend({
    platform: "win32",
    runner: new FixtureWinAppRunner(),
    expectedVersion: "1.2.4",
  }).diagnose();
  assert.equal(pinnedMismatch.ready, false);
  assert.match(
    pinnedMismatch.message,
    /does not match pinned version 1\.2\.4/u,
  );

  const oldRunner = new FixtureWinAppRunner();
  oldRunner.versionOutput = "winapp 0.3.0\n";
  const old = await new WinAppCliComputerBackend({
    platform: "win32",
    runner: oldRunner,
  }).diagnose();
  assert.equal(old.ready, false);
  assert.equal(old.version, "0.3.0");
  assert.match(old.message, /0\.3\.0.*0\.3\.1/u);
  assert.equal(
    oldRunner.commands.some((args) => args[1] === "list-windows"),
    false,
  );

  const unknownRunner = new FixtureWinAppRunner();
  unknownRunner.versionOutput = "WinApp CLI public preview\n";
  const unknown = await new WinAppCliComputerBackend({
    platform: "win32",
    runner: unknownRunner,
  }).diagnose();
  assert.equal(unknown.ready, false);
  assert.equal(unknown.version, undefined);
  assert.match(unknown.message, /unknown.*0\.3\.1/u);

  const incompatibleSchemaRunner = new FixtureWinAppRunner();
  incompatibleSchemaRunner.schemaProbeOutput = '{"elements":[]}';
  const incompatibleSchema = await new WinAppCliComputerBackend({
    platform: "win32",
    runner: incompatibleSchemaRunner,
  }).diagnose();
  assert.equal(incompatibleSchema.ready, false);
  assert.equal(incompatibleSchema.version, "1.2.3");
  assert.equal(incompatibleSchema.schemaCompatible, false);
  assert.match(incompatibleSchema.message, /incompatible.*detected 1\.2\.3/u);

  const unavailable = await new WinAppCliComputerBackend({
    platform: "darwin",
  }).diagnose();
  assert.equal(unavailable.ready, false);
  assert.match(unavailable.message, /only available on Windows/u);
  assert.match(unavailable.installCommand, /winget install/u);
});

test("ZenX startup does not expose an incompatible WinApp provider", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-winapp-startup-"),
  );
  const runner = new FixtureWinAppRunner();
  runner.versionOutput = "winapp 0.3.0\n";
  const service = new ZenXCapabilityService({
    userDataDirectory: directory,
    catalogStore: new MemoryZenXPluginCatalogStore(),
    computerBackend: new WinAppCliComputerBackend({
      platform: "win32",
      runner,
      captureRunner: runner,
    }),
    computerManifest: windowsComputerCapabilityManifest,
  });
  try {
    await service.initialize();
    const snapshot = service.diagnostics();
    assert.match(
      snapshot.providerDiagnostics
        .map((diagnostic) => diagnostic.reason ?? "")
        .join("\n"),
      /0\.3\.0.*0\.3\.1/u,
    );
    assert.equal(
      service
        .hostSnapshot()
        .definitions.some((definition) =>
          definition.name.startsWith("computer_"),
        ),
      false,
    );
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("WinApp process runner enforces cancellation, timeout, and output bounds", async () => {
  const input = '中文 😀 "quoted" \\';
  const echoed = await runBoundedProcess(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"],
    { timeoutMs: 1000, stdin: input },
  );
  assert.equal(echoed.stdout, input);

  const controller = new AbortController();
  const cancelled = runBoundedProcess(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { timeoutMs: 5_000, signal: controller.signal },
  );
  controller.abort(new DOMException("stopped", "AbortError"));
  await assert.rejects(cancelled, /stopped/u);

  let bindings = 0;
  let releases = 0;
  await runBoundedProcess(
    process.execPath,
    ["-e", "process.stdout.write('ok')"],
    {
      timeoutMs: 1_000,
      bindBeforeSpawn: async () => {
        bindings += 1;
        return async () => {
          releases += 1;
        };
      },
    },
  );
  assert.equal(bindings, 1);
  assert.equal(releases, 1);

  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 25,
    }),
    /timed out/u,
  );
  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", "console.log('x'.repeat(99))"], {
      timeoutMs: 1_000,
      maxStdoutBytes: 16,
    }),
    /stdout exceeded/u,
  );
  const sensitiveFailure = await runBoundedProcess(
    process.execPath,
    ["-e", "console.error('exact-private-value'); process.exit(2)"],
    {
      timeoutMs: 1_000,
      redactions: ["exact-private-value"],
    },
  ).catch((error: unknown) => error);
  assert.match(String(sensitiveFailure), /\[REDACTED\]/u);
  assert.doesNotMatch(String(sensitiveFailure), /exact-private-value/u);
});

test("revoking foreground permission during WinApp launch preparation prevents process spawn", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-winapp-preparation-"),
  );
  const marker = path.join(directory, "must-not-exist");
  const controller = new AbortController();
  let entered!: () => void;
  const preparing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operation = runBoundedProcess(
    process.execPath,
    [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe spawn');`,
    ],
    {
      timeoutMs: 3000,
      signal: controller.signal,
      verifyBeforeSpawn: async () => {
        entered();
        await gate;
      },
    },
  );
  await preparing;
  controller.abort(new Error("foreground_required permission revoked"));
  release();
  await assert.rejects(operation, /foreground_required/u);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  await rm(directory, { recursive: true, force: true });
});

test("WinApp cancellation settles and releases its binding only after the real child is gone", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-winapp-settlement-"),
  );
  const ready = path.join(directory, "ready");
  const controller = new AbortController();
  let childPid: number | undefined;
  let aliveWhenReleased: boolean | undefined;
  const operation = runBoundedProcess(
    process.execPath,
    [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`,
    ],
    {
      timeoutMs: 5000,
      signal: controller.signal,
      bindBeforeSpawn: async () => async () => {
        try {
          process.kill(childPid!, 0);
          aliveWhenReleased = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          aliveWhenReleased = false;
        }
      },
    },
  );
  const rejection = assert.rejects(operation, /fixture cancellation/u);
  try {
    const deadline = Date.now() + 3000;
    while (childPid === undefined && Date.now() < deadline) {
      try {
        childPid = Number(await readFile(ready, "utf8"));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(childPid);
    controller.abort(new Error("fixture cancellation"));
    await rejection;
    assert.equal(
      aliveWhenReleased,
      false,
      "kill request is not observed process termination",
    );
    assert.throws(() => process.kill(childPid!, 0), { code: "ESRCH" });
  } finally {
    controller.abort(new Error("fixture cancellation"));
    await rejection;
    await rm(directory, { recursive: true, force: true });
  }
});

class FixtureWinAppRunner implements WinAppCliRunner {
  windows: ReturnType<typeof fixtureWindow>[] | undefined;
  crowded = false;
  readonly commands: string[][] = [];
  ambiguous = false;
  buttonX = 10;
  secureField = false;
  legacyInspectEnvelope = false;
  schemaProbeOutput: string | undefined;
  versionOutput = "winapp 1.2.3-preview\n";
  writtenValue = "";
  screenshotPath: ((artifactPath: string) => string) | undefined;
  captureRequest: Record<string, unknown> | undefined;
  captureError: Error | undefined;
  captureOverride: Record<string, unknown> | undefined;

  async run(
    _executable: string,
    args: readonly string[],
    _options: WinAppCliRunOptions,
  ): Promise<WinAppCliRunResult> {
    this.commands.push([...args]);
    if (args.includes("-EncodedCommand")) {
      this.captureRequest = JSON.parse(_options.stdin!);
      if (this.captureError) throw this.captureError;
      const png = Buffer.alloc(33);
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
      png.write("IHDR", 12, "ascii");
      png.writeUInt32BE(1280, 16);
      png.writeUInt32BE(720, 20);
      return output(
        JSON.stringify({
          method: "strict-background-printwindow",
          hwnd: "9001",
          processId: 4242,
          windowTitle: this.captureRequest!.title,
          width: 1280,
          height: 720,
          pngBase64: png.toString("base64"),
          ...this.captureOverride,
        }),
      );
    }
    if (args[0] === "--version") {
      return output(this.versionOutput);
    }
    if (args[0] === "--cli-schema") {
      const version =
        this.versionOutput.match(/\d+\.\d+\.\d+/u)?.[0] ?? "0.0.0";
      return output(JSON.stringify(fixtureCliSchema(version)));
    }
    if (args[1] === "list-windows") {
      if (!args.includes("--app") && this.schemaProbeOutput !== undefined) {
        return output(this.schemaProbeOutput);
      }
      const windows = this.windows ?? [fixtureWindow()];
      if (this.ambiguous) windows.push(fixtureWindow());
      return output(JSON.stringify(windows));
    }
    if (args[1] === "inspect") {
      if (this.legacyInspectEnvelope) {
        return output(JSON.stringify({ elements: [] }));
      }
      return output(
        JSON.stringify(
          fixtureInspection(this.buttonX, this.secureField, this.crowded),
        ),
      );
    }
    if (args[1] === "invoke") {
      return output(
        JSON.stringify({
          elementId: args[2],
          pattern: "Invoke",
          hwnd: 9001,
        }),
      );
    }
    if (args[1] === "set-value") {
      this.writtenValue = args[3] ?? "";
      return output(JSON.stringify({ elementId: args[2], hwnd: "0x2329" }));
    }
    if (args[1] === "wait-for") {
      return output(
        JSON.stringify({
          found: args.includes(this.writtenValue),
          timedOut: false,
          waitedMs: 100,
        }),
      );
    }
    if (args[1] === "screenshot") {
      const outputIndex = args.indexOf("--output");
      const artifactPath = args[outputIndex + 1]!;
      await writeFile(artifactPath, "fixture", "utf8");
      return output(
        JSON.stringify({
          filePath: this.screenshotPath?.(artifactPath) ?? artifactPath,
          width: 1280,
          height: 720,
          processId: 4242,
          windowTitle: "Fixture Window",
          hwnd: "0x2329",
        }),
      );
    }
    throw new Error(`Unexpected fixture command: ${args.join(" ")}`);
  }
}

function fixtureWindow() {
  return {
    hwnd: "0x2329",
    processId: 4242,
    processName: "FixtureApp",
    title: "Fixture Window",
    width: 1280,
    height: 720,
  };
}

function fixtureCliSchema(version: string) {
  return {
    name: "winapp",
    version,
    schemaVersion: "1.0",
    subcommands: {
      ui: {
        subcommands: Object.fromEntries(
          [
            "inspect",
            "invoke",
            "list-windows",
            "screenshot",
            "set-value",
            "wait-for",
          ].map((name) => [name, { description: name }]),
        ),
      },
    },
  };
}

function fixtureInspection(buttonX = 10, secureField = false, crowded = false) {
  return {
    depth: 8,
    interactive: false,
    hideDisabled: true,
    hideOffscreen: true,
    windows: [
      {
        hwnd: "0x2329",
        title: "Fixture Window",
        elementCount: 3,
        elements: [
          ...(crowded
            ? Array.from({ length: 32 }, (_, index) => ({
                type: "Text",
                name: `Text ${index}`,
                selector: `label-${index}`,
                isEnabled: true,
              }))
            : []),
          {
            type: "Button",
            name: "Save",
            automationId: "SaveButton",
            selector: "provider-button-selector",
            isEnabled: true,
            isOffscreen: false,
            isInvokable: true,
            x: buttonX,
            y: 10,
            width: 80,
            height: 30,
          },
          {
            type: secureField ? "PasswordBox" : "TextBox",
            name: secureField ? "Password" : "Notes",
            automationId: secureField ? "PasswordField" : "NotesField",
            selector: "provider-field-selector",
            value: "existing private value",
            isEnabled: true,
            isOffscreen: false,
            x: 10,
            y: 50,
            width: 200,
            height: 30,
          },
          {
            type: "PasswordBox",
            name: "Password",
            automationId: "PasswordField",
            selector: "provider-password-selector",
            value: "never-project-this",
            isEnabled: true,
            isOffscreen: false,
            x: 10,
            y: 90,
            width: 200,
            height: 30,
          },
        ],
      },
    ],
  };
}

function output(stdout: string): WinAppCliRunResult {
  return { stdout, stderr: "" };
}

function invocation(arguments_: Record<string, unknown>) {
  return {
    callId: "call-1",
    name: "test",
    arguments: arguments_,
    cwd: "C:\\workspace",
    signal: new AbortController().signal,
  };
}

test("Windows inspection retains actionable controls after static UIA nodes", async () => {
  const runner = new FixtureWinAppRunner();
  runner.crowded = true;
  const backend = new WinAppCliComputerBackend({ platform: "win32", runner });
  try {
    const inspection = await backend.inspect(target);
    const button = inspection.controls.find(({ title }) => title === "Save");
    assert.ok(button, "button after static UIA nodes must remain actionable");
    assert.equal(inspection.controls.length, 32);
    assert.equal(inspection.truncated, true);
    assert.ok(inspection.controls.some(({ title }) => title === "Text 0"));
    await backend.press(target, button.selector);
    assert.ok(runner.commands.some((args) => args[1] === "invoke"));
  } finally {
    await backend.close();
  }
});
