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
  WinAppCliComputerBackend,
} from "./capabilities/windows-computer-provider.js";

import {
  WINDOWS_BACKGROUND_CAPTURE_SCRIPT,
  windowsBackgroundCaptureCommand,
} from "./capabilities/windows-background-capture.js";

const arguments_ = parseArguments(process.argv.slice(2));
const expectedTarget = {
  pid: requiredPositiveInteger(arguments_.pid, "--pid"),
  windowTitle: requiredString(arguments_.title, "--title"),
};
const controller = new AbortController();
const timeout = setTimeout(() => {
  controller.abort(
    new DOMException("Windows adapter smoke timed out", "AbortError"),
  );
}, 60_000);
timeout.unref();

const backend = new WinAppCliComputerBackend({ platform: "win32" });
const computer = new ComputerZenXCapabilityPackage(
  backend,
  windowsComputerCapabilityManifest,
);

try {
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
  const diagnostic = await backend.diagnose(controller.signal);
  if (!diagnostic.ready) throw new Error(diagnostic.message);

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

  const probeText = `ZenX WinApp adapter smoke ${new Date().toISOString()}`;
  const setResult = await execute<{
    target: ComputerInspection["target"];
    characterCount: number;
  }>(
    computer,
    "computer_set_value",
    { target, control: editor.selector, value: probeText },
    controller.signal,
  );
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
  const [bluePixels, magentaPixels] = await countFixturePixels(
    screenshot.artifactPath,
  );
  if (!(bluePixels! >= 500 && magentaPixels! >= 50))
    throw new Error(
      "Occluded screenshot is missing the target fixture's distinctive marker pixels",
    );

  const probeDirectory = requiredString(
    arguments_["probe-directory"],
    "--probe-directory",
  );
  await writeFile(path.join(probeDirectory, "unrendered"), "unrendered");
  await waitForFixture(
    path.join(probeDirectory, "unrendered-ready"),
    controller.signal,
  );
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
  await verifyNativeSentinelClassification(controller.signal);
  await writeFile(path.join(probeDirectory, "minimize"), "minimize");
  await waitForFixture(
    path.join(probeDirectory, "minimized"),
    controller.signal,
  );
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
    `ZenX WinApp adapter smoke passed with WinApp CLI ${diagnostic.version}: list_windows -> exact target -> inspect -> opaque observation -> set_value with bounded UIA assertion -> re-inspect -> strict background screenshot with legitimate magenta while occluded -> native print callback behavior and production bitmap classifier verified -> minimized capture rejected without restore.`,
  );
} finally {
  clearTimeout(timeout);
  await computer.close?.();
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
