import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  COMPUTER_ACTION_PRESS,
  COMPUTER_ACTION_SET_VALUE,
  computerCapabilityManifest,
  ComputerObservationLedger,
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
              "Invoke one opaque control from the latest computer_inspect through Windows UI Automation. The provider revalidates selector, semantics, geometry, secure state, and action immediately before invoking.",
            capabilities: ["uia.invoke", "app_targeted", "no_global_input"],
          };
        case "computer_set_value":
          return {
            ...tool,
            description:
              "Set a non-secret value on one opaque editable control through Windows UI Automation. The provider revalidates selector, semantics, geometry, secure state, and action; supplied text is a canonical journaled tool argument.",
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
        "Target one Windows application by pid or applicationId plus an exact windowTitle. Inspect first, then use only the observationId and targetId returned by the latest computer_inspect. Re-inspect after every action. Semantic invoke and set-value use UI Automation and do not inject global input. computer_set_value is non-secret-only because tool arguments are journaled; secure-looking controls are rejected. Window capture uses WinApp CLI's default WGC/PrintWindow path and never opts into --capture-screen or --focus. If UIA semantics are insufficient, report foreground_required; this provider does not silently inject pointer or keyboard input.",
    },
  ],
  settings: {
    dependency: "Microsoft WinApp CLI (Public Preview)",
    executable: "winapp",
    installCommand: WINAPP_INSTALL_COMMAND,
    jsonContract: "ui list-windows/inspect/invoke/set-value/screenshot --json",
    docs: "https://learn.microsoft.com/windows/apps/dev-tools/winapp-cli/ui-automation",
  },
};

export interface WinAppCliDiagnostic {
  ready: boolean;
  platform: NodeJS.Platform;
  executable: string;
  version?: string;
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
  hwnd: number;
  processId: number;
  processName: string;
  title?: string;
  width: number;
  height: number;
}

interface WinAppElement {
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
  windows?: Array<{
    hwnd?: number;
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
  hwnd?: number;
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
        installCommand: WINAPP_INSTALL_COMMAND,
        message: "Microsoft WinApp CLI is only available on Windows",
      };
    }
    try {
      const result = await this.#runner.run(this.#command, ["--version"], {
        timeoutMs: 5_000,
        signal,
        maxStdoutBytes: 4 * 1024,
        maxStderrBytes: 4 * 1024,
      });
      const version = result.stdout.trim().slice(0, 128);
      return {
        ready: true,
        platform: this.#platform,
        executable: this.#command,
        ...(version.length === 0 ? {} : { version }),
        installCommand: WINAPP_INSTALL_COMMAND,
        message: "Microsoft WinApp CLI is ready",
      };
    } catch (error) {
      return {
        ready: false,
        platform: this.#platform,
        executable: this.#command,
        installCommand: WINAPP_INSTALL_COMMAND,
        message: `${describeError(error)}. Install with: ${WINAPP_INSTALL_COMMAND}`,
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
        role: boundedText(control.type ?? "Control", 80),
        title: boundedText(control.name ?? control.automationId ?? "", 256),
        enabled: control.isEnabled !== false,
        actions: fingerprints[index]!.actions,
        ...(fingerprints[index]!.secure ? { secure: true } : {}),
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
    const result = await this.#json<{ hwnd?: number }>(
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
    const result = await this.#json<{ hwnd?: number }>(
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
    return {
      target: resolvedTarget(window),
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
    if (
      result.hwnd !== window.hwnd ||
      path.resolve(result.filePath ?? "") !== path.resolve(artifactPath)
    ) {
      await rm(artifactPath, { force: true });
      throw new Error(
        "WinApp CLI screenshot did not confirm the explicitly targeted window and artifact path",
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
    const inspectedWindow = envelope.windows?.find(
      (candidate) => candidate.hwnd === window.hwnd,
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
    if (action === "set_value" && actual.secure) {
      throw new Error(
        "computer_set_value rejects password or secure controls; supplied text is a journaled non-secret-only tool argument",
      );
    }
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
  const secure = isSecureElement(element);
  const actions: string[] = [];
  if (element.isInvokable === true) actions.push(COMPUTER_ACTION_PRESS);
  if (!secure && isEditableElement(element)) {
    actions.push(COMPUTER_ACTION_SET_VALUE);
  }
  return {
    identifier: element.selector,
    role: element.type,
    title: boundedText(element.name ?? "", 256),
    description: boundedText(element.automationId ?? "", 256),
    frame: [element.x, element.y, element.width, element.height]
      .map((value) => (Number.isFinite(value) ? String(value) : ""))
      .join(","),
    secure,
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
    expected.frame === actual.frame &&
    expected.secure === actual.secure
  );
}

function isEditableElement(element: WinAppElement): boolean {
  if (element.value !== undefined && element.value !== null) return true;
  return /(?:edit|textbox|document|combobox|spinner|slider)/iu.test(
    `${element.type ?? ""} ${element.className ?? ""}`,
  );
}

function isSecureElement(element: WinAppElement): boolean {
  return /(?:password|passwd|passcode|pin|secret|secure|credential|token)/iu.test(
    [element.type, element.name, element.automationId, element.className]
      .filter((value): value is string => typeof value === "string")
      .join(" "),
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

function parseWindow(value: unknown): WinAppWindow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("WinApp CLI returned an invalid window entry");
  }
  const record = value as Record<string, unknown>;
  return {
    hwnd: positiveInteger(record.hwnd, "window hwnd"),
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
  expected: number,
  action: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `WinApp CLI ${action} did not confirm the explicitly targeted HWND`,
    );
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
  return redacted
    .replace(
      /("?(?:password|secret|token|credential|authorization)"?\s*[:=]\s*)("[^"]*"|\S+)/giu,
      "$1[REDACTED]",
    )
    .trim()
    .slice(0, 2_048);
}

function unsupportedForeground(): Error {
  return new Error(
    "The Microsoft WinApp CLI provider does not expose ZenX's unscoped foreground tools; use background-safe UIA operations or a future explicitly app-targeted foreground contract",
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
