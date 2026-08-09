import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

import type { ToolInvocation } from "../../../../src/tool.js";
import {
  ComputerZenXCapabilityPackage,
  type ComputerInspection,
} from "./capabilities/computer-provider.js";
import { ZenXCapabilityRegistry } from "./capabilities/registry.js";
import { MemoryZenXCapabilityGrantStore } from "./capabilities/grant-store.js";
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

const grantStore = new MemoryZenXCapabilityGrantStore();
const registry = new ZenXCapabilityRegistry(grantStore, {
  platform: "win32",
  allowForegroundRequired: false,
});
const backend = new WinAppCliComputerBackend({ platform: "win32" });

try {
  const diagnostic = await backend.diagnose(controller.signal);
  if (!diagnostic.ready) throw new Error(diagnostic.message);

  await registry.initialize();
  registry.register(
    new ComputerZenXCapabilityPackage(
      backend,
      windowsComputerCapabilityManifest,
    ),
    "bundled",
  );
  await registry.grant(windowsComputerCapabilityManifest.id);

  const first = await execute<ComputerInspection>(
    registry,
    "computer_inspect",
    { target },
    controller.signal,
  );
  const editor = first.controls.find(
    (control) =>
      control.enabled &&
      control.secure !== true &&
      control.actions.includes("set_value"),
  );
  if (editor === undefined) {
    throw new Error(
      "ZenX adapter found no non-secret editable fixture control",
    );
  }

  const probeText = `ZenX WinApp adapter smoke ${new Date().toISOString()}`;
  const setResult = await execute<{
    target: ComputerInspection["target"];
    characterCount: number;
  }>(
    registry,
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
    registry,
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
    registry,
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
  await registry.close();
}

async function execute<T>(
  registry_: ZenXCapabilityRegistry,
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
  const execution = await registry_.execute(invocation);
  if (execution.exitCode !== 0) {
    throw new Error(
      `${name} failed with exit code ${String(execution.exitCode)}`,
    );
  }
  const envelope = JSON.parse(execution.output) as {
    result?: T;
    truncated?: boolean;
  };
  if (envelope.truncated === true || envelope.result === undefined) {
    throw new Error(`${name} returned no complete result through the registry`);
  }
  return envelope.result;
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
