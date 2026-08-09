import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ToolInvocation } from "../../../../../src/tool.js";
import type { ZenXCapabilityManifest, ZenXCapabilityPackage } from "./types.js";

export interface ComputerState {
  platform: NodeJS.Platform;
  frontmostApplication: string;
  frontmostWindowTitle: string;
  cursor: { x: number; y: number };
  displays: Array<{
    id: string;
    bounds: { x: number; y: number; width: number; height: number };
    scaleFactor: number;
  }>;
}

export interface ZenXComputerBackend {
  inspect(): Promise<ComputerState>;
  screenshot(sourceId?: string): Promise<{
    artifactPath: string;
    sourceId: string;
    sourceName: string;
    width: number;
    height: number;
    bytes: number;
    expiresAt: string;
  }>;
  click(x: number, y: number, button: "left" | "right"): Promise<ComputerState>;
  type(text: string): Promise<ComputerState>;
  keyPress(key: ComputerKey): Promise<ComputerState>;
  scroll(deltaY: number): Promise<ComputerState>;
  close(): Promise<void> | void;
}

type ComputerKey =
  | "enter"
  | "escape"
  | "tab"
  | "backspace"
  | "space"
  | "arrowUp"
  | "arrowDown"
  | "arrowLeft"
  | "arrowRight";

export const computerCapabilityManifest: ZenXCapabilityManifest = {
  schemaVersion: 1,
  id: "computer",
  displayName: "Computer",
  version: "1.0.0",
  description:
    "Auditable macOS screen inspection and narrow pointer, keyboard, and scroll operations with explicit target context.",
  permissions: [
    {
      id: "computer.screen.inspect",
      title: "Inspect screen state",
      description:
        "Read display geometry, cursor location, and the frontmost app/window title.",
      scope: "local-device",
    },
    {
      id: "computer.screen.capture",
      title: "Capture a screenshot",
      description:
        "Capture one explicitly selected display to a private short-lived artifact file.",
      scope: "local-device",
    },
    {
      id: "computer.pointer.control",
      title: "Control pointer and scrolling",
      description:
        "Click explicit screen coordinates and issue bounded page scrolling.",
      scope: "local-device",
    },
    {
      id: "computer.keyboard.control",
      title: "Control keyboard",
      description:
        "Type explicit text or press one allowlisted key in the frontmost application.",
      scope: "local-device",
    },
  ],
  tools: [
    {
      name: "computer_inspect",
      description:
        "Inspect current app/window identity, display bounds, and cursor position without capturing pixels or unrelated screen content.",
      inputSchema: objectSchema({}, []),
      permissions: ["computer.screen.inspect"],
    },
    {
      name: "computer_screenshot",
      description:
        "Capture one selected display to a private short-lived PNG artifact. Returns metadata and a path, never base64 screen pixels in the Thread journal.",
      inputSchema: objectSchema({ sourceId: stringSchema() }, []),
      permissions: ["computer.screen.capture"],
      maxOutputBytes: 4 * 1024,
    },
    {
      name: "computer_click",
      description:
        "Click explicit global screen coordinates. context must state the app/window/control expected at that point for auditability.",
      inputSchema: objectSchema(
        {
          x: numberSchema(),
          y: numberSchema(),
          button: { type: "string", enum: ["left", "right"] },
          context: stringSchema(),
        },
        ["x", "y", "context"],
      ),
      permissions: ["computer.pointer.control"],
    },
    {
      name: "computer_type",
      description:
        "Type text into the frontmost control. context must identify the intended app/window/control; output records only character count, not typed text.",
      inputSchema: objectSchema(
        { text: stringSchema(), context: stringSchema() },
        ["text", "context"],
      ),
      permissions: ["computer.keyboard.control"],
    },
    {
      name: "computer_key_press",
      description:
        "Press one allowlisted key in the frontmost control with explicit target context.",
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
          context: stringSchema(),
        },
        ["key", "context"],
      ),
      permissions: ["computer.keyboard.control"],
    },
    {
      name: "computer_scroll",
      description:
        "Issue a bounded page scroll to the frontmost window. Positive deltaY scrolls down; context identifies the intended target.",
      inputSchema: objectSchema(
        { deltaY: numberSchema(), context: stringSchema() },
        ["deltaY", "context"],
      ),
      permissions: ["computer.pointer.control"],
    },
  ],
  resources: [
    {
      id: "inspect-before-act",
      kind: "skill",
      title: "Inspect before computer actions",
      description: "Instructions for auditable, targeted desktop actions.",
      content:
        "Call computer_inspect before an input action and include the observed application, window, and intended control in context. Prefer browser structured tools for web pages. Use screenshots only when state metadata is insufficient. Re-inspect after actions that can change focus, and stop if the observed context differs from the intended target.",
    },
  ],
};

export class ComputerZenXCapabilityPackage implements ZenXCapabilityPackage {
  readonly manifest = computerCapabilityManifest;
  readonly #backend: ZenXComputerBackend;

  constructor(backend: ZenXComputerBackend) {
    this.#backend = backend;
  }

  async invoke(toolName: string, invocation: ToolInvocation): Promise<unknown> {
    switch (toolName) {
      case "computer_inspect":
        return await this.#backend.inspect();
      case "computer_screenshot":
        return await this.#backend.screenshot(
          optionalString(invocation.arguments, "sourceId"),
        );
      case "computer_click": {
        const context = requiredContext(invocation.arguments);
        const x = requiredFiniteNumber(invocation.arguments, "x");
        const y = requiredFiniteNumber(invocation.arguments, "y");
        const button = optionalString(invocation.arguments, "button") ?? "left";
        if (button !== "left" && button !== "right") {
          throw new Error("button must be left or right");
        }
        const state = await this.#backend.click(x, y, button);
        return { action: { x, y, button, context }, state };
      }
      case "computer_type": {
        const context = requiredContext(invocation.arguments);
        const text = requiredString(invocation.arguments, "text", true);
        if (text.length > 4_000)
          throw new Error("computer_type text is limited to 4000 characters");
        const state = await this.#backend.type(text);
        return { action: { characterCount: text.length, context }, state };
      }
      case "computer_key_press": {
        const context = requiredContext(invocation.arguments);
        const key = requiredComputerKey(invocation.arguments);
        const state = await this.#backend.keyPress(key);
        return { action: { key, context }, state };
      }
      case "computer_scroll": {
        const context = requiredContext(invocation.arguments);
        const deltaY = requiredFiniteNumber(invocation.arguments, "deltaY");
        if (Math.abs(deltaY) > 10_000 || deltaY === 0) {
          throw new Error(
            "deltaY must be between -10000 and 10000 and non-zero",
          );
        }
        const state = await this.#backend.scroll(deltaY);
        return { action: { deltaY, context }, state };
      }
      default:
        throw new Error(`Unsupported computer tool: ${toolName}`);
    }
  }

  async close(): Promise<void> {
    await this.#backend.close();
  }
}

export class ElectronMacComputerBackend implements ZenXComputerBackend {
  readonly #artifactDirectory: string;
  readonly #expiryTimers = new Set<NodeJS.Timeout>();
  readonly #inputDriver: MacInputDriver;

  constructor(
    artifactDirectory = path.join(
      os.tmpdir(),
      `zenx-capability-artifacts-${String(process.pid)}`,
    ),
  ) {
    this.#artifactDirectory = artifactDirectory;
    this.#inputDriver = new MacInputDriver(artifactDirectory);
  }

  async inspect(): Promise<ComputerState> {
    requireMacOs();
    const { screen } = await import("electron");
    const [frontmostApplication, frontmostWindowTitle] =
      await frontmostContext();
    return {
      platform: process.platform,
      frontmostApplication,
      frontmostWindowTitle,
      cursor: screen.getCursorScreenPoint(),
      displays: screen.getAllDisplays().map((display) => ({
        id: String(display.id),
        bounds: display.bounds,
        scaleFactor: display.scaleFactor,
      })),
    };
  }

  async screenshot(sourceId?: string): Promise<{
    artifactPath: string;
    sourceId: string;
    sourceName: string;
    width: number;
    height: number;
    bytes: number;
    expiresAt: string;
  }> {
    requireMacOs();
    const { desktopCapturer, screen } = await import("electron");
    const primary = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.min(1600, Math.max(1, primary.size.width)),
        height: Math.min(1000, Math.max(1, primary.size.height)),
      },
      fetchWindowIcons: false,
    });
    const source =
      sourceId === undefined
        ? sources[0]
        : sources.find((candidate) => candidate.id === sourceId);
    if (source === undefined) {
      throw new Error(
        sourceId === undefined
          ? "No screen capture source is available; grant Screen Recording permission"
          : `Unknown screen source: ${sourceId}`,
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
      sourceId: source.id,
      sourceName: source.name.slice(0, 160),
      width: size.width,
      height: size.height,
      bytes: png.length,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async click(
    x: number,
    y: number,
    button: "left" | "right",
  ): Promise<ComputerState> {
    requireMacOs();
    await assertPointOnDisplay(x, y);
    await this.#inputDriver.run("click", [
      String(Math.round(x)),
      String(Math.round(y)),
      button,
    ]);
    return await this.inspect();
  }

  async type(text: string): Promise<ComputerState> {
    requireMacOs();
    await this.#inputDriver.run("type", [], text);
    return await this.inspect();
  }

  async keyPress(key: ComputerKey): Promise<ComputerState> {
    requireMacOs();
    await this.#inputDriver.run("key", [String(KEY_CODES[key])]);
    return await this.inspect();
  }

  async scroll(deltaY: number): Promise<ComputerState> {
    requireMacOs();
    await this.#inputDriver.run("scroll", [String(-Math.round(deltaY))]);
    return await this.inspect();
  }

  async close(): Promise<void> {
    for (const timer of this.#expiryTimers) clearTimeout(timer);
    this.#expiryTimers.clear();
    await rm(this.#artifactDirectory, { recursive: true, force: true });
  }
}

class MacInputDriver {
  readonly #directory: string;
  #executable: Promise<string> | undefined;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async run(
    operation: string,
    args: readonly string[],
    stdin?: string,
  ): Promise<void> {
    const executable = await (this.#executable ??= this.#compile());
    await runProcess(executable, [operation, ...args], 10_000, stdin);
  }

  async #compile(): Promise<string> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const sourcePath = path.join(this.#directory, "zenx-computer-input.swift");
    const executablePath = path.join(this.#directory, "zenx-computer-input");
    await writeFile(sourcePath, MAC_INPUT_SOURCE, {
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

const MAC_INPUT_SOURCE = `import ApplicationServices
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\\n").utf8))
  exit(1)
}

guard AXIsProcessTrusted() else {
  fail("macOS Accessibility permission is required for computer input")
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else { fail("missing input operation") }
let operation = arguments[1]

func postKey(_ keyCode: CGKeyCode) {
  CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true)?.post(tap: .cghidEventTap)
  usleep(20_000)
  CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)?.post(tap: .cghidEventTap)
}

switch operation {
case "click":
  guard arguments.count == 5,
        let x = Double(arguments[2]),
        let y = Double(arguments[3]) else { fail("invalid click arguments") }
  let right = arguments[4] == "right"
  let point = CGPoint(x: x, y: y)
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(40_000)
  let button: CGMouseButton = right ? .right : .left
  let down: CGEventType = right ? .rightMouseDown : .leftMouseDown
  let up: CGEventType = right ? .rightMouseUp : .leftMouseUp
  CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
  usleep(40_000)
  CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
case "type":
  guard arguments.count == 2,
        let text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) else {
    fail("invalid type input")
  }
  let units = Array(text.utf16)
  guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
    fail("could not create keyboard event")
  }
  units.withUnsafeBufferPointer { buffer in
    down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress)
    up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress)
  }
  down.post(tap: .cghidEventTap)
  usleep(20_000)
  up.post(tap: .cghidEventTap)
case "key":
  guard arguments.count == 3, let code = UInt16(arguments[2]) else { fail("invalid key arguments") }
  postKey(code)
case "scroll":
  guard arguments.count == 3, let delta = Int32(arguments[2]) else { fail("invalid scroll arguments") }
  CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
default:
  fail("unsupported input operation")
}
`;

const KEY_CODES: Record<ComputerKey | "pageUp" | "pageDown", number> = {
  enter: 36,
  escape: 53,
  tab: 48,
  backspace: 51,
  space: 49,
  arrowUp: 126,
  arrowDown: 125,
  arrowLeft: 123,
  arrowRight: 124,
  pageUp: 116,
  pageDown: 121,
};

async function frontmostContext(): Promise<[string, string]> {
  const output = await runAppleScript(
    [
      'tell application "System Events"',
      "set frontProcess to first application process whose frontmost is true",
      "set appName to name of frontProcess",
      'set windowName to ""',
      "try",
      "set windowName to name of front window of frontProcess",
      "end try",
      "return appName & linefeed & windowName",
      "end tell",
    ],
    [],
  );
  const [application = "", windowTitle = ""] = output.trimEnd().split("\n", 2);
  return [application.slice(0, 160), windowTitle.slice(0, 256)];
}

async function runAppleScript(
  lines: readonly string[],
  args: readonly string[],
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const scriptArgs = lines.flatMap((line) => ["-e", line]);
    const child = spawn("/usr/bin/osascript", [...scriptArgs, ...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else {
        reject(
          new Error(
            `macOS Automation failed (${String(code)}): ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 1024)}`,
          ),
        );
      }
    });
  });
}

async function runProcess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  stdin?: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "pipe"],
    });
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
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    if (stdin !== undefined) child.stdin?.end(stdin, "utf8");
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => {
      finish(() => {
        if (code === 0) resolve();
        else {
          reject(
            new Error(
              `${path.basename(command)} failed (${signal ?? String(code)}): ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 2048)}`,
            ),
          );
        }
      });
    });
  });
}

async function assertPointOnDisplay(x: number, y: number): Promise<void> {
  const { screen } = await import("electron");
  const valid = screen
    .getAllDisplays()
    .some(
      ({ bounds }) =>
        x >= bounds.x &&
        y >= bounds.y &&
        x < bounds.x + bounds.width &&
        y < bounds.y + bounds.height,
    );
  if (!valid)
    throw new Error(`Point ${String(x)},${String(y)} is outside every display`);
}

function requireMacOs(): void {
  if (process.platform !== "darwin") {
    throw new Error(
      "The bundled computer provider currently supports macOS only",
    );
  }
}

function requiredContext(arguments_: Record<string, unknown>): string {
  const value = requiredString(arguments_, "context");
  if (value.length > 500)
    throw new Error("context is limited to 500 characters");
  return value;
}

function requiredComputerKey(arguments_: Record<string, unknown>): ComputerKey {
  const value = requiredString(arguments_, "key");
  if (!(value in KEY_CODES) || value === "pageUp" || value === "pageDown") {
    throw new Error(`Unsupported computer key: ${value}`);
  }
  return value as ComputerKey;
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
  arguments_: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = arguments_[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function stringSchema(): Record<string, unknown> {
  return { type: "string" };
}

function numberSchema(): Record<string, unknown> {
  return { type: "number" };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}
