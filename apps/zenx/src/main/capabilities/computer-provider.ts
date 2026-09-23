import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  constants as fsConstants,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ToolInvocation } from "../../../../../src/tool.js";
import type { ZenXPluginManifestV2, ZenXCapabilityPackage } from "./types.js";
import {
  ComputerThreadObservation,
  type ComputerThreadListener,
  type ComputerThreadRequest,
} from "./computer-thread-observation.js";
import { observeComputerWindow } from "./computer-electron-observation.js";

export interface ComputerTarget {
  pid?: number;
  applicationId?: string;
  bundleId?: string;
  windowTitle?: string;
}

export interface ComputerControlSelector {
  observationId: string;
  targetId: string;
}

export const COMPUTER_ACTION_PRESS = "press";
export const COMPUTER_ACTION_SET_VALUE = "set_value";
export type ComputerControlAction =
  typeof COMPUTER_ACTION_PRESS | typeof COMPUTER_ACTION_SET_VALUE;

export interface ComputerInspection {
  platform: NodeJS.Platform;
  observationId: string;
  target: {
    pid: number;
    applicationId?: string;
    bundleId?: string;
    applicationName: string;
    windowTitle?: string;
  };
  controls: Array<{
    selector: ComputerControlSelector;
    role: string;
    title: string;
    enabled: boolean;
    actions: ComputerControlAction[];
  }>;
  truncated: boolean;
  diagnostics?: ComputerInspectionDiagnostics;
}

export interface ComputerInspectionDiagnostics {
  visitedCount: number;
  visitLimit: number;
  visitLimitReached: boolean;
  maxDepth: number;
  maxDepthVisited: number;
  depthLimitReached: boolean;
  outputLimit: number;
  outputLimitReached: boolean;
  selectionLimit: number;
  selectionLimitReached: boolean;
  actionableCount: number;
  semanticCount: number;
  fallbackCount: number;
  encounteredWebArea: boolean;
  webAreaControlCount: number;
  webAreaActionableCount: number;
}

export interface ComputerLiveObservationFrame {
  sequence: number;
  mimeType: "image/jpeg";
  data: string;
  width: number;
  height: number;
  capturedAt: string;
}

export type ComputerLiveObservationEvent =
  | {
      type: "status";
      status: "idle" | "connecting" | "live" | "unavailable" | "failed";
      message: string;
    }
  | { type: "frame"; frame: ComputerLiveObservationFrame };

export type ComputerLiveObservationListener = (
  event: ComputerLiveObservationEvent,
) => void;

export interface ZenXComputerBackend {
  observeWindow?(
    target: ComputerTarget,
    listener: ComputerLiveObservationListener,
  ): () => void;
  listWindows?(
    query: string | undefined,
    signal?: AbortSignal,
  ): Promise<ComputerWindowList>;
  inspect(
    target: ComputerTarget,
    signal?: AbortSignal,
  ): Promise<ComputerInspection>;
  press(
    target: ComputerTarget,
    control: ComputerControlSelector,
    signal?: AbortSignal,
  ): Promise<{
    target: ComputerInspection["target"];
    control: ComputerControlSelector;
  }>;
  setValue(
    target: ComputerTarget,
    control: ComputerControlSelector,
    value: string,
    signal?: AbortSignal,
  ): Promise<{
    target: ComputerInspection["target"];
    control: ComputerControlSelector;
    characterCount: number;
  }>;
  screenshot(
    target: ComputerTarget,
    signal?: AbortSignal,
  ): Promise<{
    artifactPath: string;
    target: ComputerInspection["target"];
    width: number;
    height: number;
    bytes: number;
    expiresAt: string;
  }>;
  foregroundClick(
    x: number,
    y: number,
    button: "left" | "right",
    signal: AbortSignal,
  ): Promise<void>;
  foregroundKeyPress(key: ComputerKey, signal: AbortSignal): Promise<void>;
  foregroundScroll(deltaY: number, signal: AbortSignal): Promise<void>;
  close(): Promise<void> | void;
}

export interface ComputerWindowList {
  windows: Array<{ target: ComputerTarget; applicationName: string }>;
  truncated: boolean;
}

export function selectComputerWindows(
  targets: ComputerInspection["target"][],
  query?: string,
): ComputerWindowList {
  const matching = targets.filter(
    (target) =>
      target.windowTitle !== undefined &&
      (query === undefined ||
        `${target.pid} ${target.applicationName} ${target.windowTitle}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())),
  );
  return {
    windows: matching
      .slice(0, 32)
      .map(({ applicationName, ...target }) => ({ target, applicationName })),
    truncated: matching.length > 32,
  };
}

export type ComputerKey =
  | "enter"
  | "escape"
  | "tab"
  | "backspace"
  | "space"
  | "arrowUp"
  | "arrowDown"
  | "arrowLeft"
  | "arrowRight";

export const MAX_COMPUTER_INSPECTION_CONTROLS = 32;

/** Preserve source order within each tier while keeping preferred semantics visible. */
export function selectComputerInspectionControls<T>(
  controls: readonly T[],
  actionable: (control: T) => boolean,
  preferred: (control: T) => boolean = () => false,
): T[] {
  if (controls.length <= MAX_COMPUTER_INSPECTION_CONTROLS) return [...controls];
  const actionableFlags = controls.map(actionable);
  const preferredFlags = controls.map(preferred);
  const selected = new Set<number>();
  const tiers = [
    (index: number) => preferredFlags[index] && actionableFlags[index],
    (index: number) => preferredFlags[index] && !actionableFlags[index],
    (index: number) => !preferredFlags[index] && actionableFlags[index],
    (index: number) => !preferredFlags[index] && !actionableFlags[index],
  ];
  for (const tier of tiers) {
    for (let index = 0; index < controls.length; index += 1) {
      if (selected.size === MAX_COMPUTER_INSPECTION_CONTROLS) break;
      if (tier(index)) selected.add(index);
    }
  }
  return controls.filter((_, index) => selected.has(index));
}

export const computerCapabilityManifest: ZenXPluginManifestV2 = {
  schemaVersion: 2,
  id: "computer",
  name: "Computer",
  version: "1.0.1",
  description:
    "Negotiated macOS desktop operations: targeted accessibility actions where supported and explicitly labeled, cancellable foreground takeover as the reliable baseline.",
  compatibility: { zenx: ">=0.1.0 <0.2.0" },
  runtime: { type: "bundled", entry: "zenx/computer" },
  mainDocument:
    "Start with computer_list_windows to find open windows and running applications. If truncated, narrow with query. Pass a returned target unchanged to computer_inspect before acting; prefer background-safe semantic controls.",
  provider: {
    id: "macos-desktop",
    platforms: ["darwin"],
    interactionModes: ["background_safe", "foreground_required"],
    capabilities: [
      "window.list",
      "accessibility.inspect",
      "semantic.press",
      "semantic.set_value",
      "window.capture",
      "foreground.pointer",
      "foreground.keyboard",
      "foreground.scroll",
    ],
  },
  permissions: [
    {
      id: "computer.accessibility.inspect",
      title: "Inspect a targeted app",
      description:
        "Read a bounded accessibility tree for an explicitly targeted app or window.",
      scope: "local-device",
    },
    {
      id: "computer.accessibility.act",
      title: "Act on a targeted control",
      description:
        "Perform a semantic press or set a semantic value on an explicitly selected accessibility control without global input.",
      scope: "local-device",
    },
    {
      id: "computer.window.capture",
      title: "Capture a targeted window",
      description:
        "Capture one explicitly targeted app window to a private short-lived artifact.",
      scope: "local-device",
    },
    {
      id: "computer.foreground.control",
      title: "Control the foreground desktop",
      description:
        "Use global pointer, keyboard, focus, or scrolling. ZenX exposes these as explicitly labeled, cancellable foreground takeover.",
      scope: "local-device",
    },
  ],
  tools: [
    {
      name: "computer_list_windows",
      description:
        "List up to 32 open desktop windows and their running applications without activating them. Pass a case-insensitive query matching application name, PID, or title to narrow truncated results. Copy a returned target directly into computer_inspect; this is not a catalog of installed apps.",
      inputSchema: objectSchema(
        { query: { type: "string", minLength: 1, maxLength: 256 } },
        [],
      ),
      permissions: ["computer.accessibility.inspect"],
      interactionMode: "background_safe",
      capabilities: ["window.list", "no_global_input"],
      maxOutputBytes: 1024 * 1024,
    },
    {
      name: "computer_inspect",
      description:
        "Inspect at most 32 semantic accessibility controls in one exact app window target without activating it or reading sibling windows. target.windowTitle is required.",
      inputSchema: objectSchema({ target: targetSchema() }, ["target"]),
      permissions: ["computer.accessibility.inspect"],
      interactionMode: "background_safe",
      capabilities: [
        "accessibility.inspect",
        "app_targeted",
        "no_global_input",
      ],
      maxOutputBytes: 12 * 1024,
    },
    {
      name: "computer_press",
      description:
        "Perform a native semantic press on one control returned by computer_inspect. Does not move the pointer, type keys, or activate the target app.",
      inputSchema: objectSchema(
        { target: targetSchema(), control: controlSchema() },
        ["target", "control"],
      ),
      permissions: ["computer.accessibility.act"],
      interactionMode: "background_safe",
      capabilities: ["semantic.press", "app_targeted", "no_global_input"],
    },
    {
      name: "computer_set_value",
      description:
        "Set the supplied text on one editable opaque target from the latest computer_inspect observation. The value follows the ordinary tool path and host/model policy decides how it is handled.",
      inputSchema: objectSchema(
        {
          target: targetSchema(),
          control: controlSchema(),
          value: stringSchema(),
        },
        ["target", "control", "value"],
      ),
      permissions: ["computer.accessibility.act"],
      interactionMode: "background_safe",
      capabilities: ["semantic.set_value", "app_targeted", "no_global_input"],
    },
    {
      name: "computer_screenshot",
      description:
        "Capture one explicit app/window target to a private five-minute PNG artifact. Returns metadata/path, never pixels in the Thread journal.",
      inputSchema: objectSchema({ target: targetSchema() }, ["target"]),
      permissions: ["computer.window.capture"],
      interactionMode: "background_safe",
      capabilities: ["window.capture", "app_targeted", "no_global_input"],
      maxOutputBytes: 4 * 1024,
    },
    ...foregroundTools(),
  ],
};

export class ComputerZenXCapabilityPackage implements ZenXCapabilityPackage {
  readonly manifest: ZenXPluginManifestV2;
  readonly #backend: ZenXComputerBackend;
  readonly #threadObservation: ComputerThreadObservation;
  #foregroundControlAllowed: boolean;
  #foregroundConsent = new AbortController();

  constructor(
    backend: ZenXComputerBackend,
    manifest: ZenXPluginManifestV2 = computerCapabilityManifest,
    foregroundControlAllowed = false,
  ) {
    this.#backend = backend;
    this.#threadObservation = new ComputerThreadObservation(backend);
    this.manifest = manifest;
    this.#foregroundControlAllowed = foregroundControlAllowed;
    if (!foregroundControlAllowed) this.#revokeForegroundConsent();
  }

  setForegroundControlAllowed(allowed: boolean): void {
    if (allowed === this.#foregroundControlAllowed) return;
    this.#foregroundControlAllowed = allowed;
    if (allowed) this.#foregroundConsent = new AbortController();
    else this.#revokeForegroundConsent();
  }

  async invoke(toolName: string, invocation: ToolInvocation): Promise<unknown> {
    invocation.signal.throwIfAborted();
    if (toolName === "computer_list_windows") {
      const query = optionalString(invocation.arguments, "query");
      if (query !== undefined && query.length > 256)
        throw new Error("query is limited to 256 characters");
      if (this.#backend.listWindows === undefined)
        throw new Error(
          "This Computer provider does not support window discovery",
        );
      return await this.#backend.listWindows(query, invocation.signal);
    }
    if (toolName.startsWith("computer_foreground_")) {
      return await this.#invokeForeground(toolName, invocation);
    }
    const target = requiredTarget(invocation.arguments);
    let result: unknown;
    switch (toolName) {
      case "computer_inspect":
        requireScopedWindow(target, "computer_inspect");
        result = await this.#backend.inspect(target, invocation.signal);
        break;
      case "computer_press":
        requireScopedWindow(target, "computer_press");
        result = await this.#backend.press(
          target,
          requiredControl(invocation.arguments),
          invocation.signal,
        );
        break;
      case "computer_set_value": {
        requireScopedWindow(target, "computer_set_value");
        const value = requiredString(invocation.arguments, "value", true);
        if (value.length > 4_000) {
          throw new Error("computer_set_value is limited to 4000 characters");
        }
        result = await this.#backend.setValue(
          target,
          requiredControl(invocation.arguments),
          value,
          invocation.signal,
        );
        break;
      }
      case "computer_screenshot":
        if (target.windowTitle === undefined) {
          throw new Error("computer_screenshot requires target.windowTitle");
        }
        result = await this.#backend.screenshot(target, invocation.signal);
        break;
      default:
        throw new Error(`Unsupported computer tool: ${toolName}`);
    }
    if (invocation.threadId !== undefined) {
      const resolved =
        result && typeof result === "object" && "target" in result
          ? ((result as { target: ComputerTarget }).target ?? target)
          : target;
      this.#threadObservation.publish(
        invocation.threadId,
        invocation.callId,
        resolved,
      );
    }
    return result;
  }

  observeThread(
    request: ComputerThreadRequest,
    listener: ComputerThreadListener,
  ): () => void {
    return this.#threadObservation.observe(request, listener);
  }

  async #invokeForeground(
    toolName: string,
    invocation: ToolInvocation,
  ): Promise<unknown> {
    this.#assertForegroundControlAllowed(toolName);
    const signal = AbortSignal.any([
      invocation.signal,
      this.#foregroundConsent.signal,
    ]);
    switch (toolName) {
      case "computer_foreground_click": {
        const x = requiredFiniteNumber(invocation.arguments, "x");
        const y = requiredFiniteNumber(invocation.arguments, "y");
        const button = optionalString(invocation.arguments, "button") ?? "left";
        if (button !== "left" && button !== "right") {
          throw new Error("button must be left or right");
        }
        await foregroundTakeoverNotice(signal);
        this.#assertForegroundControlAllowed(toolName);
        await this.#backend.foregroundClick(x, y, button, signal);
        return { action: "click", x, y, button, impact: "foreground_takeover" };
      }
      case "computer_foreground_key_press": {
        const key = requiredComputerKey(invocation.arguments);
        await foregroundTakeoverNotice(signal);
        this.#assertForegroundControlAllowed(toolName);
        await this.#backend.foregroundKeyPress(key, signal);
        return { action: "key_press", key, impact: "foreground_takeover" };
      }
      case "computer_foreground_scroll": {
        const deltaY = requiredFiniteNumber(invocation.arguments, "deltaY");
        if (deltaY === 0 || Math.abs(deltaY) > 10_000) {
          throw new Error(
            "deltaY must be non-zero and between -10000 and 10000",
          );
        }
        await foregroundTakeoverNotice(signal);
        this.#assertForegroundControlAllowed(toolName);
        await this.#backend.foregroundScroll(deltaY, signal);
        return { action: "scroll", deltaY, impact: "foreground_takeover" };
      }
      default:
        throw new Error(`Unsupported foreground computer tool: ${toolName}`);
    }
  }

  #assertForegroundControlAllowed(toolName: string): void {
    if (this.#foregroundControlAllowed) return;
    throw new Error(
      `${toolName} is foreground_required; enable Foreground computer control in ZenX Settings before use`,
    );
  }

  #revokeForegroundConsent(): void {
    this.#foregroundConsent.abort(
      new Error(
        "Foreground computer control was revoked; foreground_required operation cancelled",
      ),
    );
  }

  async close(): Promise<void> {
    this.#threadObservation.close();
    await this.#backend.close();
  }
}

export interface ComputerControlFingerprint {
  identifier?: string;
  role?: string;
  subrole?: string;
  title?: string;
  description?: string;
  help?: string;
  frame?: string;
  actions: ComputerControlAction[];
}

interface ComputerObservation {
  observationId: string;
  targets: Map<string, ComputerControlFingerprint>;
}

export class ComputerObservationLedger {
  readonly #latest = new Map<string, ComputerObservation>();

  observe(
    targetKey: string,
    fingerprints: ComputerControlFingerprint[],
  ): { observationId: string; selectors: ComputerControlSelector[] } {
    const observationId = randomUUID();
    const targets = new Map<string, ComputerControlFingerprint>();
    const selectors = fingerprints.map((fingerprint) => {
      const targetId = randomUUID();
      targets.set(targetId, fingerprint);
      return { observationId, targetId };
    });
    this.#latest.set(targetKey, { observationId, targets });
    return { observationId, selectors };
  }

  consume(
    targetKey: string,
    selector: ComputerControlSelector,
    action: ComputerControlAction,
  ): ComputerControlFingerprint {
    const observation = this.#latest.get(targetKey);
    if (
      observation === undefined ||
      observation.observationId !== selector.observationId
    ) {
      throw new Error(
        "Computer observation is stale, unknown, or scoped to another target; inspect the target again",
      );
    }
    const fingerprint = observation.targets.get(selector.targetId);
    if (fingerprint === undefined) {
      throw new Error("Computer target ID is forged, stale, or unknown");
    }
    if (
      action === COMPUTER_ACTION_PRESS &&
      !fingerprint.actions.includes(COMPUTER_ACTION_PRESS)
    ) {
      throw new Error(
        "Control no longer supports background-safe semantic press; foreground_required",
      );
    }
    if (action === COMPUTER_ACTION_SET_VALUE) {
      if (!fingerprint.actions.includes(COMPUTER_ACTION_SET_VALUE)) {
        throw new Error(
          "Control no longer supports background-safe semantic set value; foreground_required",
        );
      }
    }
    this.#latest.delete(targetKey);
    return fingerprint;
  }

  clear(): void {
    this.#latest.clear();
  }
}

interface MacRawControl {
  selector: {
    identifier?: string;
    role?: string;
    subrole?: string;
    title?: string;
    description?: string;
    help?: string;
    frame?: string;
  };
  role: string;
  title: string;
  enabled: boolean;
  actions: string[];
  inWebArea: boolean;
}

const MAC_CONTAINER_ROLES = new Set([
  "AXWindow",
  "AXGroup",
  "AXToolbar",
  "AXScrollArea",
  "AXSplitGroup",
  "AXWebArea",
  "AXLayoutArea",
  "AXLayoutItem",
]);

function preferredMacWebControl(control: MacRawControl): boolean {
  if (!control.inWebArea) return false;
  return (
    canonicalComputerActions(control.actions).length > 0 ||
    (control.title.length > 0 && !MAC_CONTAINER_ROLES.has(control.role))
  );
}

interface MacInspectionResult {
  target: ComputerInspection["target"];
  controls: MacRawControl[];
  truncated: boolean;
  diagnostics: Omit<
    ComputerInspectionDiagnostics,
    "selectionLimit" | "selectionLimitReached"
  >;
}

function rawControlFingerprint(
  control: MacRawControl,
): ComputerControlFingerprint {
  return {
    ...control.selector,
    actions: canonicalComputerActions(control.actions),
  };
}

function canonicalComputerActions(
  actions: readonly string[],
): ComputerControlAction[] {
  const canonical: ComputerControlAction[] = [];
  if (actions.includes("AXPress")) canonical.push(COMPUTER_ACTION_PRESS);
  if (actions.includes("AXSetValue")) {
    canonical.push(COMPUTER_ACTION_SET_VALUE);
  }
  return canonical;
}

function semanticControlSelector(
  fingerprint: ComputerControlFingerprint,
): Record<string, string> {
  const { actions: _actions, ...selector } = fingerprint;
  return selector;
}

function computerTargetKey(target: ComputerTarget): string {
  return JSON.stringify({
    pid: target.pid ?? null,
    applicationId: target.applicationId ?? null,
    bundleId: target.bundleId ?? null,
    windowTitle: target.windowTitle ?? null,
  });
}

export async function retryDesktopSourceEnumeration<T>(
  getSources: () => Promise<T>,
): Promise<T> {
  try {
    return await getSources();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "Failed to get sources"
    ) {
      throw new Error("Window source enumeration failed", { cause: error });
    }
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  try {
    return await getSources();
  } catch (error) {
    throw new Error("Window source enumeration failed after retry", {
      cause: error,
    });
  }
}

export class ElectronMacComputerBackend implements ZenXComputerBackend {
  readonly #artifactDirectory: string;
  readonly #expiryTimers = new Set<NodeJS.Timeout>();
  readonly #accessibility: MacAccessibilityDriver;
  readonly #foregroundInput: MacForegroundInputDriver;
  readonly #observations = new ComputerObservationLedger();

  constructor(
    artifactDirectory = path.join(
      os.tmpdir(),
      `zenx-capability-artifacts-${String(process.pid)}`,
    ),
  ) {
    this.#artifactDirectory = artifactDirectory;
    this.#accessibility = new MacAccessibilityDriver(artifactDirectory);
    this.#foregroundInput = new MacForegroundInputDriver(artifactDirectory);
  }

  async listWindows(
    query?: string,
    signal?: AbortSignal,
  ): Promise<ComputerWindowList> {
    requireMacOs();
    signal?.throwIfAborted();
    const targets = (await this.#accessibility.run(
      {
        operation: "listWindows",
      },
      signal,
    )) as ComputerInspection["target"][];
    signal?.throwIfAborted();
    return selectComputerWindows(targets, query);
  }

  async inspect(target: ComputerTarget): Promise<ComputerInspection> {
    requireMacOs();
    const result = (await this.#accessibility.run({
      operation: "inspect",
      target,
    })) as MacInspectionResult;
    const boundedControls = selectComputerInspectionControls(
      result.controls,
      (control) =>
        control.enabled && canonicalComputerActions(control.actions).length > 0,
      preferredMacWebControl,
    );
    const observation = this.#observations.observe(
      computerTargetKey(target),
      boundedControls.map(rawControlFingerprint),
    );
    return {
      platform: process.platform,
      observationId: observation.observationId,
      target: result.target,
      controls: boundedControls.map((control, index) => ({
        selector: observation.selectors[index]!,
        role: control.role,
        title: control.title,
        enabled: control.enabled,
        actions: rawControlFingerprint(control).actions,
      })),
      truncated:
        result.truncated || result.controls.length > boundedControls.length,
      diagnostics: {
        ...result.diagnostics,
        selectionLimit: MAX_COMPUTER_INSPECTION_CONTROLS,
        selectionLimitReached: result.controls.length > boundedControls.length,
      },
    };
  }

  async desktopContext(): Promise<{
    pid: number;
    bundleId: string;
    applicationName: string;
  }> {
    requireMacOs();
    return (await this.#accessibility.run({ operation: "desktopContext" })) as {
      pid: number;
      bundleId: string;
      applicationName: string;
    };
  }

  async prepareForegroundInput(signal: AbortSignal): Promise<void> {
    requireMacOs();
    await this.#foregroundInput.prepare(signal);
  }

  async press(
    target: ComputerTarget,
    control: ComputerControlSelector,
  ): Promise<{
    target: ComputerInspection["target"];
    control: ComputerControlSelector;
  }> {
    requireMacOs();
    const fingerprint = this.#observations.consume(
      computerTargetKey(target),
      control,
      COMPUTER_ACTION_PRESS,
    );
    const response = (await this.#accessibility.run({
      operation: "press",
      target,
      control: semanticControlSelector(fingerprint),
    })) as { target: ComputerInspection["target"] };
    return { target: response.target, control };
  }

  async setValue(
    target: ComputerTarget,
    control: ComputerControlSelector,
    value: string,
  ): Promise<{
    target: ComputerInspection["target"];
    control: ComputerControlSelector;
    characterCount: number;
  }> {
    requireMacOs();
    const fingerprint = this.#observations.consume(
      computerTargetKey(target),
      control,
      COMPUTER_ACTION_SET_VALUE,
    );
    const response = (await this.#accessibility.run({
      operation: "setValue",
      target,
      control: semanticControlSelector(fingerprint),
      value,
    })) as {
      target: ComputerInspection["target"];
      characterCount: number;
    };
    return { ...response, control };
  }

  async screenshot(target: ComputerTarget): Promise<{
    artifactPath: string;
    target: ComputerInspection["target"];
    width: number;
    height: number;
    bytes: number;
    expiresAt: string;
  }> {
    requireMacOs();
    const { target: resolvedTarget, image } = await this.#captureWindow(target);
    await mkdir(this.#artifactDirectory, { recursive: true, mode: 0o700 });
    const artifactPath = path.join(
      this.#artifactDirectory,
      `${randomUUID()}.png`,
    );
    const png = image.toPNG();
    await writeFile(artifactPath, png, { mode: 0o600 });
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const timer = setTimeout(() => {
      this.#expiryTimers.delete(timer);
      void rm(artifactPath, { force: true });
    }, 5 * 60_000);
    timer.unref();
    this.#expiryTimers.add(timer);
    const size = image.getSize();
    return {
      artifactPath,
      target: resolvedTarget,
      width: size.width,
      height: size.height,
      bytes: png.length,
      expiresAt: expiresAt.toISOString(),
    };
  }

  observeWindow(
    target: ComputerTarget,
    listener: ComputerLiveObservationListener,
  ): () => void {
    const exactWindow = this.#resolveWindow(target);
    return observeComputerWindow(async () => {
      const resolved = await exactWindow;
      return await this.#captureWindowId(resolved.windowId);
    }, listener);
  }

  async #captureWindow(target: ComputerTarget) {
    const resolved = await this.#resolveWindow(target);
    return {
      target: resolved.target,
      image: await this.#captureWindowId(resolved.windowId),
    };
  }

  async #resolveWindow(target: ComputerTarget) {
    return (await this.#accessibility.run({
      operation: "resolveWindow",
      target,
    })) as { target: ComputerInspection["target"]; windowId: number };
  }

  async #captureWindowId(windowId: number) {
    const { desktopCapturer } = await import("electron");
    const sources = await retryDesktopSourceEnumeration(() =>
      desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 1600, height: 1000 },
        fetchWindowIcons: false,
      }),
    );
    const source = sources.find((candidate) =>
      candidate.id.startsWith(`window:${String(windowId)}:`),
    );
    if (source === undefined || source.thumbnail.isEmpty())
      throw new Error(
        "The targeted window is not available for scoped capture; grant Screen Recording permission and ensure the window is on-screen",
      );
    return source.thumbnail;
  }

  async foregroundClick(
    x: number,
    y: number,
    button: "left" | "right",
    signal: AbortSignal,
  ): Promise<void> {
    requireMacOs();
    const { screen } = await import("electron");
    const onDisplay = screen
      .getAllDisplays()
      .some(
        ({ bounds }) =>
          x >= bounds.x &&
          y >= bounds.y &&
          x < bounds.x + bounds.width &&
          y < bounds.y + bounds.height,
      );
    if (!onDisplay) {
      throw new Error(
        `Foreground click point ${String(x)},${String(y)} is outside every display`,
      );
    }
    await this.#foregroundInput.run(
      { operation: "click", x: Math.round(x), y: Math.round(y), button },
      signal,
    );
  }

  async foregroundKeyPress(
    key: ComputerKey,
    signal: AbortSignal,
  ): Promise<void> {
    requireMacOs();
    await this.#foregroundInput.run({ operation: "key", key }, signal);
  }

  async foregroundScroll(deltaY: number, signal: AbortSignal): Promise<void> {
    requireMacOs();
    await this.#foregroundInput.run(
      { operation: "scroll", deltaY: Math.round(deltaY) },
      signal,
    );
  }

  async close(): Promise<void> {
    this.#observations.clear();
    for (const timer of this.#expiryTimers) clearTimeout(timer);
    this.#expiryTimers.clear();
    await rm(this.#artifactDirectory, { recursive: true, force: true });
  }
}

export class MacForegroundInputDriver {
  readonly #directory: string;
  readonly #compileHelper: () => Promise<string>;
  readonly #runProcess: typeof runProcess;
  #executable: Promise<string> | undefined;

  constructor(
    directory: string,
    dependencies: {
      compile?: () => Promise<string>;
      runProcess?: typeof runProcess;
    } = {},
  ) {
    this.#directory = directory;
    this.#compileHelper =
      dependencies.compile ??
      (() =>
        resolveMacNativeHelperExecutable("zenx-foreground-input", () =>
          this.#compile(),
        ));
    this.#runProcess = dependencies.runProcess ?? runProcess;
  }

  async run(
    request: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const executable = await (this.#executable ??= this.#compileHelper());
    signal.throwIfAborted();
    await this.#runProcess(
      executable,
      [],
      10_000,
      JSON.stringify(request),
      signal,
    );
  }

  async prepare(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await (this.#executable ??= this.#compileHelper());
    signal.throwIfAborted();
  }

  async #compile(): Promise<string> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const sourcePath = path.join(
      this.#directory,
      "zenx-foreground-input.swift",
    );
    const executablePath = path.join(this.#directory, "zenx-foreground-input");
    await writeFile(sourcePath, MAC_FOREGROUND_INPUT_SOURCE, {
      encoding: "utf8",
      mode: 0o600,
    });
    await runProcess(
      "/usr/bin/swiftc",
      ["-O", sourcePath, "-o", executablePath],
      60_000,
    );
    return executablePath;
  }
}

class MacAccessibilityDriver {
  readonly #directory: string;
  #executable: Promise<string> | undefined;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async run(
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const executable = await (this.#executable ??=
      resolveMacNativeHelperExecutable("zenx-accessibility", () =>
        this.#compile(),
      ));
    const output = await runProcess(
      executable,
      [],
      10_000,
      JSON.stringify(request),
      signal,
    );
    try {
      return JSON.parse(output) as unknown;
    } catch {
      throw new Error("macOS accessibility helper returned invalid JSON");
    }
  }

  async #compile(): Promise<string> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const sourcePath = path.join(this.#directory, "zenx-accessibility.swift");
    const executablePath = path.join(this.#directory, "zenx-accessibility");
    await writeFile(sourcePath, MAC_ACCESSIBILITY_SOURCE, {
      encoding: "utf8",
      mode: 0o600,
    });
    await runProcess(
      "/usr/bin/swiftc",
      ["-O", sourcePath, "-o", executablePath],
      60_000,
    );
    return executablePath;
  }
}

export async function resolveMacNativeHelperExecutable(
  helperName: "zenx-accessibility" | "zenx-foreground-input",
  compileDevelopmentHelper: () => Promise<string>,
  runtime: {
    resourcesPath?: string;
    defaultApp?: boolean;
  } = process as typeof process & {
    resourcesPath?: string;
    defaultApp?: boolean;
  },
  assertExecutable: (path: string, mode: number) => Promise<void> = access,
): Promise<string> {
  if (runtime.resourcesPath !== undefined && runtime.defaultApp !== true) {
    const executable = path.join(
      runtime.resourcesPath,
      "native-helpers",
      helperName,
    );
    try {
      await assertExecutable(executable, fsConstants.X_OK);
    } catch (error) {
      throw new Error(
        `Packaged macOS Computer helper is missing or not executable: ${executable}`,
        { cause: error },
      );
    }
    return executable;
  }
  return await compileDevelopmentHelper();
}

export const MAC_ACCESSIBILITY_SOURCE = `import AppKit
import ApplicationServices
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\\n").utf8))
  exit(1)
}

func dictionary(_ value: Any?, _ name: String) -> [String: Any] {
  guard let result = value as? [String: Any] else { fail(name + " must be an object") }
  return result
}

func string(_ value: Any?) -> String? {
  guard let value = value as? String, !value.isEmpty else { return nil }
  return value
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success,
        let value else { return nil }
  return value
}

func textAttribute(_ element: AXUIElement, _ name: String) -> String {
  return attribute(element, name) as? String ?? ""
}

func boolAttribute(_ element: AXUIElement, _ name: String) -> Bool {
  return attribute(element, name) as? Bool ?? false
}

func elementArrayAttribute(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
  var count: CFIndex = 0
  guard AXUIElementGetAttributeValueCount(element, name as CFString, &count) == .success,
        count > 0 else { return [] }
  var values: CFArray?
  guard AXUIElementCopyAttributeValues(element, name as CFString, 0, count, &values) == .success,
        let array = values else { return [] }
  return (0..<CFArrayGetCount(array)).compactMap { index in
    guard let pointer = CFArrayGetValueAtIndex(array, index) else { return nil }
    return unsafeBitCast(pointer, to: AXUIElement.self)
  }
}

func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
  guard let raw = attribute(element, name),
        CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
  return unsafeBitCast(raw, to: AXUIElement.self)
}

func actions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
  return (names as? [String] ?? []).sorted()
}

func isSettable(_ element: AXUIElement, _ name: String) -> Bool {
  var settable: DarwinBoolean = false
  return AXUIElementIsAttributeSettable(element, name as CFString, &settable) == .success && settable.boolValue
}

func elementFrame(_ element: AXUIElement) -> CGRect? {
  guard let rawPosition = attribute(element, kAXPositionAttribute),
        let rawSize = attribute(element, kAXSizeAttribute),
        CFGetTypeID(rawPosition) == AXValueGetTypeID(),
        CFGetTypeID(rawSize) == AXValueGetTypeID() else { return nil }
  let positionValue = unsafeBitCast(rawPosition, to: AXValue.self)
  let sizeValue = unsafeBitCast(rawSize, to: AXValue.self)
  var position = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(positionValue, .cgPoint, &position),
        AXValueGetValue(sizeValue, .cgSize, &size),
        position.x.isFinite, position.y.isFinite,
        size.width.isFinite, size.height.isFinite,
        size.width > 0, size.height > 0 else { return nil }
  return CGRect(origin: position, size: size)
}

func frameFingerprint(_ element: AXUIElement) -> String {
  guard let frame = elementFrame(element) else { return "" }
  return String(format: "%.1f,%.1f,%.1f,%.1f", frame.origin.x, frame.origin.y, frame.size.width, frame.size.height)
}

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let raw = try? JSONSerialization.jsonObject(with: data),
      let request = raw as? [String: Any] else { fail("request must be JSON") }
let operation = string(request["operation"]) ?? ""
if operation == "desktopContext" {
  guard let frontmost = NSWorkspace.shared.frontmostApplication else { fail("frontmost application is unavailable") }
  let response: [String: Any] = [
    "pid": Int(frontmost.processIdentifier),
    "bundleId": frontmost.bundleIdentifier ?? "",
    "applicationName": frontmost.localizedName ?? ""
  ]
  guard let output = try? JSONSerialization.data(withJSONObject: response) else { fail("could not encode response") }
  FileHandle.standardOutput.write(output)
  exit(0)
}
guard AXIsProcessTrusted() else {
  fail("macOS Accessibility denied for helper at " + CommandLine.arguments[0] + ". If the current ZenX.app is already enabled in System Settings > Privacy & Security > Accessibility, remove the old ZenX entry, add the current ZenX.app again, and relaunch ZenX.")
}
if operation == "listWindows" {
  var targets: [[String: Any]] = []
  for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
    let element = AXUIElementCreateApplication(app.processIdentifier)
    // Chromium publishes its current AX window surface on demand. Requesting
    // the application role before AXWindows keeps list and inspect consistent.
    _ = textAttribute(element, kAXRoleAttribute)
    for window in elementArrayAttribute(element, kAXWindowsAttribute) {
      var target: [String: Any] = [
        "pid": Int(app.processIdentifier),
        "applicationName": app.localizedName ?? "",
        "windowTitle": textAttribute(window, kAXTitleAttribute)
      ]
      if let bundleId = app.bundleIdentifier { target["bundleId"] = bundleId }
      targets.append(target)
    }
  }
  guard let output = try? JSONSerialization.data(withJSONObject: targets) else { fail("could not encode windows") }
  FileHandle.standardOutput.write(output)
  exit(0)
}
let targetRequest = dictionary(request["target"], "target")

let running: NSRunningApplication
if let pidNumber = targetRequest["pid"] as? NSNumber {
  guard let candidate = NSRunningApplication(processIdentifier: pid_t(pidNumber.int32Value)) else {
    fail("target pid is not running")
  }
  running = candidate
} else if let bundleId = string(targetRequest["bundleId"]) {
  guard let candidate = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
    fail("target bundleId is not running")
  }
  running = candidate
} else {
  fail("target requires pid or bundleId")
}
if let expectedBundle = string(targetRequest["bundleId"]), running.bundleIdentifier != expectedBundle {
  fail("target pid and bundleId identify different applications")
}

let appElement = AXUIElementCreateApplication(running.processIdentifier)
// Chromium enables its native macOS accessibility surface on demand when an
// assistive client requests the application role. Query it before resolving
// windows so the first scoped inspection can include the web-area subtree.
_ = textAttribute(appElement, kAXRoleAttribute)
let requestedWindowTitle = string(targetRequest["windowTitle"])
var windows = elementArrayAttribute(appElement, kAXWindowsAttribute)
if let focused = elementAttribute(appElement, kAXFocusedWindowAttribute) { windows.append(focused) }
if let main = elementAttribute(appElement, kAXMainWindowAttribute) { windows.append(main) }
let selectedWindow: AXUIElement?
if let title = requestedWindowTitle {
  selectedWindow = windows.first(where: {
    textAttribute($0, kAXRoleAttribute) == kAXWindowRole &&
    textAttribute($0, kAXTitleAttribute) == title
  })
  if selectedWindow == nil {
    fail("target window was not found as a scoped AXWindow")
  }
} else {
  selectedWindow = nil
}
let root = selectedWindow ?? appElement
var resolvedTarget: [String: Any] = [
  "pid": Int(running.processIdentifier),
  "bundleId": running.bundleIdentifier ?? "",
  "applicationName": running.localizedName ?? ""
]
if let title = requestedWindowTitle { resolvedTarget["windowTitle"] = title }

func children(_ element: AXUIElement) -> [AXUIElement] {
  let direct = elementArrayAttribute(element, kAXChildrenAttribute)
  if !direct.isEmpty { return direct }
  return elementArrayAttribute(element, "AXChildrenInNavigationOrder")
}

func supportsTextValue(_ element: AXUIElement) -> Bool {
  let role = textAttribute(element, kAXRoleAttribute)
  return ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(role) &&
    isSettable(element, kAXValueAttribute)
}

func supportedActions(_ element: AXUIElement) -> [String] {
  var result = actions(element)
  if supportsTextValue(element) { result.append("AXSetValue") }
  return Array(Set(result)).sorted()
}

func displayLabel(_ element: AXUIElement) -> String {
  for name in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXIdentifierAttribute] {
    let value = textAttribute(element, name)
    if !value.isEmpty { return value }
  }
  return ""
}

func isContainerRole(_ role: String) -> Bool {
  return [
    kAXWindowRole,
    kAXGroupRole,
    kAXToolbarRole,
    kAXScrollAreaRole,
    kAXSplitGroupRole,
    "AXWebArea",
    "AXLayoutArea",
    "AXLayoutItem"
  ].contains(role)
}

func selector(_ element: AXUIElement) -> [String: String] {
  var result: [String: String] = [:]
  let identifier = textAttribute(element, kAXIdentifierAttribute)
  let role = textAttribute(element, kAXRoleAttribute)
  let subrole = textAttribute(element, kAXSubroleAttribute)
  let title = textAttribute(element, kAXTitleAttribute)
  let description = textAttribute(element, kAXDescriptionAttribute)
  let help = textAttribute(element, kAXHelpAttribute)
  let frame = frameFingerprint(element)
  if !identifier.isEmpty { result["identifier"] = identifier }
  if !role.isEmpty { result["role"] = role }
  if !subrole.isEmpty { result["subrole"] = subrole }
  if !title.isEmpty { result["title"] = title }
  if !description.isEmpty { result["description"] = description }
  if !help.isEmpty { result["help"] = help }
  if !frame.isEmpty { result["frame"] = frame }
  return result
}

func matches(_ element: AXUIElement, _ wanted: [String: Any]) -> Bool {
  if let value = string(wanted["identifier"]), textAttribute(element, kAXIdentifierAttribute) != value { return false }
  if let value = string(wanted["role"]), textAttribute(element, kAXRoleAttribute) != value { return false }
  if let value = string(wanted["subrole"]), textAttribute(element, kAXSubroleAttribute) != value { return false }
  if let value = string(wanted["title"]), textAttribute(element, kAXTitleAttribute) != value { return false }
  if let value = string(wanted["description"]), textAttribute(element, kAXDescriptionAttribute) != value { return false }
  if let value = string(wanted["help"]), textAttribute(element, kAXHelpAttribute) != value { return false }
  if let value = string(wanted["frame"]), frameFingerprint(element) != value { return false }
  return string(wanted["identifier"]) != nil || string(wanted["role"]) != nil || string(wanted["subrole"]) != nil || string(wanted["title"]) != nil || string(wanted["description"]) != nil || string(wanted["help"]) != nil || string(wanted["frame"]) != nil
}

struct WalkEntry {
  let element: AXUIElement
  let inWebArea: Bool
}

struct WalkResult {
  let entries: [WalkEntry]
  var elements: [AXUIElement] { entries.map { $0.element } }
  let visitLimit: Int
  let visitLimitReached: Bool
  let maxDepth: Int
  let maxDepthVisited: Int
  let depthLimitReached: Bool
}

func walk(_ root: AXUIElement, visitLimit: Int = 1024, maxDepth: Int = 24) -> WalkResult {
  var queue: [(AXUIElement, Int, Bool)] = [(root, 0, false)]
  var result: [WalkEntry] = []
  var cursor = 0
  var maxDepthVisited = 0
  var depthLimitReached = false
  while cursor < queue.count && result.count < visitLimit {
    let (element, depth, inheritedWebArea) = queue[cursor]
    cursor += 1
    let inWebArea = inheritedWebArea || textAttribute(element, kAXRoleAttribute) == "AXWebArea"
    result.append(WalkEntry(element: element, inWebArea: inWebArea))
    maxDepthVisited = max(maxDepthVisited, depth)
    let descendants = children(element)
    if depth < maxDepth {
      queue.append(contentsOf: descendants.map { ($0, depth + 1, inWebArea) })
    } else if !descendants.isEmpty {
      depthLimitReached = true
    }
  }
  return WalkResult(
    entries: result,
    visitLimit: visitLimit,
    visitLimitReached: cursor < queue.count,
    maxDepth: maxDepth,
    maxDepthVisited: maxDepthVisited,
    depthLimitReached: depthLimitReached
  )
}

func cgWindowBounds(_ entry: [String: Any]) -> CGRect? {
  guard let raw = entry[kCGWindowBounds as String] as? [String: Any],
        let x = (raw["X"] as? NSNumber)?.doubleValue,
        let y = (raw["Y"] as? NSNumber)?.doubleValue,
        let width = (raw["Width"] as? NSNumber)?.doubleValue,
        let height = (raw["Height"] as? NSNumber)?.doubleValue,
        x.isFinite, y.isFinite, width.isFinite, height.isFinite,
        width > 0, height > 0 else { return nil }
  return CGRect(x: x, y: y, width: width, height: height)
}

func windowBoundsMatch(_ candidate: CGRect, _ expected: CGRect, tolerance: CGFloat = 24) -> Bool {
  return abs(candidate.origin.x - expected.origin.x) <= tolerance &&
    abs(candidate.origin.y - expected.origin.y) <= tolerance &&
    abs(candidate.size.width - expected.size.width) <= tolerance &&
    abs(candidate.size.height - expected.size.height) <= tolerance
}

func findControl(_ wanted: [String: Any]) -> AXUIElement {
  let traversal = walk(root)
  let found = traversal.elements.filter { matches($0, wanted) }
  if found.isEmpty { fail("accessibility control was not found") }
  if found.count > 1 { fail("accessibility selector is ambiguous") }
  return found[0]
}

var response: [String: Any]
switch operation {
case "inspect":
  let traversal = walk(root)
  var actionableControls: [[String: Any]] = []
  var semanticControls: [[String: Any]] = []
  var fallbackControls: [[String: Any]] = []
  var encounteredWebArea = false
  var webAreaControlCount = 0
  var webAreaActionableCount = 0
  for entry in traversal.entries {
    let element = entry.element
    let controlSelector = selector(element)
    if controlSelector.isEmpty { continue }
    let role = textAttribute(element, kAXRoleAttribute)
    if role == "AXWebArea" { encounteredWebArea = true }
    let label = displayLabel(element)
    let enabled = boolAttribute(element, kAXEnabledAttribute)
    let elementActions = supportedActions(element)
    if entry.inWebArea { webAreaControlCount += 1 }
    let control: [String: Any] = [
      "selector": controlSelector,
      "role": role,
      "title": label,
      "enabled": enabled,
      "actions": elementActions,
      "inWebArea": entry.inWebArea,
    ]
    if enabled && (elementActions.contains("AXPress") || elementActions.contains("AXSetValue")) {
      if entry.inWebArea { webAreaActionableCount += 1 }
      actionableControls.append(control)
    } else if !isContainerRole(role) && !label.isEmpty {
      semanticControls.append(control)
    } else {
      fallbackControls.append(control)
    }
  }
  let orderedControls = actionableControls + semanticControls + fallbackControls
  let outputLimit = 120
  let controls = Array(orderedControls.prefix(outputLimit))
  let outputLimitReached = orderedControls.count > controls.count
  response = [
    "target": resolvedTarget,
    "controls": controls,
    "truncated": traversal.visitLimitReached || traversal.depthLimitReached || outputLimitReached,
    "diagnostics": [
      "visitedCount": traversal.elements.count,
      "visitLimit": traversal.visitLimit,
      "visitLimitReached": traversal.visitLimitReached,
      "maxDepth": traversal.maxDepth,
      "maxDepthVisited": traversal.maxDepthVisited,
      "depthLimitReached": traversal.depthLimitReached,
      "outputLimit": outputLimit,
      "outputLimitReached": outputLimitReached,
      "actionableCount": actionableControls.count,
      "semanticCount": semanticControls.count,
      "fallbackCount": fallbackControls.count,
      "encounteredWebArea": encounteredWebArea,
      "webAreaControlCount": webAreaControlCount,
      "webAreaActionableCount": webAreaActionableCount
    ]
  ]
case "press":
  let wanted = dictionary(request["control"], "control")
  let element = findControl(wanted)
  guard actions(element).contains(kAXPressAction) else { fail("control does not support background-safe AXPress; foreground_required") }
  let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
  guard error == .success else { fail("AXPress failed with error " + String(error.rawValue)) }
  response = ["target": resolvedTarget, "control": selector(element)]
case "setValue":
  let wanted = dictionary(request["control"], "control")
  guard let value = request["value"] as? String else { fail("value must be a string") }
  let element = findControl(wanted)
  guard supportsTextValue(element) else {
    fail("control does not support background-safe AXValue; foreground_required")
  }
  let error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
  guard error == .success else { fail("AXValue failed with error " + String(error.rawValue)) }
  response = ["target": resolvedTarget, "control": selector(element), "characterCount": value.count]
case "resolveWindow":
  guard let title = requestedWindowTitle else { fail("windowTitle is required") }
  guard let selectedWindow, let selectedBounds = elementFrame(selectedWindow) else {
    fail("target AXWindow has no valid bounds for scoped capture")
  }
  let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let candidates = info.compactMap { entry -> ([String: Any], CGRect)? in
    guard (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == running.processIdentifier,
          (entry[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
          let bounds = cgWindowBounds(entry) else { return nil }
    return (entry, bounds)
  }
  let titleMatches = candidates.filter {
    ($0.0[kCGWindowName as String] as? String ?? "") == title
  }
  let scopedCandidates = titleMatches.isEmpty ? candidates : titleMatches
  let window: [String: Any]
  if titleMatches.count == 1 {
    window = titleMatches[0].0
  } else {
    let geometryMatches = scopedCandidates.filter {
      windowBoundsMatch($0.1, selectedBounds)
    }
    if geometryMatches.count > 1 {
      fail("target window mapping is ambiguous for scoped capture")
    }
    guard let matched = geometryMatches.first else {
      fail("target window is not available for scoped capture")
    }
    window = matched.0
  }
  guard let number = window[kCGWindowNumber as String] as? NSNumber else {
    fail("target window has no CGWindow identifier for scoped capture")
  }
  response = ["target": resolvedTarget, "windowId": number]
default:
  fail("unsupported accessibility operation")
}

guard let output = try? JSONSerialization.data(withJSONObject: response) else { fail("could not encode response") }
FileHandle.standardOutput.write(output)
`;

export const MAC_FOREGROUND_INPUT_SOURCE = `import ApplicationServices
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\\n").utf8))
  exit(1)
}

guard AXIsProcessTrusted() else {
  fail("macOS Accessibility denied for helper at " + CommandLine.arguments[0] + ". If the current ZenX.app is already enabled in System Settings > Privacy & Security > Accessibility, remove the old ZenX entry, add the current ZenX.app again, and relaunch ZenX.")
}
let data = FileHandle.standardInput.readDataToEndOfFile()
guard let raw = try? JSONSerialization.jsonObject(with: data),
      let request = raw as? [String: Any],
      let operation = request["operation"] as? String else { fail("request must be JSON") }

let keyCodes: [String: CGKeyCode] = [
  "enter": 36, "escape": 53, "tab": 48, "backspace": 51, "space": 49,
  "arrowUp": 126, "arrowDown": 125, "arrowLeft": 123, "arrowRight": 124
]

func postKey(_ code: CGKeyCode) {
  CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)?.post(tap: .cghidEventTap)
  usleep(20_000)
  CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap)
}

switch operation {
case "click":
  guard let x = (request["x"] as? NSNumber)?.doubleValue,
        let y = (request["y"] as? NSNumber)?.doubleValue,
        let buttonName = request["button"] as? String else { fail("invalid click request") }
  let point = CGPoint(x: x, y: y)
  let right = buttonName == "right"
  let button: CGMouseButton = right ? .right : .left
  let down: CGEventType = right ? .rightMouseDown : .leftMouseDown
  let up: CGEventType = right ? .rightMouseUp : .leftMouseUp
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
  CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
  usleep(30_000)
  CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
case "key":
  guard let key = request["key"] as? String, let code = keyCodes[key] else { fail("unsupported key") }
  postKey(code)
case "scroll":
  guard let delta = (request["deltaY"] as? NSNumber)?.int32Value else { fail("invalid scroll request") }
  CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: -delta, wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
default:
  fail("unsupported foreground input operation")
}
`;

export async function runProcess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  stdin?: string,
  signal?: AbortSignal,
  spawnProcess: typeof spawn = spawn,
): Promise<string> {
  signal?.throwIfAborted();
  return await new Promise<string>((resolve, reject) => {
    const child = spawnProcess(command, args, {
      shell: false,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new Error(
            `${path.basename(command)} timed out after ${String(timeoutMs)}ms`,
          ),
        ),
      );
    }, timeoutMs);
    const abort = (): void => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          signal?.reason ??
            new DOMException(
              "The foreground operation was cancelled",
              "AbortError",
            ),
        ),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    if (stdin !== undefined) child.stdin?.end(stdin, "utf8");
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, exitSignal) => {
      finish(() => {
        signal?.removeEventListener("abort", abort);
        if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
        else {
          reject(
            new Error(
              `${path.basename(command)} failed (${exitSignal ?? String(code)}): ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 2048)}`,
            ),
          );
        }
      });
    });
    if (signal?.aborted === true) abort();
  });
}

function foregroundTools(): ZenXPluginManifestV2["tools"] {
  const shared = {
    permissions: ["computer.foreground.control"],
    interactionMode: "foreground_required" as const,
    capabilities: ["global_input", "may_change_focus", "cancellable"],
  };
  return [
    {
      ...shared,
      name: "computer_foreground_click",
      description:
        "FOREGROUND TAKEOVER: move and click the real global pointer. ZenX shows the running tool before input begins; Stop cancels it.",
      inputSchema: objectSchema(
        {
          x: { type: "number" },
          y: { type: "number" },
          button: { type: "string", enum: ["left", "right"] },
        },
        ["x", "y"],
      ),
    },
    {
      ...shared,
      name: "computer_foreground_key_press",
      description:
        "FOREGROUND TAKEOVER: press one allowlisted key in the focused control. Stop cancels the running operation.",
      inputSchema: objectSchema(
        {
          key: {
            type: "string",
            enum: [
              "enter",
              "escape",
              "tab",
              "backspace",
              "space",
              "arrowUp",
              "arrowDown",
              "arrowLeft",
              "arrowRight",
            ],
          },
        },
        ["key"],
      ),
    },
    {
      ...shared,
      name: "computer_foreground_scroll",
      description:
        "FOREGROUND TAKEOVER: scroll the current foreground target. Stop cancels the running operation.",
      inputSchema: objectSchema({ deltaY: { type: "number" } }, ["deltaY"]),
    },
  ];
}

function requiredTarget(arguments_: Record<string, unknown>): ComputerTarget {
  const raw = requiredObject(arguments_, "target");
  const pid = optionalPositiveInteger(raw, "pid");
  const applicationId = optionalString(raw, "applicationId");
  const bundleId = optionalString(raw, "bundleId");
  const windowTitle =
    raw.windowTitle === undefined
      ? undefined
      : requiredString(raw, "windowTitle", true);
  if (
    pid === undefined &&
    applicationId === undefined &&
    bundleId === undefined
  ) {
    throw new Error("target requires pid, applicationId, or bundleId");
  }
  if (windowTitle !== undefined && windowTitle.length > 4096) {
    throw new Error("target.windowTitle is limited to 4096 characters");
  }
  if (applicationId !== undefined && applicationId.length > 256) {
    throw new Error("target.applicationId is limited to 256 characters");
  }
  if (bundleId !== undefined && bundleId.length > 256) {
    throw new Error("target.bundleId is limited to 256 characters");
  }
  return {
    ...(pid === undefined ? {} : { pid }),
    ...(applicationId === undefined ? {} : { applicationId }),
    ...(bundleId === undefined ? {} : { bundleId }),
    ...(windowTitle === undefined ? {} : { windowTitle }),
  };
}

function requiredControl(
  arguments_: Record<string, unknown>,
): ComputerControlSelector {
  const raw = requiredObject(arguments_, "control");
  return {
    observationId: requiredOpaqueId(raw, "observationId"),
    targetId: requiredOpaqueId(raw, "targetId"),
  };
}

function requireScopedWindow(target: ComputerTarget, toolName: string): void {
  if (target.windowTitle === undefined) {
    throw new Error(
      `${toolName} requires target.windowTitle so the provider cannot inspect or act across sibling windows`,
    );
  }
}

async function foregroundTakeoverNotice(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 1_000);
    const abort = (): void => {
      clearTimeout(timer);
      reject(
        signal.reason ??
          new DOMException(
            "The foreground operation was cancelled",
            "AbortError",
          ),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function requiredFiniteNumber(
  arguments_: Record<string, unknown>,
  key: string,
): number {
  const value = arguments_[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function requiredComputerKey(arguments_: Record<string, unknown>): ComputerKey {
  const value = requiredString(arguments_, "key");
  if (!COMPUTER_KEYS.includes(value as ComputerKey)) {
    throw new Error(`Unsupported computer key: ${value}`);
  }
  return value as ComputerKey;
}

const COMPUTER_KEYS: readonly ComputerKey[] = [
  "enter",
  "escape",
  "tab",
  "backspace",
  "space",
  "arrowUp",
  "arrowDown",
  "arrowLeft",
  "arrowRight",
];

function requiredObject(
  arguments_: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = arguments_[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalPositiveInteger(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (!Number.isSafeInteger(candidate) || (candidate as number) <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return candidate as number;
}

function requiredString(
  arguments_: Record<string, unknown>,
  key: string,
  allowEmpty = false,
): string {
  const value = arguments_[key];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(
      `${key} must be ${allowEmpty ? "a string" : "a non-empty string"}`,
    );
  }
  return value;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return candidate;
}

function targetSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      pid: { type: "integer", minimum: 1 },
      applicationId: stringSchema(),
      bundleId: stringSchema(),
      windowTitle: stringSchema(),
    },
    additionalProperties: false,
    anyOf: [
      { required: ["pid"] },
      { required: ["applicationId"] },
      { required: ["bundleId"] },
    ],
  };
}

function controlSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      observationId: stringSchema(),
      targetId: stringSchema(),
    },
    additionalProperties: false,
    required: ["observationId", "targetId"],
  };
}

function requiredOpaqueId(value: Record<string, unknown>, key: string): string {
  const candidate = requiredString(value, key);
  if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(candidate)) {
    throw new Error(`${key} must be an opaque identifier`);
  }
  return candidate;
}

function stringSchema(): Record<string, unknown> {
  return { type: "string" };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function requireMacOs(): void {
  if (process.platform !== "darwin") {
    throw new Error(
      "The bundled computer provider currently supports macOS only",
    );
  }
}
