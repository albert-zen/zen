import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ToolInvocation } from "../../../../../src/tool.js";
import type { ZenXCapabilityManifest, ZenXCapabilityPackage } from "./types.js";

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
    secure?: true;
  }>;
  truncated: boolean;
}

export interface ZenXComputerBackend {
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

export const computerCapabilityManifest: ZenXCapabilityManifest = {
  schemaVersion: 1,
  id: "computer",
  displayName: "Computer",
  version: "1.0.0",
  description:
    "Negotiated macOS desktop operations: targeted accessibility actions where supported and explicitly labeled, cancellable foreground takeover as the reliable baseline.",
  provider: {
    id: "macos-desktop",
    platforms: ["darwin"],
    interactionModes: ["background_safe", "foreground_required"],
    capabilities: [
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
        "Set a non-secret semantic value on one editable opaque target from the latest computer_inspect observation. Secure/password controls are rejected; supplied text is a canonical journaled tool argument.",
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
  resources: [
    {
      id: "background-safe-computer-use",
      kind: "skill",
      title: "Background-safe computer use",
      description:
        "Instructions for app-targeted accessibility actions without foreground takeover.",
      content:
        "Prefer structured browser tools for web pages. For native apps, identify a pid or bundleId and optionally an exact window title, inspect that target, then act only with the observationId and opaque targetId from the latest inspect. Re-inspect after every action. computer_set_value is non-secret-only because supplied text is journaled, and secure controls are rejected. Try background-safe semantic press/value/capture first. Those tools must never fall back to pointer motion, foreground keystrokes, app activation, or workspace changes. If accessibility semantics are insufficient and foreground takeover is acceptable, choose an explicitly named computer_foreground_* tool, warn that it affects the user's live desktop, and keep the operation cancellable; otherwise report unsupported.",
    },
  ],
};

export class ComputerZenXCapabilityPackage implements ZenXCapabilityPackage {
  readonly manifest: ZenXCapabilityManifest;
  readonly #backend: ZenXComputerBackend;

  constructor(
    backend: ZenXComputerBackend,
    manifest: ZenXCapabilityManifest = computerCapabilityManifest,
  ) {
    this.#backend = backend;
    this.manifest = manifest;
  }

  async invoke(toolName: string, invocation: ToolInvocation): Promise<unknown> {
    if (toolName.startsWith("computer_foreground_")) {
      return await this.#invokeForeground(toolName, invocation);
    }
    const target = requiredTarget(invocation.arguments);
    switch (toolName) {
      case "computer_inspect":
        requireScopedWindow(target, "computer_inspect");
        return await this.#backend.inspect(target, invocation.signal);
      case "computer_press":
        requireScopedWindow(target, "computer_press");
        return await this.#backend.press(
          target,
          requiredControl(invocation.arguments),
          invocation.signal,
        );
      case "computer_set_value": {
        requireScopedWindow(target, "computer_set_value");
        const value = requiredString(invocation.arguments, "value", true);
        if (value.length > 4_000) {
          throw new Error("computer_set_value is limited to 4000 characters");
        }
        return await this.#backend.setValue(
          target,
          requiredControl(invocation.arguments),
          value,
          invocation.signal,
        );
      }
      case "computer_screenshot":
        if (target.windowTitle === undefined) {
          throw new Error("computer_screenshot requires target.windowTitle");
        }
        return await this.#backend.screenshot(target, invocation.signal);
      default:
        throw new Error(`Unsupported computer tool: ${toolName}`);
    }
  }

  async #invokeForeground(
    toolName: string,
    invocation: ToolInvocation,
  ): Promise<unknown> {
    switch (toolName) {
      case "computer_foreground_click": {
        const x = requiredFiniteNumber(invocation.arguments, "x");
        const y = requiredFiniteNumber(invocation.arguments, "y");
        const button = optionalString(invocation.arguments, "button") ?? "left";
        if (button !== "left" && button !== "right") {
          throw new Error("button must be left or right");
        }
        await foregroundTakeoverNotice(invocation.signal);
        await this.#backend.foregroundClick(x, y, button, invocation.signal);
        return { action: "click", x, y, button, impact: "foreground_takeover" };
      }
      case "computer_foreground_key_press": {
        const key = requiredComputerKey(invocation.arguments);
        await foregroundTakeoverNotice(invocation.signal);
        await this.#backend.foregroundKeyPress(key, invocation.signal);
        return { action: "key_press", key, impact: "foreground_takeover" };
      }
      case "computer_foreground_scroll": {
        const deltaY = requiredFiniteNumber(invocation.arguments, "deltaY");
        if (deltaY === 0 || Math.abs(deltaY) > 10_000) {
          throw new Error(
            "deltaY must be non-zero and between -10000 and 10000",
          );
        }
        await foregroundTakeoverNotice(invocation.signal);
        await this.#backend.foregroundScroll(deltaY, invocation.signal);
        return { action: "scroll", deltaY, impact: "foreground_takeover" };
      }
      default:
        throw new Error(`Unsupported foreground computer tool: ${toolName}`);
    }
  }

  async close(): Promise<void> {
    await this.#backend.close();
  }
}

export interface ComputerControlFingerprint {
  identifier?: string;
  role?: string;
  subrole?: string;
  title?: string;
  description?: string;
  frame?: string;
  secure: boolean;
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
      if (fingerprint.secure) {
        throw new Error(
          "computer_set_value rejects password or secure controls; supplied text is a journaled non-secret-only tool argument",
        );
      }
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
    frame?: string;
  };
  role: string;
  title: string;
  enabled: boolean;
  actions: string[];
  secure?: boolean;
}

interface MacInspectionResult {
  target: ComputerInspection["target"];
  controls: MacRawControl[];
  truncated: boolean;
}

function rawControlFingerprint(
  control: MacRawControl,
): ComputerControlFingerprint {
  return {
    ...control.selector,
    secure: control.secure === true,
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
  const { secure: _secure, actions: _actions, ...selector } = fingerprint;
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

  async inspect(target: ComputerTarget): Promise<ComputerInspection> {
    requireMacOs();
    const result = (await this.#accessibility.run({
      operation: "inspect",
      target,
    })) as MacInspectionResult;
    const boundedControls = result.controls.slice(
      0,
      MAX_COMPUTER_INSPECTION_CONTROLS,
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
        ...(control.secure ? { secure: true } : {}),
      })),
      truncated:
        result.truncated || result.controls.length > boundedControls.length,
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
    const resolved = (await this.#accessibility.run({
      operation: "resolveWindow",
      target,
    })) as { target: ComputerInspection["target"]; windowId: number };
    const { desktopCapturer } = await import("electron");
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 1600, height: 1000 },
      fetchWindowIcons: false,
    });
    const source = sources.find((candidate) =>
      candidate.id.startsWith(`window:${String(resolved.windowId)}:`),
    );
    if (source === undefined || source.thumbnail.isEmpty()) {
      throw new Error(
        "The targeted window is not available for scoped capture; grant Screen Recording permission and ensure the window is on-screen",
      );
    }
    await mkdir(this.#artifactDirectory, { recursive: true, mode: 0o700 });
    const artifactPath = path.join(
      this.#artifactDirectory,
      `${randomUUID()}.png`,
    );
    const png = source.thumbnail.toPNG();
    await writeFile(artifactPath, png, { mode: 0o600 });
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const timer = setTimeout(() => {
      this.#expiryTimers.delete(timer);
      void rm(artifactPath, { force: true });
    }, 5 * 60_000);
    timer.unref();
    this.#expiryTimers.add(timer);
    const size = source.thumbnail.getSize();
    return {
      artifactPath,
      target: resolved.target,
      width: size.width,
      height: size.height,
      bytes: png.length,
      expiresAt: expiresAt.toISOString(),
    };
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

class MacForegroundInputDriver {
  readonly #directory: string;
  #executable: Promise<string> | undefined;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async run(
    request: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const executable = await (this.#executable ??= this.#compile());
    await runProcess(executable, [], 10_000, JSON.stringify(request), signal);
  }

  async prepare(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await (this.#executable ??= this.#compile());
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

  async run(request: Record<string, unknown>): Promise<unknown> {
    const executable = await (this.#executable ??= this.#compile());
    const output = await runProcess(
      executable,
      [],
      10_000,
      JSON.stringify(request),
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

const MAC_ACCESSIBILITY_SOURCE = `import AppKit
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

func isSecure(_ element: AXUIElement) -> Bool {
  let semantics = (textAttribute(element, kAXRoleAttribute) + " " + textAttribute(element, kAXSubroleAttribute)).lowercased()
  return semantics.contains("secure") || semantics.contains("password")
}

func frameFingerprint(_ element: AXUIElement) -> String {
  guard let rawPosition = attribute(element, kAXPositionAttribute),
        let rawSize = attribute(element, kAXSizeAttribute),
        CFGetTypeID(rawPosition) == AXValueGetTypeID(),
        CFGetTypeID(rawSize) == AXValueGetTypeID() else { return "" }
  let positionValue = unsafeBitCast(rawPosition, to: AXValue.self)
  let sizeValue = unsafeBitCast(rawSize, to: AXValue.self)
  var position = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(positionValue, .cgPoint, &position),
        AXValueGetValue(sizeValue, .cgSize, &size) else { return "" }
  return String(format: "%.1f,%.1f,%.1f,%.1f", position.x, position.y, size.width, size.height)
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
  fail("macOS Accessibility permission is required for background-safe computer operations")
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

func selector(_ element: AXUIElement) -> [String: String] {
  var result: [String: String] = [:]
  let identifier = textAttribute(element, kAXIdentifierAttribute)
  let role = textAttribute(element, kAXRoleAttribute)
  let subrole = textAttribute(element, kAXSubroleAttribute)
  let title = textAttribute(element, kAXTitleAttribute)
  let description = textAttribute(element, kAXDescriptionAttribute)
  let frame = frameFingerprint(element)
  if !identifier.isEmpty { result["identifier"] = identifier }
  if !role.isEmpty { result["role"] = role }
  if !subrole.isEmpty { result["subrole"] = subrole }
  if !title.isEmpty { result["title"] = title }
  if !description.isEmpty { result["description"] = description }
  if !frame.isEmpty { result["frame"] = frame }
  return result
}

func matches(_ element: AXUIElement, _ wanted: [String: Any]) -> Bool {
  if let value = string(wanted["identifier"]), textAttribute(element, kAXIdentifierAttribute) != value { return false }
  if let value = string(wanted["role"]), textAttribute(element, kAXRoleAttribute) != value { return false }
  if let value = string(wanted["subrole"]), textAttribute(element, kAXSubroleAttribute) != value { return false }
  if let value = string(wanted["title"]), textAttribute(element, kAXTitleAttribute) != value { return false }
  if let value = string(wanted["description"]), textAttribute(element, kAXDescriptionAttribute) != value { return false }
  if let value = string(wanted["frame"]), frameFingerprint(element) != value { return false }
  return string(wanted["identifier"]) != nil || string(wanted["role"]) != nil || string(wanted["subrole"]) != nil || string(wanted["title"]) != nil || string(wanted["description"]) != nil || string(wanted["frame"]) != nil
}

func walk(_ root: AXUIElement, limit: Int = 120) -> ([AXUIElement], Bool) {
  var queue: [(AXUIElement, Int)] = [(root, 0)]
  var result: [AXUIElement] = []
  while !queue.isEmpty && result.count < limit {
    let (element, depth) = queue.removeFirst()
    result.append(element)
    if depth < 8 { queue.append(contentsOf: children(element).map { ($0, depth + 1) }) }
  }
  return (result, !queue.isEmpty)
}

func findControl(_ wanted: [String: Any]) -> AXUIElement {
  let (elements, _) = walk(root)
  let found = elements.filter { matches($0, wanted) }
  if found.isEmpty { fail("accessibility control was not found") }
  if found.count > 1 { fail("accessibility selector is ambiguous") }
  return found[0]
}

var response: [String: Any]
switch operation {
case "inspect":
  let (elements, truncated) = walk(root)
  let controls = elements.compactMap { element -> [String: Any]? in
    let controlSelector = selector(element)
    if controlSelector.isEmpty { return nil }
    var supportedActions = actions(element)
    if isSettable(element, kAXValueAttribute) { supportedActions.append("AXSetValue") }
    return [
      "selector": controlSelector,
      "role": textAttribute(element, kAXRoleAttribute),
      "title": textAttribute(element, kAXTitleAttribute),
      "enabled": boolAttribute(element, kAXEnabledAttribute),
      "actions": supportedActions.sorted(),
      "secure": isSecure(element)
    ]
  }
  response = ["target": resolvedTarget, "controls": controls, "truncated": truncated]
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
  if isSecure(element) { fail("password or secure controls reject AXValue; typing tools are non-secret-only") }
  var settable: DarwinBoolean = false
  guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else {
    fail("control does not support background-safe AXValue; foreground_required")
  }
  let error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
  guard error == .success else { fail("AXValue failed with error " + String(error.rawValue)) }
  response = ["target": resolvedTarget, "control": selector(element), "characterCount": value.count]
case "resolveWindow":
  guard let title = requestedWindowTitle else { fail("windowTitle is required") }
  let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  guard let window = info.first(where: {
    ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == running.processIdentifier &&
    ($0[kCGWindowName as String] as? String ?? "") == title
  }), let number = window[kCGWindowNumber as String] as? NSNumber else { fail("target window is not available for scoped capture") }
  response = ["target": resolvedTarget, "windowId": number]
default:
  fail("unsupported accessibility operation")
}

guard let output = try? JSONSerialization.data(withJSONObject: response) else { fail("could not encode response") }
FileHandle.standardOutput.write(output)
`;

const MAC_FOREGROUND_INPUT_SOURCE = `import ApplicationServices
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\\n").utf8))
  exit(1)
}

guard AXIsProcessTrusted() else {
  fail("macOS Accessibility permission is required for foreground takeover")
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

async function runProcess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  stdin?: string,
  signal?: AbortSignal,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
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

function foregroundTools(): ZenXCapabilityManifest["tools"] {
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
  const windowTitle = optionalString(raw, "windowTitle");
  if (
    pid === undefined &&
    applicationId === undefined &&
    bundleId === undefined
  ) {
    throw new Error("target requires pid, applicationId, or bundleId");
  }
  if (windowTitle !== undefined && windowTitle.length > 256) {
    throw new Error("target.windowTitle is limited to 256 characters");
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
