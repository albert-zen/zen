import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { app } from "electron";
import type { ToolInvocation } from "../../../../src/tool.js";
import {
  ComputerZenXCapabilityPackage,
  type ComputerInspection,
  type ComputerWindowList,
} from "./capabilities/computer-provider.js";
import { selectComputerProvider } from "./capabilities/provider-catalog.js";
import {
  SpawnWinAppCliRunner,
  type WinAppCliRunOptions,
  type WinAppCliRunner,
} from "./capabilities/windows-computer-provider.js";
import { waitForFile, waitForText } from "./windows-packaged-uia-files.js";
import { WINDOWS_PACKAGED_UIA_FIXTURE } from "./windows-packaged-uia-fixture.js";
import {
  assertWindowsPackagedUiaFocusEvidence,
  type WindowsPackagedUiaFocusEvidence,
} from "./windows-packaged-uia-evidence.js";

interface NativeControl {
  hwnd: string;
  runtimeId: number[];
  name: string;
  invokePattern: boolean;
  valuePattern: boolean;
  [key: string]: unknown;
}
interface NativeReceipt {
  schemaVersion: number;
  contractVersion: number;
  autoSetFocus: boolean | null;
  operation: string | null;
  outcome: string;
  error: string | null;
  root: Record<string, unknown>;
  controls: NativeControl[];
  value?: string;
}
interface NativeLaunch {
  executable: string;
  args: readonly string[];
  options: WinAppCliRunOptions;
}
interface FixtureProcess {
  child: ChildProcess;
  closed: Promise<void>;
  diagnostic(): string;
  assertRunning(): void;
}

/** This runs inside the packaged Electron process, never an unpackaged substitute. */
export async function verifyWindowsPackagedUiaSmoke(options: {
  userDataDirectory: string;
  resourcesDirectory: string;
  bundledManifestSha256: string;
}): Promise<Record<string, unknown>> {
  assert.equal(process.platform, "win32");
  assert.equal(app.isPackaged, true);
  assert.equal(options.resourcesDirectory, process.resourcesPath);
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-packaged-uia-"));
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Packaged UIA fixture timed out")),
    120_000,
  );
  const signal = controller.signal;
  const fixtures: FixtureProcess[] = [];
  const runner = new SpawnWinAppCliRunner();
  let nativeLaunch: NativeLaunch | undefined;
  let nativeInspection: NativeReceipt | undefined;
  let nativeSetValue: NativeReceipt | undefined;
  let spawnCount = 0;
  let lastPid: number | undefined;
  let closedLaunches = 0;
  // The trace delegates every byte and launch option to the production transport.
  // It cannot manufacture availability, UIA receipts, or cancellation evidence.
  const trace: WinAppCliRunner = {
    async run(executable, args, launchOptions) {
      if (args.includes("--zenx-uia-strict"))
        nativeLaunch = { executable, args, options: launchOptions };
      let spawned = false;
      try {
        const result = await runner.run(executable, args, {
          ...launchOptions,
          onSpawn(pid: number) {
            launchOptions.onSpawn?.(pid);
            spawned = true;
            spawnCount++;
            lastPid = pid;
          },
        });
        if (args.includes("--zenx-uia-strict")) {
          const receipt = JSON.parse(result.stdout) as NativeReceipt;
          if (
            receipt.operation === "inspect" &&
            receipt.outcome === "completed"
          )
            nativeInspection = receipt;
          if (
            receipt.operation === "set_value" &&
            receipt.outcome === "completed"
          )
            nativeSetValue = receipt;
        }
        return result;
      } finally {
        // Production runBoundedProcess settles only after ChildProcess 'close',
        // including stdout/stderr pipes, and after releasing the asset binding.
        if (spawned) closedLaunches++;
      }
    },
  };
  let computer: ComputerZenXCapabilityPackage | undefined;
  try {
    const selection = await selectComputerProvider({
      ...options,
      platform: "win32",
      bundledProvidersOnly: true,
      winAppRunner: trace,
    });
    const diagnostic = selection.diagnostics.find(
      ({ providerId, status }) =>
        providerId === "zenx-winapp-uia" && status === "selected",
    );
    assert.ok(
      selection.backend,
      `Packaged strict UIA unavailable: ${JSON.stringify(selection.diagnostics)}`,
    );
    assert.equal(selection.manifest.provider?.id, "zenx-winapp-uia");
    assert.equal(diagnostic?.version, "0.3.1-zenx.af0.2");
    assert.equal(diagnostic?.integrity, "verified");
    assert.ok(diagnostic);
    assert.ok(diagnostic.executable);
    const packagedRelativePath = path.relative(
      process.resourcesPath,
      diagnostic.executable,
    );
    assert.ok(
      packagedRelativePath.length > 0 &&
        !path.isAbsolute(packagedRelativePath) &&
        packagedRelativePath.split(path.sep)[0] !== "..",
    );
    for (const name of ["computer_press", "computer_set_value"]) {
      const tool = selection.manifest.tools.find(
        (candidate) => candidate.name === name,
      );
      assert.equal(tool?.interactionMode, "background_safe");
      assert.equal(
        tool?.permissions.includes("computer.foreground.control"),
        false,
      );
    }
    assert.equal(
      selection.manifest.permissions.some(
        (permission) => permission.id === "computer.foreground.control",
      ),
      false,
    );
    let overlayCalls = 0;
    computer = new ComputerZenXCapabilityPackage(
      selection.backend,
      selection.manifest,
      false,
      {
        async run() {
          overlayCalls++;
          throw new Error(
            "Strict semantic operation unexpectedly requested foreground overlay",
          );
        },
      },
    );
    const invoke = <T>(
      name: string,
      args: Record<string, unknown>,
      invocationSignal = signal,
    ) => execute<T>(computer!, name, args, invocationSignal);
    const script = path.join(directory, "fixture.ps1");
    await writeFile(script, WINDOWS_PACKAGED_UIA_FIXTURE, "utf8");
    const title = `ZenX packaged UIA ${randomUUID()}`;
    fixtures.push(
      startFixture(script, [
        "-Mode",
        "target",
        "-Directory",
        directory,
        "-Title",
        title,
      ]),
    );
    const target = await readFixture<{
      pid: number;
      hwnd: string;
      title: string;
      editorHwnd: string;
      messageLoopReady: boolean;
    }>(directory, "target.json", signal, fixtures);
    assert.equal(target.messageLoopReady, true);
    fixtures.push(
      startFixture(script, [
        "-Mode",
        "guard",
        "-Directory",
        directory,
        "-TargetPid",
        String(target.pid),
        "-TargetHwnd",
        target.hwnd,
      ]),
    );
    await writeFile(path.join(directory, "arm-guard"), "arm");
    const guard = await readFixture<{
      pid: number;
      hwnd: string;
      hookInstalled: boolean;
    }>(directory, "guard-ready.json", signal, fixtures);
    assert.notEqual(target.pid, guard.pid);
    assert.equal(guard.hookInstalled, true);

    const windows = await invoke<ComputerWindowList>("computer_list_windows", {
      query: title,
    });
    const matches = windows.windows.filter(
      ({ target: item }) =>
        item.pid === target.pid && item.windowTitle === title,
    );
    assert.equal(windows.truncated, false);
    assert.equal(
      matches.length,
      1,
      "packaged discovery must find exactly the native target",
    );
    const selectedTarget = matches[0]!.target;
    const first = await invoke<ComputerInspection>("computer_inspect", {
      target: selectedTarget,
    });
    const editor = findControl(first, "ZenX packaged editor", "set_value");
    const text =
      'ZenX packaged 中文 😀 "quoted" \\ backslash\n完整读取 ' + randomUUID();
    const setResult = await invoke<{ characterCount: number }>(
      "computer_set_value",
      { target: selectedTarget, control: editor.selector, value: text },
    );
    assert.equal(setResult.characterCount, text.length);
    assert.ok(
      nativeSetValue,
      "actual native set-value receipt was not observed",
    );
    assert.equal(nativeSetValue.autoSetFocus, false);
    assert.equal(
      nativeSetValue.value,
      text,
      "native ValuePattern readback must preserve the complete Unicode string",
    );
    await waitForText(directory, "editor-value", text, signal, fixtures);
    for (const exactValue of ["", text]) {
      const current = await invoke<ComputerInspection>("computer_inspect", {
        target: selectedTarget,
      });
      const currentEditor = findControl(
        current,
        "ZenX packaged editor",
        "set_value",
      );
      await invoke("computer_set_value", {
        target: selectedTarget,
        control: currentEditor.selector,
        value: exactValue,
      });
      assert.equal(
        nativeSetValue?.value,
        exactValue,
        "empty and full native readback are exact",
      );
      await waitForText(
        directory,
        "editor-value",
        exactValue,
        signal,
        fixtures,
      );
    }
    const second = await invoke<ComputerInspection>("computer_inspect", {
      target: selectedTarget,
    });
    assert.ok(
      nativeInspection,
      "actual native inspect receipt was not observed",
    );
    assert.equal(nativeInspection.autoSetFocus, false);
    const nativeSnapshot = structuredClone(nativeInspection);
    const anonymousVirtualControls = nativeSnapshot.controls.filter(
      (control) => control.hwnd === "0" && control.runtimeId.length === 0,
    );
    assert.ok(
      anonymousVirtualControls.length > 0,
      "native inspection must retain actual anonymous virtual structure rows",
    );
    const button = findControl(second, "ZenX packaged invoke", "press");
    await invoke("computer_press", {
      target: selectedTarget,
      control: button.selector,
    });
    await waitForText(directory, "invoke-count", "1", signal, fixtures);
    assert.equal(overlayCalls, 0);

    await writeFile(path.join(directory, "stop-guard"), "stop");
    const focus = await readFixture<WindowsPackagedUiaFocusEvidence>(
      directory,
      "guard-result.json",
      signal,
      fixtures,
    );
    assertWindowsPackagedUiaFocusEvidence(focus, {
      targetPid: target.pid,
      guardPid: guard.pid,
      guardHwnd: guard.hwnd,
    });
    console.log(
      "Packaged nonactivating Unicode + Invoke fixture",
      JSON.stringify({
        provider: diagnostic,
        unicodeReadback: true,
        anonymousVirtualControls: anonymousVirtualControls.length,
        invokeCount: 1,
        foregroundAllowed: false,
        overlayCalls,
        focus,
      }),
    );

    // Pre-cancelled work must never spawn, consume a selector, or mutate the target.
    const beforeCancellation = await invoke<ComputerInspection>(
      "computer_inspect",
      { target: selectedTarget },
    );
    const cancellableEditor = findControl(
      beforeCancellation,
      "ZenX packaged editor",
      "set_value",
    );
    const beforeSpawns = spawnCount;
    const alreadyAborted = new AbortController();
    alreadyAborted.abort(
      new DOMException("Fixture pre-spawn cancellation", "AbortError"),
    );
    await assert.rejects(
      invoke(
        "computer_set_value",
        {
          target: selectedTarget,
          control: cancellableEditor.selector,
          value: "must not be written",
        },
        alreadyAborted.signal,
      ),
      /Fixture pre-spawn cancellation/u,
    );
    assert.equal(spawnCount, beforeSpawns);
    assert.equal(
      await readFile(path.join(directory, "editor-value"), "utf8"),
      text,
    );

    // Block the actual target's WM_SETTEXT after native dispatch. Abort the real
    // packaged child, await its close, then release the target. No fake runner.
    await writeFile(path.join(directory, "block-value"), "block");
    const afterDispatch = new AbortController();
    const cancellation = invoke(
      "computer_set_value",
      {
        target: selectedTarget,
        control: cancellableEditor.selector,
        value: "cancelled-after-dispatch 中文 😀",
      },
      AbortSignal.any([signal, afterDispatch.signal]),
    );
    // Install a rejection observer before waiting on the native target marker.
    const cancellationOutcome = cancellation.then(
      () => ({ completed: true, error: "" }),
      (error: unknown) => ({ completed: false, error: String(error) }),
    );
    try {
      await waitForText(
        directory,
        "value-entered",
        "WM_SETTEXT",
        signal,
        fixtures,
      );
      const dispatchedPid = lastPid;
      assert.ok(
        dispatchedPid,
        "no actual dispatched native process was recorded",
      );
      afterDispatch.abort(
        new DOMException(
          "Fixture cancelled after native dispatch",
          "AbortError",
        ),
      );
      const result = await cancellationOutcome;
      assert.equal(
        result.completed,
        false,
        "cancellation must not report completed",
      );
      assert.match(
        result.error,
        /unknown/iu,
        "dispatched cancellation must have conservative unknown outcome",
      );
      assert.equal(
        closedLaunches,
        spawnCount,
        "transport must await child and pipe close",
      );
      assert.equal(
        isProcessAlive(dispatchedPid),
        false,
        "native child must actually exit before settlement",
      );
    } finally {
      afterDispatch.abort(new Error("Fixture cancellation cleanup"));
      await writeFile(path.join(directory, "release-value"), "release");
      await cancellationOutcome;
    }
    assert.equal(overlayCalls, 0);
    await assertMissing(directory, "value-block-timeout");

    assert.ok(nativeLaunch);
    const transport = nativeLaunch;
    const raw = async (
      request: Record<string, unknown>,
      invalidRequest = false,
    ): Promise<NativeReceipt> => {
      const result = await runner.run(transport.executable, transport.args, {
        ...transport.options,
        signal,
        stdin: JSON.stringify(request),
        onSpawn: undefined,
        onStopping: undefined,
      });
      const receipt = JSON.parse(result.stdout) as NativeReceipt;
      assert.equal(receipt.schemaVersion, 1);
      assert.equal(receipt.contractVersion, 1);
      if (invalidRequest) {
        // A malformed identity is rejected by parsing, before any UIA client exists.
        assert.equal(receipt.outcome, "not_dispatched");
        assert.equal(receipt.error, "bad_request");
        assert.equal(receipt.operation, null);
        assert.equal(receipt.autoSetFocus, null);
      } else {
        assert.equal(receipt.operation, request.operation);
        assert.equal(receipt.autoSetFocus, false);
      }
      return receipt;
    };
    const nativeEditor = nativeSnapshot.controls.find(
      (control) => control.hwnd === target.editorHwnd && control.valuePattern,
    );
    assert.ok(
      nativeEditor,
      "native inspection omitted the real HWND-backed editor",
    );
    const virtual = nativeSnapshot.controls.find(
      (control) =>
        control.hwnd === "0" && control.name === "ZenX virtual invoke",
    );
    assert.ok(
      virtual,
      "native fixture must expose a real HWND-less virtual control",
    );
    const virtualRefusal = await raw({
      schemaVersion: 1,
      operation: "invoke",
      root: nativeSnapshot.root,
      control: virtual,
    });
    assert.equal(virtualRefusal.outcome, "not_dispatched");
    await assertMissing(directory, "virtual-invoked");
    const anonymousRefusals: string[] = [];
    for (const operation of ["invoke", "set_value"]) {
      const refusal = await raw({
        schemaVersion: 1,
        operation,
        root: nativeSnapshot.root,
        control: anonymousVirtualControls[0],
        ...(operation === "set_value"
          ? { value: "anonymous must not write" }
          : {}),
      });
      assert.equal(refusal.outcome, "not_dispatched");
      assert.equal(refusal.error, "native_identity_required");
      anonymousRefusals.push(refusal.error);
    }
    let invalidIdentityRefusals = 0;
    for (const field of ["root", "control"] as const) {
      for (const runtimeId of [[], null, Array(65).fill(1), [1.5]]) {
        await raw(
          {
            schemaVersion: 1,
            operation: "invoke",
            root:
              field === "root"
                ? { ...nativeSnapshot.root, runtimeId }
                : nativeSnapshot.root,
            control:
              field === "control"
                ? { ...nativeEditor, runtimeId }
                : nativeEditor,
          },
          true,
        );
        invalidIdentityRefusals++;
      }
    }
    for (const runtimeId of [null, Array(65).fill(1), [1.5]]) {
      await raw(
        {
          schemaVersion: 1,
          operation: "invoke",
          root: nativeSnapshot.root,
          control: { ...anonymousVirtualControls[0], runtimeId },
        },
        true,
      );
      invalidIdentityRefusals++;
    }

    await writeFile(path.join(directory, "replace-editor"), "replace");
    const replaced = await readFixture<{ oldHwnd: string; hwnd: string }>(
      directory,
      "editor-replaced.json",
      signal,
      fixtures,
    );
    assert.notEqual(replaced.hwnd, replaced.oldHwnd);
    const staleRefusal = await raw({
      schemaVersion: 1,
      operation: "set_value",
      root: nativeSnapshot.root,
      control: nativeEditor,
      value: "stale must not write",
    });
    assert.equal(staleRefusal.outcome, "not_dispatched");
    assert.notEqual(
      await readFile(path.join(directory, "editor-value"), "utf8"),
      "stale must not write",
    );

    // Ambiguity is a target-resolution refusal. It is outside the focus epoch:
    // showing the second fixture root is explicit native fixture preparation.
    await writeFile(path.join(directory, "duplicate-root"), "duplicate");
    await readFixture(directory, "root-duplicated.json", signal, fixtures);
    await assert.rejects(
      invoke("computer_inspect", { target: selectedTarget }),
      /ambiguous|multiple|exactly one/iu,
    );
    return {
      provider: diagnostic,
      resourcesPath: process.resourcesPath,
      nativeFixture: "independent WinForms processes",
      foregroundAllowed: false,
      unicodeReadback: true,
      anonymousVirtualControls: anonymousVirtualControls.length,
      invokeCount: 1,
      overlayCalls,
      focus,
      preSpawnCancellation: "no launch, no effect",
      dispatchedCancellation: "unknown after real child and pipe close",
      nativeRefusals: {
        virtual: virtualRefusal.error,
        anonymousVirtual: anonymousRefusals,
        invalidIdentityRefusals,
        staleReplacement: staleRefusal.error,
        ambiguousRoot: true,
      },
      scope:
        "Observed fixture epoch only; target-owned side effects and races prevent a global focus guarantee",
    };
  } finally {
    clearTimeout(timeout);
    controller.abort(new Error("Packaged UIA smoke cleanup"));
    await writeFile(path.join(directory, "release-value"), "release");
    await writeFile(path.join(directory, "quit"), "quit");
    await Promise.all(
      fixtures.map(async (fixture) => {
        const force = setTimeout(() => fixture.child.kill("SIGKILL"), 2_000);
        try {
          await fixture.closed;
        } finally {
          clearTimeout(force);
        }
      }),
    );
    await computer?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function findControl(
  inspection: ComputerInspection,
  title: string,
  action: "set_value" | "press",
) {
  assert.equal(inspection.truncated, false);
  const controls = inspection.controls.filter(
    (control) =>
      control.title === title &&
      control.enabled &&
      control.actions.includes(action),
  );
  assert.equal(
    controls.length,
    1,
    `Expected exactly one native ${title} supporting ${action}`,
  );
  return controls[0]!;
}

function startFixture(script: string, args: string[]): FixtureProcess {
  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      ...args,
    ],
    { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let ended = false;
  let diagnostic = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes: Buffer) => {
      diagnostic = (diagnostic + bytes.toString("utf8")).slice(-16_384);
    });
  child.on("error", (error) => {
    diagnostic += String(error);
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      ended = true;
      resolve();
    }),
  );
  return {
    child,
    closed,
    diagnostic: () => diagnostic,
    assertRunning() {
      assert.equal(ended, false, `Native fixture exited: ${diagnostic}`);
    },
  };
}

async function readFixture<T>(
  directory: string,
  name: string,
  signal: AbortSignal,
  fixtures: FixtureProcess[],
): Promise<T> {
  return JSON.parse(
    (await waitForFile(directory, name, signal, fixtures)).replace(
      /^\uFEFF/u,
      "",
    ),
  ) as T;
}
async function assertMissing(directory: string, name: string): Promise<void> {
  await assert.rejects(access(path.join(directory, name)), { code: "ENOENT" });
}
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
async function execute<T>(
  computer: ComputerZenXCapabilityPackage,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  const invocation: ToolInvocation = {
    callId: randomUUID(),
    name,
    arguments: args,
    cwd: process.cwd(),
    signal,
  };
  return (await computer.invoke(name, invocation)) as T;
}
