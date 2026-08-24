import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

import type { ToolInvocation } from "../../../../src/tool.js";
import {
  ComputerZenXCapabilityPackage,
  type ComputerInspection,
} from "./capabilities/computer-provider.js";
import {
  windowsComputerCapabilityManifest,
  WinAppCliComputerBackend,
} from "./capabilities/windows-computer-provider.js";

const arguments_ = parseArguments(process.argv.slice(2));
const target = {
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
  const diagnostic = await backend.diagnose(controller.signal);
  if (!diagnostic.ready) throw new Error(diagnostic.message);

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

  console.log(
    `ZenX WinApp adapter smoke passed with WinApp CLI ${diagnostic.version}: inspect -> opaque observation -> set_value with bounded UIA assertion -> re-inspect -> scoped screenshot.`,
  );
} finally {
  clearTimeout(timeout);
  await computer.close?.();
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
