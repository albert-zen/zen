import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ComputerZenXCapabilityPackage,
  type ComputerInspection,
} from "../src/main/capabilities/computer-provider.js";
import {
  runBoundedProcess,
  windowsComputerCapabilityManifest,
  WinAppCliComputerBackend,
  type WinAppCliRunner,
  type WinAppCliRunOptions,
  type WinAppCliRunResult,
} from "../src/main/capabilities/windows-computer-provider.js";

const target = {
  pid: 4242,
  applicationId: "FixtureApp",
  windowTitle: "Fixture Window",
};

test("Windows provider maps WinApp JSON into opaque bounded UIA controls", async () => {
  const runner = new FixtureWinAppRunner();
  const backend = new WinAppCliComputerBackend({
    platform: "win32",
    runner,
  });
  const capability = new ComputerZenXCapabilityPackage(
    backend,
    windowsComputerCapabilityManifest,
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
  assert.equal(inspected.controls[2]?.secure, true);
  assert.deepEqual(inspected.controls[2]?.actions, []);
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

test("Windows provider captures only the exact HWND through WGC-default screenshot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-winapp-test-"));
  try {
    const runner = new FixtureWinAppRunner();
    const backend = new WinAppCliComputerBackend({
      artifactDirectory: directory,
      platform: "win32",
      runner,
    });
    const result = await backend.screenshot(target);
    assert.equal(result.target.windowTitle, "Fixture Window");
    assert.equal(result.width, 1280);
    assert.equal(result.height, 720);
    assert.equal(result.bytes, 7);
    const screenshotCommand = runner.commands.at(-1)!;
    assert.deepEqual(screenshotCommand.slice(0, 5), [
      "ui",
      "screenshot",
      "--window",
      "9001",
      "--output",
    ]);
    assert.equal(screenshotCommand.includes("--capture-screen"), false);
    assert.equal(screenshotCommand.includes("--focus"), false);
    await backend.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows provider rejects ambiguous windows, stale selectors, and secure controls", async () => {
  const runner = new FixtureWinAppRunner();
  const backend = new WinAppCliComputerBackend({
    platform: "win32",
    runner,
  });
  const inspected = await backend.inspect(target);
  const secure = inspected.controls.find((control) => control.secure)!;
  await assert.rejects(
    backend.setValue(target, secure.selector, "must-not-run"),
    /rejects password or secure controls/u,
  );
  assert.equal(
    runner.commands.some((args) => args.includes("must-not-run")),
    false,
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
    /rejects password or secure controls/u,
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

test("Windows manifest exposes background-safe WinApp operations without unscoped input injection", () => {
  assert.equal(
    windowsComputerCapabilityManifest.provider.id,
    "microsoft-winapp-cli",
  );
  assert.deepEqual(windowsComputerCapabilityManifest.provider.platforms, [
    "win32",
  ]);
  assert.equal(
    windowsComputerCapabilityManifest.tools.every(
      (tool) => tool.interactionMode === "background_safe",
    ),
    true,
  );
  assert.equal(
    windowsComputerCapabilityManifest.tools.some((tool) =>
      tool.name.startsWith("computer_foreground_"),
    ),
    false,
  );
});

test("WinApp diagnostic is actionable without installing on non-Windows test hosts", async () => {
  const ready = await new WinAppCliComputerBackend({
    platform: "win32",
    command: "fixture-winapp",
    runner: new FixtureWinAppRunner(),
  }).diagnose();
  assert.equal(ready.ready, true);
  assert.equal(ready.version, "1.2.3-preview");

  const unavailable = await new WinAppCliComputerBackend({
    platform: "darwin",
  }).diagnose();
  assert.equal(unavailable.ready, false);
  assert.match(unavailable.message, /only available on Windows/u);
  assert.match(unavailable.installCommand, /winget install/u);
});

test("WinApp process runner enforces cancellation, timeout, and output bounds", async () => {
  const controller = new AbortController();
  const cancelled = runBoundedProcess(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { timeoutMs: 5_000, signal: controller.signal },
  );
  controller.abort(new DOMException("stopped", "AbortError"));
  await assert.rejects(cancelled, /stopped/u);

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

class FixtureWinAppRunner implements WinAppCliRunner {
  readonly commands: string[][] = [];
  ambiguous = false;
  buttonX = 10;
  secureField = false;

  async run(
    _executable: string,
    args: readonly string[],
    _options: WinAppCliRunOptions,
  ): Promise<WinAppCliRunResult> {
    this.commands.push([...args]);
    if (args[0] === "--version") {
      return output("1.2.3-preview\n");
    }
    if (args[1] === "list-windows") {
      const windows = [fixtureWindow()];
      if (this.ambiguous) windows.push(fixtureWindow());
      return output(JSON.stringify(windows));
    }
    if (args[1] === "inspect") {
      return output(
        JSON.stringify(fixtureInspection(this.buttonX, this.secureField)),
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
      return output(JSON.stringify({ elementId: args[2], hwnd: 9001 }));
    }
    if (args[1] === "screenshot") {
      const outputIndex = args.indexOf("--output");
      const artifactPath = args[outputIndex + 1]!;
      await writeFile(artifactPath, "fixture", "utf8");
      return output(
        JSON.stringify({
          filePath: artifactPath,
          width: 1280,
          height: 720,
          processId: 4242,
          windowTitle: "Fixture Window",
          hwnd: 9001,
        }),
      );
    }
    throw new Error(`Unexpected fixture command: ${args.join(" ")}`);
  }
}

function fixtureWindow() {
  return {
    hwnd: 9001,
    processId: 4242,
    processName: "FixtureApp",
    title: "Fixture Window",
    width: 1280,
    height: 720,
  };
}

function fixtureInspection(buttonX = 10, secureField = false) {
  return {
    depth: 8,
    interactive: false,
    hideDisabled: true,
    hideOffscreen: true,
    windows: [
      {
        hwnd: 9001,
        title: "Fixture Window",
        elementCount: 3,
        elements: [
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
