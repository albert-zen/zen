import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  COMPUTER_ACTION_PRESS,
  COMPUTER_ACTION_SET_VALUE,
  computerCapabilityManifest,
  ComputerObservationLedger,
  type ComputerControlAction,
  type ComputerControlFingerprint,
  type ComputerControlSelector,
  type ComputerInspection,
  type ComputerKey,
  type ComputerTarget,
  MAX_COMPUTER_INSPECTION_CONTROLS,
  type ZenXComputerBackend,
} from "./computer-provider.js";
import type { ZenXCapabilityManifest } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_WINAPP_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_WINAPP_STDERR_BYTES = 16 * 1024;
const WINAPP_INSTALL_COMMAND =
  "winget install Microsoft.winappcli --source winget";
export const MINIMUM_WINAPP_CLI_VERSION = "0.3.1";

export const windowsComputerCapabilityManifest: ZenXCapabilityManifest = {
  ...structuredClone(computerCapabilityManifest),
  version: "1.1.0",
  description:
    "Optional Windows desktop operations backed by Microsoft's WinApp CLI: targeted UI Automation and WGC capture stay background-safe; unsupported global input never silently substitutes for them.",
  provider: {
    id: "microsoft-winapp-cli",
    platforms: ["win32"],
    interactionModes: ["background_safe"],
    capabilities: [
      "uia.inspect",
      "uia.invoke",
      "uia.set_value",
      "uia.wait_for.verify",
      "wgc.capture",
      "cancellable",
      "bounded_output",
    ],
  },
  permissions: computerCapabilityManifest.permissions.map((permission) => {
    if (permission.id === "computer.accessibility.act") {
      return {
        ...permission,
        description:
          "Invoke or set a value through Windows UI Automation on an explicitly selected control.",
      };
    }
    if (permission.id === "computer.window.capture") {
      return {
        ...permission,
        description:
          "Capture one explicitly targeted HWND through WinApp CLI's background-safe default capture path.",
      };
    }
    return permission;
  }),
  tools: computerCapabilityManifest.tools
    .filter((tool) => tool.interactionMode === "background_safe")
    .map((tool) => {
      switch (tool.name) {
        case "computer_inspect":
          return {
            ...tool,
            description:
              "Inspect at most 32 semantic UI Automation controls in one exact Windows HWND without activating it or reading sibling windows. target.windowTitle is required.",
            capabilities: ["uia.inspect", "app_targeted", "no_global_input"],
          };
        case "computer_press":
          return {
            ...tool,
            description:
              "Invoke one opaque control from the latest computer_inspect through Windows UI Automation. The provider revalidates selector, semantics, geometry, and action immediately before invoking.",
            capabilities: ["uia.invoke", "app_targeted", "no_global_input"],
          };
        case "computer_set_value":
          return {
            ...tool,
            description:
              "Set the supplied text on one opaque editable control through Windows UI Automation. The provider revalidates selector, semantics, geometry, and action; host/model policy owns credential decisions.",
            capabilities: ["uia.set_value", "app_targeted", "no_global_input"],
          };
        default:
          return {
            ...tool,
            description:
              "Capture one exact Windows HWND through WinApp CLI's default WGC/PrintWindow path to a private five-minute PNG artifact. Returns metadata/path, never pixels in the Thread journal.",
            capabilities: ["wgc.capture", "app_targeted", "no_global_input"],
          };
      }
    }),
  resources: [
    {
      id: "windows-computer-use",
      kind: "skill",
      title: "Targeted Windows computer use",
      description:
        "Use Microsoft WinApp CLI UI Automation through ZenX's opaque observe-before-act contract.",
      content:
        "Target one Windows application by pid or applicationId plus an exact windowTitle. Inspect first, then use only the observationId and targetId returned by the latest computer_inspect. Re-inspect after every action. Semantic invoke and set-value use UI Automation and do not inject global input. Supplied text follows the ordinary set-value path and host/model policy owns credential decisions. Window capture uses WinApp CLI's default WGC/PrintWindow path and never opts into --capture-screen or --focus. If UIA semantics are insufficient, report foreground_required; this provider does not silently inject pointer or keyboard input.",
    },
  ],
  settings: {
    dependency: "Microsoft WinApp CLI (Public Preview)",
    executable: "winapp",
    installCommand: WINAPP_INSTALL_COMMAND,
    jsonContract:
      "ui list-windows/inspect/invoke/set-value/wait-for/screenshot --json",
    minimumVersion: MINIMUM_WINAPP_CLI_VERSION,
    docs: "https://learn.microsoft.com/windows/apps/dev-tools/winapp-cli/ui-automation",
  },
};

export interface WinAppCliDiagnostic {
  ready: boolean;
  platform: NodeJS.Platform;
  executable: string;
  version?: string;
  requiredVersion: string;
  schemaCompatible: boolean;
  installCommand: string;
  message: string;
}

export interface WinAppCliRunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  redactions?: readonly string[];
}

export interface WinAppCliRunResult {
  stdout: string;
  stderr: string;
}

export interface WinAppCliRunner {
  run(
    executable: string,
    args: readonly string[],
    options: WinAppCliRunOptions,
  ): Promise<WinAppCliRunResult>;
}

interface WinAppWindow {
  hwnd: string;
  processId: number;
  processName: string;
  title?: string;
  width: number;
  height: number;
}

interface WinAppElement {
  controlType?: string;
  type?: string;
  name?: string;
  automationId?: string;
  className?: string;
  isEnabled?: boolean;
  isOffscreen?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  selector?: string;
  value?: unknown;
  isInvokable?: boolean;
  hasMoreChildren?: boolean;
  children?: WinAppElement[];
}

interface WinAppInspectEnvelope {
  depth?: number;
  interactive?: boolean;
  hideDisabled?: boolean;
  hideOffscreen?: boolean;
  windows?: Array<{
    hwnd?: unknown;
    title?: string;
    elementCount?: number;
    elements?: WinAppElement[];
  }>;
}

interface WinAppScreenshotEnvelope {
  filePath?: string;
  width?: number;
  height?: number;
  processId?: number;
  windowTitle?: string;
  hwnd?: unknown;
}

export class SpawnWinAppCliRunner implements WinAppCliRunner {
  async run(
    executable: string,
    args: readonly string[],
    options: WinAppCliRunOptions,
  ): Promise<WinAppCliRunResult> {
    return await runBoundedProcess(executable, args, options);
  }
}

export class WinAppCliComputerBackend implements ZenXComputerBackend {
  readonly #artifactDirectory: string;
  readonly #command: string;
  readonly #expiryTimers = new Set<NodeJS.Timeout>();
  readonly #observations = new ComputerObservationLedger();
  readonly #platform: NodeJS.Platform;
  readonly #runner: WinAppCliRunner;

  constructor(
    options: {
      artifactDirectory?: string;
      command?: string;
      platform?: NodeJS.Platform;
      runner?: WinAppCliRunner;
    } = {},
  ) {
    this.#artifactDirectory =
      options.artifactDirectory ??
      path.join(os.tmpdir(), `zenx-winapp-artifacts-${String(process.pid)}`);
    this.#command = options.command ?? "winapp";
    this.#platform = options.platform ?? process.platform;
    this.#runner = options.runner ?? new SpawnWinAppCliRunner();
  }

  async diagnose(signal?: AbortSignal): Promise<WinAppCliDiagnostic> {
    if (this.#platform !== "win32") {
      return {
        ready: false,
        platform: this.#platform,
        executable: this.#command,
        requiredVersion: MINIMUM_WINAPP_CLI_VERSION,
        schemaCompatible: false,
        installCommand: WINAPP_INSTALL_COMMAND,
        message: "Microsoft WinApp CLI is only available on Windows",
      };
    }
    let detectedVersion: string | undefined;
    try {
      const result = await this.#runner.run(this.#command, ["--version"], {
        timeoutMs: 5_000,
        signal,
        maxStdoutBytes: 4 * 1024,
        maxStderrBytes: 4 * 1024,
      });
      const version = parseWinAppVersion(result.stdout);
      if (version === undefined) {
        return {
          ready: false,
          platform: this.#platform,
          executable: this.#command,
          requiredVersion: MINIMUM_WINAPP_CLI_VERSION,
          schemaCompatible: false,
          installCommand: WINAPP_INSTALL_COMMAND,
          message: `Microsoft WinApp CLI version is unknown; ${MINIMUM_WINAPP_CLI_VERSION} or newer is required`,
        };
      }
      if (compareVersions(version, MINIMUM_WINAPP_CLI_VERSION) < 0) {
        return {
          ready: false,
          platform: this.#platform,
          executable: this.#command,
          version,
          requiredVersion: MINIMUM_WINAPP_CLI_VERSION,
          schemaCompatible: false,
          installCommand: WINAPP_INSTALL_COMMAND,
          message: `Microsoft WinApp CLI ${version} is incompatible; ${MINIMUM_WINAPP_CLI_VERSION} or newer is required`,
        };
      }
      detectedVersion = version;
      const cliSchemaResult = await this.#runner.run(
        this.#command,
        ["--cli-schema"],
        {
          timeoutMs: 5_000,
          signal,
          maxStdoutBytes: 512 * 1024,
          maxStderrBytes: 4 * 1024,
        },
      );
      validateCliSchema(cliSchemaResult.stdout, version);
      const probe = await this.#runner.run(
        this.#command,
        ["ui", "list-windows", "--json"],
        {
          timeoutMs: 5_000,
          signal,
          maxStdoutBytes: 256 * 1024,
          maxStderrBytes: 4 * 1024,
        },
      );
      validateWindowListProbe(probe.stdout);
      return {
        ready: true,
        platform: this.#platform,
        executable: this.#command,
        version,
        requiredVersion: MINIMUM_WINAPP_CLI_VERSION,
        schemaCompatible: true,
        installCommand: WINAPP_INSTALL_COMMAND,
        message: `Microsoft WinApp CLI ${version} is ready (requires ${MINIMUM_WINAPP_CLI_VERSION}+)`,
      };
    } catch (error) {
      return {
        ready: false,
        platform: this.#platform,
        executable: this.#command,
        ...(detectedVersion === undefined ? {} : { version: detectedVersion }),
        requiredVersion: MINIMUM_WINAPP_CLI_VERSION,
        schemaCompatible: false,
        installCommand: WINAPP_INSTALL_COMMAND,
        message: `${describeError(error)} (detected ${detectedVersion ?? "unknown"}; requires ${MINIMUM_WINAPP_CLI_VERSION}+). Install with: ${WINAPP_INSTALL_COMMAND}`,
      };
    }
  }

  async inspect(
    target: ComputerTarget,
    signal?: AbortSignal,
  ): Promise<ComputerInspection> {
    this.#requireWindows();
    const window = await this.#resolveWindow(target, signal);
    const inspectedWindow = await this.#inspectWindow(window, signal);
    const flattened = flattenElements(inspectedWindow.elements ?? []);
    const controls = flattened
      .filter((element) => usableSelector(element.selector))
      .slice(0, MAX_COMPUTER_INSPECTION_CONTROLS);
    const fingerprints = controls.map(winAppFingerprint);
    const observation = this.#observations.observe(
      computerTargetKey(target),
      fingerprints,
    );
    return {
      platform: "win32",
      observationId: observation.observationId,
      target: resolvedTarget(window),
      controls: controls.map((control, index) => ({
        selector: observation.selectors[index]!,
        role: boundedText(winAppControlType(control) ?? "Control", 80),
        title: boundedText(control.name ?? control.automationId ?? "", 256),
        enabled: control.isEnabled !== false,
        actions: fingerprints[index]!.actions,
      })),
      truncated:
        flattened.length > MAX_COMPUTER_INSPECTION_CONTROLS ||
        flattened.some((element) => element.hasMoreChildren === true) ||
        (inspectedWindow.elementCount ?? flattened.length) > flattened.length,
    };
  }

  async press(
    target: ComputerTarget,
    control: ComputerControlSelector,
    signal?: AbortSignal,
  ): Promise<{
    target: ComputerInspection["target"];
    control: ComputerControlSelector;
  }> {
    this.#requireWindows();
    const fingerprint = this.#observations.consume(
      computerTargetKey(target),
      control,
      "press",
    );
    const selector = requiredProviderSelector(fingerprint);
    const window = await this.#resolveWindow(target, signal);
    await this.#revalidateControl(window, fingerprint, "press", signal);
    const result = await this.#json<{ hwnd?: unknown }>(
      ["ui", "invoke", selector, "--window", String(window.hwnd), "--json"],
      10_000,
      signal,
    );
    requireConfirmedHwnd(result.hwnd, window.hwnd, "invoke");
    return { target: resolvedTarget(window), control };
  }

  async setValue(
    target: ComputerTarget,
    control: ComputerControlSelector,
    value: string,
    signal?: AbortSignal,
  ): Promise<{
    target: ComputerInspection["target"];
    control: ComputerControlSelector;
    characterCount: number;
  }> {
    this.#requireWindows();
    const fingerprint = this.#observations.consume(
      computerTargetKey(target),
      control,
      "set_value",
    );
    const selector = requiredProviderSelector(fingerprint);
    const window = await this.#resolveWindow(target, signal);
    await this.#revalidateControl(window, fingerprint, "set_value", signal);
    const result = await this.#json<{ hwnd?: unknown }>(
      [
        "ui",
        "set-value",
        selector,
        value,
        "--window",
        String(window.hwnd),
        "--json",
      ],
      10_000,
      signal,
      [value],
    );
    requireConfirmedHwnd(result.hwnd, window.hwnd, "set-value");
    const verification = await this.#json<{
      found?: boolean;
      timedOut?: boolean;
      waitedMs?: number;
    }>(
      [
        "ui",
        "wait-for",
        selector,
        "--window",
        window.hwnd,
        "--value",
        value,
        "--timeout",
        "3000",
        "--json",
      ],
      5_000,
      signal,
      [value],
    );
    if (
      verification.found !== true ||
      verification.timedOut === true ||
      !Number.isSafeInteger(verification.waitedMs) ||
      (verification.waitedMs as number) < 0 ||
      (verification.waitedMs as number) > 3_500
    ) {
      throw new Error(
        "WinApp CLI set-value did not satisfy the bounded UI Automation value assertion",
      );
    }
    const refreshedWindow = await this.#refreshWindow(window, signal);
    return {
      target: resolvedTarget(refreshedWindow),
      control,
      characterCount: value.length,
    };
  }

  async screenshot(
    target: ComputerTarget,
    signal?: AbortSignal,
  ): Promise<{
    artifactPath: string;
    target: ComputerInspection["target"];
    width: number;
    height: number;
    bytes: number;
    expiresAt: string;
  }> {
    this.#requireWindows();
    const window = await this.#resolveWindow(target, signal);
    await mkdir(this.#artifactDirectory, { recursive: true, mode: 0o700 });
    const artifactPath = path.join(
      this.#artifactDirectory,
      `${randomUUID()}.png`,
    );
    let result: WinAppScreenshotEnvelope;
    try {
      result = await this.#json<WinAppScreenshotEnvelope>(
        [
          "ui",
          "screenshot",
          "--window",
          String(window.hwnd),
          "--output",
          artifactPath,
          "--json",
        ],
        20_000,
        signal,
      );
    } catch (error) {
      await rm(artifactPath, { force: true });
      throw error;
    }
    const hwndConfirmed = sameHwnd(result.hwnd, window.hwnd);
    const artifactConfirmed = await sameWindowsFile(
      result.filePath ?? "",
      artifactPath,
    );
    if (!hwndConfirmed || !artifactConfirmed) {
      await rm(artifactPath, { force: true });
      throw new Error(
        `WinApp CLI screenshot did not confirm the explicitly targeted window and artifact path (HWND confirmed: ${String(hwndConfirmed)}; artifact confirmed: ${String(artifactConfirmed)})`,
      );
    }
    const metadata = await stat(artifactPath);
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const timer = setTimeout(() => {
      this.#expiryTimers.delete(timer);
      void rm(artifactPath, { force: true });
    }, 5 * 60_000);
    timer.unref();
    this.#expiryTimers.add(timer);
    return {
      artifactPath,
      target: resolvedTarget(window),
      width: positiveInteger(result.width, "screenshot width"),
      height: positiveInteger(result.height, "screenshot height"),
      bytes: metadata.size,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async foregroundClick(): Promise<void> {
    throw unsupportedForeground();
  }

  async foregroundKeyPress(_key: ComputerKey): Promise<void> {
    throw unsupportedForeground();
  }

  async foregroundScroll(): Promise<void> {
    throw unsupportedForeground();
  }

  async close(): Promise<void> {
    this.#observations.clear();
    for (const timer of this.#expiryTimers) clearTimeout(timer);
    this.#expiryTimers.clear();
    await rm(this.#artifactDirectory, { recursive: true, force: true });
  }

  async #resolveWindow(
    target: ComputerTarget,
    signal?: AbortSignal,
  ): Promise<WinAppWindow> {
    if (target.windowTitle === undefined) {
      throw new Error(
        "Windows computer operations require target.windowTitle for exact HWND scoping",
      );
    }
    const app =
      target.pid ?? target.applicationId ?? target.bundleId ?? undefined;
    if (app === undefined) {
      throw new Error("Windows target requires pid or applicationId");
    }
    const result = await this.#json<unknown>(
      ["ui", "list-windows", "--app", String(app), "--json"],
      10_000,
      signal,
    );
    if (!Array.isArray(result)) {
      throw new Error("WinApp CLI list-windows returned an invalid JSON shape");
    }
    const matches = result
      .map(parseWindow)
      .filter(
        (candidate) =>
          candidate.title === target.windowTitle &&
          (target.pid === undefined || candidate.processId === target.pid),
      );
    if (matches.length === 0) {
      throw new Error(
        "The exact Windows app/window target was not found; run computer_inspect again with a current pid/applicationId and windowTitle",
      );
    }
    if (matches.length > 1) {
      throw new Error(
        "The Windows app/window target is ambiguous; use the exact process pid and windowTitle",
      );
    }
    return matches[0]!;
  }

  async #refreshWindow(
    previous: WinAppWindow,
    signal?: AbortSignal,
  ): Promise<WinAppWindow> {
    const result = await this.#json<unknown>(
      ["ui", "list-windows", "--app", String(previous.processId), "--json"],
      10_000,
      signal,
    );
    if (!Array.isArray(result)) {
      throw new Error("WinApp CLI list-windows returned an invalid JSON shape");
    }
    const matches = result
      .map(parseWindow)
      .filter(
        (candidate) =>
          candidate.processId === previous.processId &&
          candidate.hwnd === previous.hwnd,
      );
    if (matches.length !== 1) {
      throw new Error(
        "The targeted Windows HWND changed or became ambiguous after set-value",
      );
    }
    return matches[0]!;
  }

  async #inspectWindow(
    window: WinAppWindow,
    signal?: AbortSignal,
  ): Promise<NonNullable<WinAppInspectEnvelope["windows"]>[number]> {
    const envelope = await this.#json<WinAppInspectEnvelope>(
      [
        "ui",
        "inspect",
        "--window",
        String(window.hwnd),
        "--depth",
        "8",
        "--hide-disabled",
        "--hide-offscreen",
        "--json",
      ],
      DEFAULT_TIMEOUT_MS,
      signal,
    );
    validateInspectEnvelope(envelope);
    const inspectedWindow = envelope.windows?.find((candidate) =>
      sameHwnd(candidate.hwnd, window.hwnd),
    );
    if (inspectedWindow === undefined) {
      throw new Error(
        "WinApp CLI inspect returned no data for the explicitly targeted window",
      );
    }
    return inspectedWindow;
  }

  async #revalidateControl(
    window: WinAppWindow,
    expected: ComputerControlFingerprint,
    action: "press" | "set_value",
    signal?: AbortSignal,
  ): Promise<void> {
    const selector = requiredProviderSelector(expected);
    const inspectedWindow = await this.#inspectWindow(window, signal);
    const matches = flattenElements(inspectedWindow.elements ?? []).filter(
      (element) => element.selector === selector,
    );
    if (matches.length !== 1) {
      throw new Error(
        "The WinApp control is stale, missing, or ambiguous; inspect the target again",
      );
    }
    const actual = winAppFingerprint(matches[0]!);
    if (!sameSemanticFingerprint(expected, actual)) {
      throw new Error(
        "The WinApp control changed since the observation; inspect the target again",
      );
    }
    const requiredAction =
      action === "press" ? COMPUTER_ACTION_PRESS : COMPUTER_ACTION_SET_VALUE;
    if (!actual.actions.includes(requiredAction)) {
      throw new Error(
        `The WinApp control no longer supports ${requiredAction}; inspect the target again`,
      );
    }
  }

  async #json<T>(
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
    redactions?: readonly string[],
  ): Promise<T> {
    const result = await this.#runner.run(this.#command, args, {
      timeoutMs,
      signal,
      maxStdoutBytes: MAX_WINAPP_STDOUT_BYTES,
      maxStderrBytes: MAX_WINAPP_STDERR_BYTES,
      redactions,
    });
    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      throw new Error("WinApp CLI returned malformed JSON");
    }
  }

  #requireWindows(): void {
    if (this.#platform !== "win32") {
      throw new Error(
        "Microsoft WinApp CLI computer provider requires Windows",
      );
    }
  }
}

export async function runBoundedProcess(
  executable: string,
  args: readonly string[],
  options: WinAppCliRunOptions,
): Promise<WinAppCliRunResult> {
  options.signal?.throwIfAborted();
  return await new Promise<WinAppCliRunResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const maxStdout = options.maxStdoutBytes ?? MAX_WINAPP_STDOUT_BYTES;
    const maxStderr = options.maxStderrBytes ?? MAX_WINAPP_STDERR_BYTES;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      callback();
    };
    const failAndKill = (error: Error): void => {
      child.kill("SIGKILL");
      finish(() => reject(error));
    };
    const timer = setTimeout(() => {
      failAndKill(
        new Error(
          `${path.basename(executable)} timed out after ${String(options.timeoutMs)}ms`,
        ),
      );
    }, options.timeoutMs);
    const abort = (): void => {
      failAndKill(
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new DOMException("WinApp CLI operation cancelled", "AbortError"),
      );
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        failAndKill(new Error("WinApp CLI stdout exceeded its bounded limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderr) {
        failAndKill(new Error("WinApp CLI stderr exceeded its bounded limit"));
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, exitSignal) => {
      finish(() => {
        if (code === 0) {
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
          return;
        }
        const detail = redactDiagnostic(
          `${Buffer.concat(stderr).toString("utf8")} ${Buffer.concat(stdout).toString("utf8")}`,
          options.redactions,
        );
        reject(
          new Error(
            `${path.basename(executable)} failed (${exitSignal ?? String(code)}): ${detail}`,
          ),
        );
      });
    });
    if (options.signal?.aborted === true) abort();
  });
}

function flattenElements(roots: readonly WinAppElement[]): WinAppElement[] {
  const result: WinAppElement[] = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const element = stack.pop()!;
    result.push(element);
    if (result.length >= 512) break;
    const children = element.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]!);
    }
  }
  return result;
}

function winAppFingerprint(element: WinAppElement): ComputerControlFingerprint {
  const actions: ComputerControlAction[] = [];
  if (element.isInvokable === true) actions.push(COMPUTER_ACTION_PRESS);
  if (isEditableElement(element)) {
    actions.push(COMPUTER_ACTION_SET_VALUE);
  }
  return {
    identifier: element.selector,
    role: winAppControlType(element),
    title: boundedText(element.name ?? "", 256),
    description: boundedText(element.automationId ?? "", 256),
    frame: [element.x, element.y, element.width, element.height]
      .map((value) => (Number.isFinite(value) ? String(value) : ""))
      .join(","),
    actions,
  };
}

function sameSemanticFingerprint(
  expected: ComputerControlFingerprint,
  actual: ComputerControlFingerprint,
): boolean {
  return (
    expected.identifier === actual.identifier &&
    expected.role === actual.role &&
    expected.title === actual.title &&
    expected.description === actual.description &&
    expected.frame === actual.frame
  );
}

function isEditableElement(element: WinAppElement): boolean {
  if (element.value !== undefined && element.value !== null) return true;
  return /(?:edit|textbox|document|combobox|spinner|slider)/iu.test(
    `${winAppControlType(element) ?? ""} ${element.className ?? ""}`,
  );
}

function requiredProviderSelector(
  fingerprint: ComputerControlFingerprint,
): string {
  if (!usableSelector(fingerprint.identifier)) {
    throw new Error(
      "The WinApp CLI selector is unavailable; inspect the target again",
    );
  }
  return fingerprint.identifier;
}

function usableSelector(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function computerTargetKey(target: ComputerTarget): string {
  return JSON.stringify({
    pid: target.pid ?? null,
    applicationId: target.applicationId ?? null,
    bundleId: target.bundleId ?? null,
    windowTitle: target.windowTitle ?? null,
  });
}

function winAppControlType(element: WinAppElement): string | undefined {
  return element.controlType ?? element.type;
}

function parseWinAppVersion(output: string): string | undefined {
  const match = output
    .trim()
    .match(
      /(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?:$|[^0-9])/u,
    );
  if (match === null) return undefined;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function validateWindowListProbe(stdout: string): void {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(
      `Microsoft WinApp CLI ${MINIMUM_WINAPP_CLI_VERSION}+ JSON schema probe returned malformed JSON`,
    );
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `Microsoft WinApp CLI ${MINIMUM_WINAPP_CLI_VERSION}+ JSON schema probe returned an incompatible list-windows shape`,
    );
  }
  for (const entry of value) parseWindow(entry);
}

function validateCliSchema(stdout: string, detectedVersion: string): void {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(
      "Microsoft WinApp CLI --cli-schema returned malformed JSON",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Microsoft WinApp CLI returned an incompatible CLI schema");
  }
  const root = value as Record<string, unknown>;
  const schemaVersion = root.schemaVersion;
  const schemaCliVersion =
    typeof root.version === "string"
      ? parseWinAppVersion(root.version)
      : undefined;
  if (schemaVersion !== "1.0" || schemaCliVersion !== detectedVersion) {
    throw new Error(
      `Microsoft WinApp CLI schema/version mismatch (schema ${String(schemaVersion)}, CLI ${schemaCliVersion ?? "unknown"})`,
    );
  }
  const ui = nestedCommand(root, "subcommands", "ui");
  const subcommands = commandMap(ui.subcommands, "ui subcommands");
  const required = [
    "inspect",
    "invoke",
    "list-windows",
    "screenshot",
    "set-value",
    "wait-for",
  ];
  const missing = required.filter(
    (command) => subcommands[command] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `Microsoft WinApp CLI schema is missing required UI commands: ${missing.join(", ")}`,
    );
  }
}

function nestedCommand(
  parent: Record<string, unknown>,
  collectionKey: string,
  command: string,
): Record<string, unknown> {
  const commands = commandMap(parent[collectionKey], collectionKey);
  const value = commands[command];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Microsoft WinApp CLI schema is missing required command ${command}`,
    );
  }
  return value as Record<string, unknown>;
}

function commandMap(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Microsoft WinApp CLI returned invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function validateInspectEnvelope(
  envelope: WinAppInspectEnvelope,
): asserts envelope is WinAppInspectEnvelope & {
  windows: Array<{
    hwnd: unknown;
    title?: string;
    elementCount?: number;
    elements?: WinAppElement[];
  }>;
} {
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    !Array.isArray(envelope.windows)
  ) {
    throw new Error(
      `WinApp CLI inspect returned an incompatible JSON shape; ${MINIMUM_WINAPP_CLI_VERSION}+ is required`,
    );
  }
  for (const window of envelope.windows) {
    if (typeof window !== "object" || window === null) {
      throw new Error("WinApp CLI inspect returned an invalid window entry");
    }
    normalizeHwnd(window.hwnd, "inspect window hwnd");
    if (window.elements !== undefined) {
      if (!Array.isArray(window.elements)) {
        throw new Error("WinApp CLI inspect returned invalid elements");
      }
      validateElements(window.elements);
    }
  }
}

function validateElements(elements: readonly WinAppElement[]): void {
  const stack = [...elements];
  let visited = 0;
  while (stack.length > 0) {
    const element = stack.pop();
    if (typeof element !== "object" || element === null) {
      throw new Error("WinApp CLI inspect returned an invalid element");
    }
    visited += 1;
    if (visited > 4_096) {
      throw new Error(
        "WinApp CLI inspect exceeded its schema validation bound",
      );
    }
    if (
      element.selector !== undefined &&
      typeof winAppControlType(element) !== "string"
    ) {
      throw new Error(
        `WinApp CLI inspect uses an incompatible element schema; ${MINIMUM_WINAPP_CLI_VERSION}+ element type metadata is required`,
      );
    }
    if (element.children !== undefined) {
      if (!Array.isArray(element.children)) {
        throw new Error("WinApp CLI inspect returned invalid element children");
      }
      stack.push(...element.children);
    }
  }
}

function parseWindow(value: unknown): WinAppWindow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("WinApp CLI returned an invalid window entry");
  }
  const record = value as Record<string, unknown>;
  return {
    hwnd: normalizeHwnd(record.hwnd, "window hwnd"),
    processId: positiveInteger(record.processId, "window processId"),
    processName: requiredBoundedString(record.processName, "processName", 256),
    ...(typeof record.title === "string"
      ? { title: boundedText(record.title, 256) }
      : {}),
    width: nonNegativeInteger(record.width, "window width"),
    height: nonNegativeInteger(record.height, "window height"),
  };
}

function resolvedTarget(window: WinAppWindow): ComputerInspection["target"] {
  return {
    pid: window.processId,
    applicationId: window.processName,
    applicationName: window.processName,
    ...(window.title === undefined ? {} : { windowTitle: window.title }),
  };
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`WinApp CLI returned an invalid ${label}`);
  }
  return value as number;
}

function requireConfirmedHwnd(
  actual: unknown,
  expected: string,
  action: string,
): void {
  if (!sameHwnd(actual, expected)) {
    throw new Error(
      `WinApp CLI ${action} did not confirm the explicitly targeted HWND`,
    );
  }
}

function sameHwnd(actual: unknown, expected: string): boolean {
  try {
    return normalizeHwnd(actual, "HWND") === expected;
  } catch {
    return false;
  }
}

function normalizeHwnd(value: unknown, label: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`WinApp CLI returned an invalid ${label}`);
    }
    return String(value);
  }
  if (typeof value !== "string") {
    throw new Error(`WinApp CLI returned an invalid ${label}`);
  }
  const normalized = value.trim().toLowerCase();
  if (/^0x[0-9a-f]+$/u.test(normalized)) {
    return BigInt(normalized).toString(10);
  }
  if (/^[1-9][0-9]*$/u.test(normalized)) {
    return BigInt(normalized).toString(10);
  }
  throw new Error(`WinApp CLI returned an invalid ${label}`);
}

async function sameWindowsFile(
  actual: string,
  expected: string,
): Promise<boolean> {
  if (actual.length === 0) return false;
  try {
    const [actualRealPath, expectedRealPath] = await Promise.all([
      realpath(actual),
      realpath(expected),
    ]);
    const normalize = (value: string): string =>
      path
        .resolve(value)
        .replace(/^\\\\\?\\/u, "")
        .toLocaleLowerCase("en-US");
    return normalize(actualRealPath) === normalize(expectedRealPath);
  } catch {
    return false;
  }
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`WinApp CLI returned an invalid ${label}`);
  }
  return value as number;
}

function requiredBoundedString(
  value: unknown,
  label: string,
  limit: number,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`WinApp CLI returned an invalid ${label}`);
  }
  return boundedText(value, limit);
}

function boundedText(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, limit);
}

function redactDiagnostic(
  value: string,
  exactValues: readonly string[] = [],
): string {
  let redacted = value;
  for (const exact of exactValues) {
    if (exact.length > 0) redacted = redacted.replaceAll(exact, "[REDACTED]");
  }
  return redacted.trim().slice(0, 2_048);
}

function unsupportedForeground(): Error {
  return new Error(
    "The Microsoft WinApp CLI provider does not expose ZenX's unscoped foreground tools; use background-safe UIA operations or a future explicitly app-targeted foreground contract",
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
