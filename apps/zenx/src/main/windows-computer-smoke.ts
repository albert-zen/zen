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

import { windowsBackgroundCaptureCommand } from "./capabilities/windows-background-capture.js";

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
  await assert.rejects(
    async () => {
      try {
        const partial = await execute<{ artifactPath: string }>(
          computer,
          "computer_screenshot",
          { target: refreshedTarget },
          controller.signal,
        );
        console.log(
          "Synthetic partial-frame capture returned: " +
            JSON.stringify({
              pixels: await countFixturePixels(partial.artifactPath),
            }),
        );
      } finally {
        console.log(
          "Synthetic partial-print fixture probe: " +
            (await readFile(
              path.join(probeDirectory, "partial-print-probe.json"),
              "utf8",
            )),
        );
      }
    },
    /capture_unrendered/u,
    "Partially painted native frames must fail without foreground fallback",
  );
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
    `ZenX WinApp adapter smoke passed with WinApp CLI ${diagnostic.version}: list_windows -> exact target -> inspect -> opaque observation -> set_value with bounded UIA assertion -> re-inspect -> strict background screenshot with legitimate magenta while occluded -> partially painted frame rejected -> minimized capture rejected without restore.`,
  );
} finally {
  clearTimeout(timeout);
  await computer.close?.();
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
