import path from "node:path";
import { mkdir } from "node:fs/promises";

import {
  browserCapabilityManifest,
  ElectronBrowserBackend,
  type ZenXBrowserBackend,
} from "./browser-provider.js";
import {
  computerCapabilityManifest,
  ElectronMacComputerBackend,
  type ZenXComputerBackend,
} from "./computer-provider.js";
import {
  discoverExecutable,
  type ExternalProviderProcessRunner,
  parseExternalJson,
  SystemExternalProviderProcessRunner,
} from "./external-provider.js";
import { PeekabooComputerBackend } from "./peekaboo-computer-provider.js";
import { PlaywrightCliBrowserBackend } from "./playwright-browser-provider.js";
import {
  windowsComputerCapabilityManifest,
  WinAppCliComputerBackend,
} from "./windows-computer-provider.js";
import type {
  ZenXCapabilityManifest,
  ZenXCapabilityProviderDiagnostic,
} from "./types.js";

export interface ZenXCapabilityProviderSelection<T> {
  backend: T;
  manifest: ZenXCapabilityManifest;
  diagnostics: ZenXCapabilityProviderDiagnostic[];
}

export interface ZenXOptionalCapabilityProviderSelection<T> {
  backend?: T;
  manifest: ZenXCapabilityManifest;
  diagnostics: ZenXCapabilityProviderDiagnostic[];
}

export interface ZenXCapabilityProviderCatalogOptions {
  userDataDirectory: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runner?: ExternalProviderProcessRunner;
}

// @playwright/cli has its own 0.1.x package version. It embeds Playwright
// 1.62+, but `playwright-cli --json --version` intentionally reports the CLI
// package version, not the embedded engine version.
const MIN_PLAYWRIGHT_CLI = [0, 1, 0] as const;
const MAX_PLAYWRIGHT_CLI_EXCLUSIVE = [0, 2, 0] as const;
const MIN_PEEKABOO = [3, 0, 0] as const;
const MAX_PEEKABOO_EXCLUSIVE = [4, 0, 0] as const;

export async function selectBrowserProvider(
  options: ZenXCapabilityProviderCatalogOptions,
): Promise<ZenXCapabilityProviderSelection<ZenXBrowserBackend>> {
  const runner = options.runner ?? new SystemExternalProviderProcessRunner();
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const configured = environment.ZENX_PLAYWRIGHT_CLI;
  const executable = await discoverExecutable(configured ?? "playwright-cli", {
    environment,
    platform,
  });
  const fallbackDiagnostic = electronBrowserDiagnostic(
    executable === undefined ? "fallback" : "available",
  );
  if (executable === undefined) {
    return {
      backend: new ElectronBrowserBackend(),
      manifest: browserCapabilityManifest,
      diagnostics: [
        unavailableDiagnostic(
          "browser",
          "playwright-cli",
          ["isolated"],
          ["headless", "browser_context", "aria_snapshot", "auto_wait"],
          configured === undefined
            ? "playwright-cli is not installed; install @playwright/cli and its browser, or set ZENX_PLAYWRIGHT_CLI"
            : `Configured Playwright CLI is not executable: ${configured}`,
        ),
        fallbackDiagnostic,
      ],
    };
  }
  try {
    const version = await probePlaywrightCli(executable, runner);
    const playwrightDirectory = path.join(
      options.userDataDirectory,
      "playwright",
    );
    await mkdir(playwrightDirectory, { recursive: true, mode: 0o700 });
    return {
      backend: new PlaywrightCliBrowserBackend({
        executable,
        runner,
        cwd: playwrightDirectory,
      }),
      manifest: playwrightBrowserManifest(),
      diagnostics: [
        {
          capabilityId: "browser",
          providerId: "playwright-cli",
          status: "selected",
          interactionModes: ["isolated"],
          capabilities: [
            "headless",
            "browser_context",
            "aria_snapshot",
            "auto_wait",
            "cross_platform",
          ],
          executable,
          version,
          permissionSummary:
            "Isolated in-memory Playwright session; no foreground desktop input",
        },
        fallbackDiagnostic,
      ],
    };
  } catch (error) {
    return {
      backend: new ElectronBrowserBackend(),
      manifest: browserCapabilityManifest,
      diagnostics: [
        unavailableDiagnostic(
          "browser",
          "playwright-cli",
          ["isolated"],
          ["headless", "browser_context", "aria_snapshot", "auto_wait"],
          describeError(error),
          executable,
        ),
        electronBrowserDiagnostic("fallback"),
      ],
    };
  }
}

export async function selectComputerProvider(
  options: ZenXCapabilityProviderCatalogOptions,
): Promise<ZenXOptionalCapabilityProviderSelection<ZenXComputerBackend>> {
  const runner = options.runner ?? new SystemExternalProviderProcessRunner();
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const backend = new WinAppCliComputerBackend();
    const diagnostic = await backend.diagnose();
    if (!diagnostic.ready) {
      await backend.close();
      return {
        manifest: windowsComputerCapabilityManifest,
        diagnostics: [
          unavailableDiagnostic(
            "computer",
            "microsoft-winapp-cli",
            ["background_safe"],
            ["uia.inspect", "uia.invoke", "uia.set_value", "wgc.capture"],
            diagnostic.message,
            diagnostic.executable,
          ),
        ],
      };
    }
    return {
      backend,
      manifest: windowsComputerCapabilityManifest,
      diagnostics: [
        {
          capabilityId: "computer",
          providerId: "microsoft-winapp-cli",
          status: "selected",
          interactionModes: ["background_safe"],
          capabilities: [
            "uia.inspect",
            "uia.invoke",
            "uia.set_value",
            "wgc.capture",
          ],
          executable: diagnostic.executable,
          ...(diagnostic.version === undefined
            ? {}
            : { version: diagnostic.version }),
          permissionSummary:
            "Exact-window UI Automation and WGC capture; no global input injection",
        },
      ],
    };
  }
  if (platform !== "darwin") {
    return {
      manifest: computerCapabilityManifest,
      diagnostics: [
        unavailableDiagnostic(
          "computer",
          "peekaboo-cli",
          ["background_safe", "foreground_required"],
          ["accessibility", "window.capture", "global_input"],
          "No computer provider is available for this platform",
        ),
        macBundledDiagnostic("unavailable", "Bundled provider is macOS-only"),
      ],
    };
  }
  const configured = environment.ZENX_PEEKABOO_CLI;
  const executable = await discoverExecutable(configured ?? "peekaboo", {
    environment,
    platform,
  });
  if (executable === undefined) {
    return {
      backend: new ElectronMacComputerBackend(),
      manifest: computerCapabilityManifest,
      diagnostics: [
        unavailableDiagnostic(
          "computer",
          "peekaboo-cli",
          ["background_safe", "foreground_required"],
          ["accessibility", "window.capture", "global_input"],
          configured === undefined
            ? "Peekaboo 3.x is not installed; install its CLI or set ZENX_PEEKABOO_CLI"
            : `Configured Peekaboo CLI is not executable: ${configured}`,
        ),
        macBundledDiagnostic("fallback"),
      ],
    };
  }
  try {
    const probe = await probePeekabooCli(executable, runner);
    return {
      backend: new PeekabooComputerBackend({ executable, runner }),
      manifest: peekabooComputerManifest(),
      diagnostics: [
        {
          capabilityId: "computer",
          providerId: "peekaboo-cli",
          status: "selected",
          interactionModes: ["background_safe", "foreground_required"],
          capabilities: [
            "accessibility.inspect",
            "background.semantic_action",
            "window.capture",
            "foreground.global_input",
          ],
          executable,
          version: probe.version,
          permissionSummary: probe.permissionSummary,
        },
        macBundledDiagnostic("available"),
      ],
    };
  } catch (error) {
    return {
      backend: new ElectronMacComputerBackend(),
      manifest: computerCapabilityManifest,
      diagnostics: [
        unavailableDiagnostic(
          "computer",
          "peekaboo-cli",
          ["background_safe", "foreground_required"],
          ["accessibility", "window.capture", "global_input"],
          describeError(error),
          executable,
        ),
        macBundledDiagnostic("fallback"),
      ],
    };
  }
}

export async function probePlaywrightCli(
  executable: string,
  runner: ExternalProviderProcessRunner,
): Promise<string> {
  const versionResult = await runner.run(executable, ["--json", "--version"], {
    timeoutMs: 5_000,
    maxOutputBytes: 32 * 1024,
  });
  const versionEnvelope = parseExternalJson(
    "playwright-cli",
    versionResult.stdout,
  );
  const version = requiredVersion(versionEnvelope.version, "playwright-cli");
  assertSupportedVersion(
    version,
    MIN_PLAYWRIGHT_CLI,
    MAX_PLAYWRIGHT_CLI_EXCLUSIVE,
    "playwright-cli",
  );
  const listResult = await runner.run(executable, ["--json", "list"], {
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
  });
  const listEnvelope = parseExternalJson("playwright-cli", listResult.stdout);
  if (
    !Array.isArray(listEnvelope.browsers) ||
    !listEnvelope.browsers.every(isPlaywrightBrowserDiagnostic)
  ) {
    throw new Error(
      "Unsupported playwright-cli JSON schema: list.browsers is invalid",
    );
  }
  return version;
}

export async function probePeekabooCli(
  executable: string,
  runner: ExternalProviderProcessRunner,
): Promise<{ version: string; permissionSummary: string }> {
  const versionResult = await runner.run(executable, ["--version"], {
    timeoutMs: 5_000,
    maxOutputBytes: 32 * 1024,
  });
  const version = versionResult.stdout.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
  if (version === undefined) {
    throw new Error("Peekaboo --version did not contain a semantic version");
  }
  assertSupportedVersion(
    version,
    MIN_PEEKABOO,
    MAX_PEEKABOO_EXCLUSIVE,
    "Peekaboo",
  );
  const toolsResult = await runner.run(executable, ["tools", "--json"], {
    timeoutMs: 10_000,
    maxOutputBytes: 128 * 1024,
  });
  const toolsEnvelope = parseExternalJson("peekaboo", toolsResult.stdout);
  const toolsData = asRecord(toolsEnvelope.data);
  const tools = toolsData?.tools;
  if (
    toolsEnvelope.success !== true ||
    !Array.isArray(tools) ||
    !tools.every(isPeekabooTool)
  ) {
    throw new Error(
      "Unsupported Peekaboo 3.x JSON schema: tools envelope is invalid",
    );
  }
  const toolNames = new Set(tools.map((tool) => tool.name));
  for (const required of ["see", "click", "set_value", "image"]) {
    if (!toolNames.has(required)) {
      throw new Error(`Peekaboo 3.x is missing required tool ${required}`);
    }
  }
  const permissionsResult = await runner.run(
    executable,
    ["permissions", "status", "--json"],
    { timeoutMs: 10_000, maxOutputBytes: 128 * 1024 },
  );
  const envelope = parseExternalJson("peekaboo", permissionsResult.stdout);
  const data = asRecord(envelope.data);
  const permissions = data?.permissions;
  if (
    envelope.success !== true ||
    !Array.isArray(permissions) ||
    !permissions.every(isPeekabooPermission)
  ) {
    throw new Error(
      "Unsupported Peekaboo 3.x JSON schema: permissions status envelope is invalid",
    );
  }
  return {
    version,
    permissionSummary: permissions
      .map(
        (permission) =>
          `${String(permission.name)}=${permission.isGranted === true ? "granted" : "missing"}`,
      )
      .join(", "),
  };
}

function playwrightBrowserManifest(): ZenXCapabilityManifest {
  return {
    ...structuredClone(browserCapabilityManifest),
    description:
      "A cross-platform isolated Playwright CLI browser session with bounded ARIA inspection and native auto-waiting actions.",
    provider: {
      id: "playwright-cli",
      platforms: ["darwin", "win32", "linux"],
      interactionModes: ["isolated"],
      capabilities: [
        "headless",
        "browser_context",
        "aria_snapshot",
        "auto_wait",
        "dom.navigate",
        "dom.interact",
      ],
    },
    tools: browserCapabilityManifest.tools.map((tool) => ({
      ...structuredClone(tool),
      interactionMode: "isolated",
      capabilities: [
        "playwright_cli",
        "headless",
        "browser_context",
        ...tool.capabilities.filter(
          (capability) =>
            capability !== "dedicated_profile" && capability !== "cdp",
        ),
      ],
    })),
  };
}

function peekabooComputerManifest(): ZenXCapabilityManifest {
  return {
    ...structuredClone(computerCapabilityManifest),
    description:
      "Peekaboo 3.x background-first macOS automation with bounded snapshots, explicit permissions, and foreground input only through labeled takeover tools.",
    provider: {
      id: "peekaboo-cli",
      platforms: ["darwin"],
      interactionModes: ["background_safe", "foreground_required"],
      capabilities: [
        "peekaboo.snapshot",
        "accessibility.inspect",
        "background.semantic_action",
        "window.capture",
        "foreground.global_input",
      ],
    },
    tools: computerCapabilityManifest.tools.map((tool) => ({
      ...structuredClone(tool),
      permissions:
        tool.name === "computer_inspect"
          ? [...tool.permissions, "computer.window.capture"]
          : [...tool.permissions],
      capabilities: ["peekaboo_cli", ...tool.capabilities],
    })),
  };
}

function electronBrowserDiagnostic(
  status: ZenXCapabilityProviderDiagnostic["status"],
): ZenXCapabilityProviderDiagnostic {
  return {
    capabilityId: "browser",
    providerId: "electron-dedicated-browser",
    status,
    interactionModes: ["background_safe"],
    capabilities: ["dedicated_profile", "cdp", "dom.inspect", "dom.interact"],
    permissionSummary: "Bundled hidden ephemeral Electron partition",
  };
}

function macBundledDiagnostic(
  status: ZenXCapabilityProviderDiagnostic["status"],
  reason?: string,
): ZenXCapabilityProviderDiagnostic {
  return {
    capabilityId: "computer",
    providerId: "macos-desktop",
    status,
    interactionModes: ["background_safe", "foreground_required"],
    capabilities: [
      "accessibility.inspect",
      "semantic.press",
      "semantic.set_value",
      "window.capture",
      "global_input",
    ],
    ...(reason === undefined ? {} : { reason }),
  };
}

function unavailableDiagnostic(
  capabilityId: string,
  providerId: string,
  interactionModes: ZenXCapabilityProviderDiagnostic["interactionModes"],
  capabilities: string[],
  reason: string,
  executable?: string,
): ZenXCapabilityProviderDiagnostic {
  return {
    capabilityId,
    providerId,
    status: "unavailable",
    interactionModes,
    capabilities,
    reason,
    ...(executable === undefined ? {} : { executable }),
  };
}

function requiredVersion(value: unknown, provider: string): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(value)) {
    throw new Error(
      `Unsupported ${provider} JSON schema: version must be semantic`,
    );
  }
  return value;
}

function assertSupportedVersion(
  version: string,
  minimum: readonly [number, number, number],
  maximumExclusive: readonly [number, number, number],
  provider: string,
): void {
  const parsed = version
    .split(/[.+-]/u, 3)
    .map((part) => Number.parseInt(part, 10)) as [number, number, number];
  const belowMinimum =
    parsed[0] < minimum[0] ||
    (parsed[0] === minimum[0] && parsed[1] < minimum[1]) ||
    (parsed[0] === minimum[0] &&
      parsed[1] === minimum[1] &&
      parsed[2] < minimum[2]);
  const atOrAboveMaximum =
    parsed[0] > maximumExclusive[0] ||
    (parsed[0] === maximumExclusive[0] && parsed[1] > maximumExclusive[1]) ||
    (parsed[0] === maximumExclusive[0] &&
      parsed[1] === maximumExclusive[1] &&
      parsed[2] >= maximumExclusive[2]);
  if (atOrAboveMaximum || belowMinimum) {
    throw new Error(
      `${provider} ${version} is unsupported; expected >=${minimum.join(".")} and <${maximumExclusive.join(".")}`,
    );
  }
}

function isPlaywrightBrowserDiagnostic(value: unknown): boolean {
  const browser = asRecord(value);
  return (
    browser !== undefined &&
    typeof browser.name === "string" &&
    (browser.status === "open" || browser.status === "closed") &&
    typeof browser.version === "string"
  );
}

function isPeekabooPermission(value: unknown): value is {
  name: string;
  isRequired: boolean;
  isGranted: boolean;
} {
  const permission = asRecord(value);
  return (
    permission !== undefined &&
    typeof permission.name === "string" &&
    typeof permission.isRequired === "boolean" &&
    typeof permission.isGranted === "boolean"
  );
}

function isPeekabooTool(value: unknown): value is {
  name: string;
  description: string;
} {
  const tool = asRecord(value);
  return (
    tool !== undefined &&
    typeof tool.name === "string" &&
    typeof tool.description === "string"
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
