import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ToolInvocation } from "../../../../src/tool.js";
import {
  ComputerZenXCapabilityPackage,
  type ComputerInspection,
  type ComputerWindowList,
} from "./capabilities/computer-provider.js";
import {
  windowsComputerCapabilityManifest,
  runBoundedProcess,
  SpawnWinAppCliRunner,
  WinAppCliComputerBackend,
} from "./capabilities/windows-computer-provider.js";

import {
  WINDOWS_BACKGROUND_CAPTURE_SCRIPT,
  windowsBackgroundCaptureCommand,
} from "./capabilities/windows-background-capture.js";

const arguments_ = parseArguments(process.argv.slice(2));
const probeDirectory = requiredString(
  arguments_["probe-directory"],
  "--probe-directory",
);
const expectedTarget = {
  pid: requiredPositiveInteger(arguments_.pid, "--pid"),
  windowTitle: requiredString(arguments_.title, "--title"),
};
const controller = new AbortController();
const timeout = setTimeout(() => {
  controller.abort(
    new DOMException("Windows adapter smoke timed out", "AbortError"),
  );
}, 120_000);
timeout.unref();

const winAppRunner = new SpawnWinAppCliRunner();
let traceSetValue = false;
let setValueWindowLists = 0;
const backend = new WinAppCliComputerBackend({
  platform: "win32",
  runner: {
    async run(executable, args, options) {
      if (traceSetValue) {
        // Fixed diagnostic labels only; never record selectors, values or titles.
        const command = args[1];
        const phase =
          command === "list-windows"
            ? ++setValueWindowLists === 1
              ? "uia-resolve"
              : "uia-refresh"
            : command === "inspect"
              ? "uia-revalidate"
              : command === "set-value"
                ? "uia-set-value"
                : command === "wait-for"
                  ? "uia-wait-for"
                  : "uia-other";
        await stage(phase);
      }
      return await winAppRunner.run(executable, args, options);
    },
  },
});
const computer = new ComputerZenXCapabilityPackage(
  backend,
  windowsComputerCapabilityManifest,
);

try {
  await stage("foreground-refusal");
  await assert.rejects(
    execute(
      computer,
      "computer_foreground_key_press",
      { key: "enter" },
      controller.signal,
    ),
    /enable Foreground computer control/u,
    "The smoke must retain the default foreground-control refusal",
  );
  await stage("diagnose");
  const diagnostic = await backend.diagnose(controller.signal);
  if (!diagnostic.ready) throw new Error(diagnostic.message);

  await stage("discover");
  const discovered = await execute<ComputerWindowList>(
    computer,
    "computer_list_windows",
    { query: expectedTarget.windowTitle },
    controller.signal,
  );
  const fixtureWindows = discovered.windows.filter(
    ({ target }) =>
      target.pid === expectedTarget.pid &&
      target.windowTitle === expectedTarget.windowTitle,
  );
  if (discovered.truncated || fixtureWindows.length !== 1) {
    const sameProcess = await backend.listWindows(
      String(expectedTarget.pid),
      controller.signal,
    );
    throw new Error(
      "ZenX discovery did not uniquely identify the fixture window: " +
        JSON.stringify({
          expected: expectedTarget,
          candidates: sameProcess.windows
            .filter(({ target }) => target.pid === expectedTarget.pid)
            .map(({ target }) => target),
        }),
    );
  }
  const target = fixtureWindows[0]!.target;

  await stage("inspect");
  const first = await execute<ComputerInspection>(
    computer,
    "computer_inspect",
    { target },
    controller.signal,
  );
  const editor = first.controls.find(
    (control) => control.enabled && control.actions.includes("set_value"),
  );
  if (editor === undefined) {
    throw new Error("ZenX adapter found no editable fixture control");
  }

  const probeText = `ZenX WinApp 中文 😀 "quoted" \\ ${new Date().toISOString()}`;
  await assert.rejects(
    execute(
      computer,
      "computer_set_value",
      { target, control: editor.selector, value: probeText },
      controller.signal,
    ),
    /foreground_required.*enable Foreground computer control/u,
    "Default strict mode must refuse before invoking WinApp or consuming the observation",
  );
  // Explicit authorization belongs only to this disposable smoke fixture.
  // Product settings are never modified or auto-enabled by this test.
  computer.setForegroundControlAllowed(true);
  await stage("set-value");
  traceSetValue = true;
  const setResult = await execute<{
    target: ComputerInspection["target"];
    characterCount: number;
  }>(
    computer,
    "computer_set_value",
    { target, control: editor.selector, value: probeText },
    controller.signal,
  ).finally(() => {
    traceSetValue = false;
  });
  computer.setForegroundControlAllowed(false);
  if (setResult.characterCount !== probeText.length) {
    throw new Error(
      "ZenX adapter did not confirm the complete set-value input",
    );
  }
  const refreshedTarget = {
    pid: setResult.target.pid,
    applicationId: setResult.target.applicationId,
    windowTitle: setResult.target.windowTitle,
  };

  await stage("reinspect");
  const second = await execute<ComputerInspection>(
    computer,
    "computer_inspect",
    { target: refreshedTarget },
    controller.signal,
  );
  if (second.controls.length === 0) {
    throw new Error(
      "ZenX adapter could not re-inspect the fixture after set-value",
    );
  }

  // Preserve the semantic-operation focus evidence first. The following guard
  // activation is explicit fixture setup, before any screenshot is attempted.
  await writeFile(path.join(probeDirectory, "uia-stop"), "stop");
  await waitForFixture(
    path.join(probeDirectory, "uia-result.json"),
    controller.signal,
  );
  console.log(
    "UIA targeting epoch ended; focus isolation is not certified: " +
      (await readFile(path.join(probeDirectory, "uia-result.json"), "utf8")),
  );
  // Direct CUIAutomation8 isolates client AutoSetFocus from WinApp's wrapper.
  // These are fixture-only experiments, not a production background fallback.
  const fixture = JSON.parse(
    (
      await readFile(path.join(probeDirectory, "semantic-fixture.json"), "utf8")
    ).replace(/^\uFEFF/u, ""),
  );
  let invokeCount = 0;
  for (const action of ["set-value", "invoke"] as const) {
    for (const suppressAutoFocus of [false, true]) {
      const epoch = `direct-${suppressAutoFocus ? "no-focus" : "default"}-${action === "set-value" ? "value" : "invoke"}`;
      await stage("semantic-setup");
      await writeFile(path.join(probeDirectory, "semantic-setup"), epoch);
      await waitForFixture(
        path.join(probeDirectory, `${epoch}-ready`),
        controller.signal,
      );
      const result = await runBoundedProcess(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-MTA",
          "-File",
          path.resolve("scripts/windows-semantic-focus-probe.ps1"),
        ],
        {
          timeoutMs: 15_000,
          signal: controller.signal,
          stdin: JSON.stringify({
            fixture,
            action,
            suppressAutoFocus,
            value: `${probeText} ${epoch}`,
            phasePath: path.join(probeDirectory, "phase"),
          }),
        },
      );
      const { observation: report, rejections } = JSON.parse(
        result.stdout.replace(/^\uFEFF/u, ""),
      );
      if (suppressAutoFocus && action === "set-value") {
        assert.deepEqual(rejections, [
          "wrong-process",
          "same-pid-sibling",
          "stale-hwnd",
          "unsupported-pattern",
        ]);
      }
      assert.equal(
        report.defaultAutoSetFocus,
        true,
        "record the default instead of assuming it",
      );
      assert.equal(report.configuredAutoSetFocus, !suppressAutoFocus);
      assert.equal(report.guardUnchanged, true);
      if (action === "set-value") assert.equal(report.completeValue, true);
      else {
        invokeCount++;
        const deadline = Date.now() + 3000;
        while (
          Number(
            await readFile(path.join(probeDirectory, "invoke-count"), "utf8"),
          ) !== invokeCount &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal(
          Number(
            await readFile(path.join(probeDirectory, "invoke-count"), "utf8"),
          ),
          invokeCount,
          "Invoke must have its native fixture effect",
        );
      }
      // Include post-call time, not just the synchronous return boundary.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await writeFile(path.join(probeDirectory, `${epoch}-stop`), "stop");
      await waitForFixture(
        path.join(probeDirectory, `${epoch}-result.json`),
        controller.signal,
      );
      const metrics = JSON.parse(
        await readFile(
          path.join(probeDirectory, `${epoch}-result.json`),
          "utf8",
        ),
      );
      assert.ok(metrics.samples >= 2);
      assert.equal(metrics.foregroundTransitions[0]?.foreground, "guard");
      assert.equal(metrics.pointerChanges, 0);
      assert.equal(metrics.restored, 0);
      console.log(
        `Direct UIA ${epoch}: ` +
          JSON.stringify({ ...report, rejections, metrics }),
      );
      // A zero-focus result proves only this fixture/provider combination.
      // Record contrary evidence rather than restoring the old foreground.
    }
  }

  await stage("capture-setup");
  await writeFile(path.join(probeDirectory, "capture-setup"), "setup");
  await waitForFixture(
    path.join(probeDirectory, "capture-ready"),
    controller.signal,
  );

  await stage("capture-valid");
  const screenshot = await execute<{
    artifactPath: string;
    bytes: number;
    width: number;
    height: number;
  }>(
    computer,
    "computer_screenshot",
    { target: refreshedTarget },
    controller.signal,
  );
  const metadata = await stat(screenshot.artifactPath);
  if (
    metadata.size <= 0 ||
    screenshot.bytes !== metadata.size ||
    screenshot.width <= 0 ||
    screenshot.height <= 0
  ) {
    throw new Error("ZenX adapter returned an invalid screenshot artifact");
  }

  // Decode the real PNG and find a distinctive fixture-only marker fully behind
  // the foreground guard. File existence alone does not prove target pixels.
  const verifyPixels = String.raw`[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -ReferencedAssemblies System.Drawing,System -TypeDefinition @'
using System; using System.Drawing;
public static class ZenXMarkerCheck {
  public static string Count(string path) {
    using (var bitmap = new Bitmap(path)) {
      int count=0, magenta=0;
      for (int y=0; y<bitmap.Height; y++) for (int x=0; x<bitmap.Width; x++) {
        var pixel=bitmap.GetPixel(x,y);
        if (pixel.R==25 && pixel.G==90 && pixel.B==210) count++;
        if (pixel.R==255 && pixel.G==0 && pixel.B==255) magenta++;
      }
      return count + "," + magenta;
    }
  }
}
'@
[Console]::Out.WriteLine([ZenXMarkerCheck]::Count([Console]::In.ReadToEnd()))`;
  const countFixturePixels = async (artifactPath: string) => {
    const verifiedPixels = await runBoundedProcess(
      windowsBackgroundCaptureCommand().executable,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(verifyPixels, "utf16le").toString("base64"),
      ],
      {
        timeoutMs: 10_000,
        signal: controller.signal,
        stdin: artifactPath,
        maxStdoutBytes: 1024,
      },
    );
    return verifiedPixels.stdout.trim().split(",").map(Number);
  };
  await stage("verify-valid-pixels");
  const [bluePixels, magentaPixels] = await countFixturePixels(
    screenshot.artifactPath,
  );
  if (!(bluePixels! >= 500 && magentaPixels! >= 50))
    throw new Error(
      "Occluded screenshot is missing the target fixture's distinctive marker pixels",
    );

  await stage("enable-partial");
  await writeFile(path.join(probeDirectory, "unrendered"), "unrendered");
  await waitForFixture(
    path.join(probeDirectory, "unrendered-ready"),
    controller.signal,
  );
  await stage("capture-partial");
  const partialCapture = await execute<{ artifactPath: string }>(
    computer,
    "computer_screenshot",
    { target: refreshedTarget },
    controller.signal,
  ).then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const printProbe = JSON.parse(
    await readFile(
      path.join(probeDirectory, "partial-print-probe.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal(printProbe.enabled, true);
  assert.equal(printProbe.visible, true);
  assert.equal(printProbe.minimized, false);
  if (partialCapture.ok) {
    // PW_RENDERFULLCONTENT may return the complete redirected surface without
    // dispatching WM_PRINT. That is a valid frame, not an unpainted counterexample.
    assert.equal(printProbe.printCalls, 0);
    assert.equal(printProbe.printClientCalls, 0);
    await stage("verify-partial-pixels");
    const pixels = await countFixturePixels(partialCapture.result.artifactPath);
    assert.deepEqual(pixels, [2000, 625]);
    console.log(
      "Native PrintWindow bypassed partial callbacks and preserved complete fixture markers: " +
        JSON.stringify({ ...printProbe, pixels }),
    );
  } else {
    assert.match(String(partialCapture.error), /capture_unrendered/u);
    console.log(
      "Native partial-frame capture was rejected: " +
        JSON.stringify(printProbe),
    );
  }
  // Always exercise the actual native production classifier; the compositor
  // behavior above must not skip its unpainted-buffer counterexamples.
  await stage("native-classifier");
  await verifyNativeSentinelClassification(controller.signal);
  await stage("minimize-fixture");
  await writeFile(path.join(probeDirectory, "minimize"), "minimize");
  await waitForFixture(
    path.join(probeDirectory, "minimized"),
    controller.signal,
  );
  await stage("capture-minimized");
  try {
    await execute(
      computer,
      "computer_screenshot",
      { target: refreshedTarget },
      controller.signal,
    );
    throw new Error("Minimized capture unexpectedly succeeded");
  } catch (error) {
    if (!String(error).includes("capture_minimized")) throw error;
  }
  console.log(
    `WinApp CLI ${diagnostic.version} targeting checks completed separately. Screenshot content, native print behavior, production bitmap classifier and minimized-refusal checks completed; the independent capture epoch still requires the outer zero-focus/pointer-change assertion.`,
  );
} finally {
  clearTimeout(timeout);
  try {
    await stage("cleanup");
  } finally {
    await computer.close?.();
  }
}

async function stage(phase: string): Promise<void> {
  await writeFile(path.join(probeDirectory, "phase"), phase);
}

async function verifyNativeSentinelClassification(
  signal: AbortSignal,
): Promise<void> {
  const declarationsEnd =
    WINDOWS_BACKGROUND_CAPTURE_SCRIPT.indexOf("\n$request =");
  assert.ok(
    declarationsEnd > 0,
    "Native helper declarations must be available",
  );
  // Compile the exact production declarations, then invoke the same private
  // classifier against real System.Drawing buffers. Do not replace PrintWindow.
  const script =
    WINDOWS_BACKGROUND_CAPTURE_SCRIPT.slice(0, declarationsEnd) +
    String.raw`
$method = [ZenXBackgroundCapture].GetMethod('ConfirmSentinelPixels', [Reflection.BindingFlags]'NonPublic,Static')
if ($null -eq $method) { throw 'Production sentinel validation method missing' }
$a = New-Object System.Drawing.Bitmap(4,4)
$b = New-Object System.Drawing.Bitmap(4,4)
function Fill($bitmap, $color) {
  $g = [Drawing.Graphics]::FromImage($bitmap)
  try { $g.Clear($color) } finally { $g.Dispose() }
}
function Check([bool]$expectRejection) {
  $rejected = $false
  try { [void]$method.Invoke($null, [object[]]@($a.PSObject.BaseObject,$b.PSObject.BaseObject,0,0,4,4)) }
  catch { if ($_.Exception.ToString() -notmatch 'capture_unrendered') { throw }; $rejected = $true }
  if ($rejected -ne $expectRejection) { throw 'Production sentinel validation returned an unexpected result' }
}
try {
  Fill $a ([Drawing.Color]::Magenta); Fill $b ([Drawing.Color]::Cyan)
  $a.SetPixel(0,0,[Drawing.Color]::White); $b.SetPixel(0,0,[Drawing.Color]::White)
  Check $true
  Fill $a ([Drawing.Color]::White); Fill $b ([Drawing.Color]::White)
  $a.SetPixel(2,2,[Drawing.Color]::Magenta); $b.SetPixel(2,2,[Drawing.Color]::Magenta)
  $b.SetPixel(1,1,[Drawing.Color]::Blue)
  Check $false
  $b.SetPixel(2,2,[Drawing.Color]::Green)
  Check $true
  [Console]::Out.WriteLine('production-sentinel-checks-passed')
} finally { $a.Dispose(); $b.Dispose() }
} catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
`;
  const result = await runBoundedProcess(
    windowsBackgroundCaptureCommand().executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { timeoutMs: 10_000, signal, maxStdoutBytes: 1024 },
  );
  assert.equal(result.stdout.trim(), "production-sentinel-checks-passed");
  console.log(
    "Native production bitmap classifier passed all three synthetic cases",
  );
}

async function waitForFixture(
  marker: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    signal.throwIfAborted();
    try {
      await access(marker);
      return;
    } catch {
      if (Date.now() > deadline)
        throw new Error("Fixture state transition timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function execute<T>(
  capabilityPackage: ComputerZenXCapabilityPackage,
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
  return (await capabilityPackage.invoke(name, invocation)) as T;
}

function parseArguments(values: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined) {
      throw new Error("Expected --pid <number> --title <exact-title>");
    }
    result[key.slice(2)] = value;
  }
  return result;
}

function requiredString(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${flag} is required`);
  }
  return value;
}

function requiredPositiveInteger(
  value: string | undefined,
  flag: string,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}
