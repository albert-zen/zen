import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { MAC_BOUND_TARGET_SOURCE } from "../src/main/capabilities/computer-provider.js";

// Platform API doubles only. Binding, activation, focus fences, event sequencing,
// errors and JSONL dispatch are the shipped Swift implementation. No OS events.
const platform = `
import Foundation
import CoreGraphics
var fixtureOperation = ""
let mode = ProcessInfo.processInfo.environment["FIXTURE_MODE"] ?? "normal"
var posted = 0
final class AXUIElement: NSObject {
  let id: Int
  init(_ id: Int) { self.id = id }
}
let original = AXUIElement(17)
let replacement = AXUIElement(18)
let appElement = AXUIElement(42)
var selectedWindow = original
let kAXWindowsAttribute = "windows"
let kAXTitleAttribute = "title"
let kAXFocusedWindowAttribute = "focused"
let kAXRaiseAction = "raise"
let kAXRoleAttribute = "role"
let kAXWindowRole = "window"
let kAXWindowAttribute = "window"
let kCGWindowAlpha = "alpha"
let kCGWindowBounds = "bounds"
let kCGWindowNumber = "number"
let kCGWindowOwnerPID = "owner"
let kCGNullWindowID = 0
enum WindowListOption { case optionOnScreenOnly, excludeDesktopElements }
func fixtureWindowList(_ options: [WindowListOption], _ id: Int) -> Any? {
  let window: [String: Any] = ["alpha": 1.0, "bounds": ["X": -100.0, "Y": 20.0, "Width": 400.0, "Height": 200.0], "number": NSNumber(value: 17)]
  if mode == "pointer-missing" { return [] }
  if mode == "pointer-ambiguous" { return [["alpha": 1.0]] }
  if mode == "pointer-trusted-edge" || mode == "pointer-forged-edge" || mode == "pointer-status-over-edge" {
    var edge = window; edge["number"] = NSNumber(value: 19); edge["owner"] = NSNumber(value: mode == "pointer-forged-edge" ? getppid() + 1 : getppid())
    if mode == "pointer-status-over-edge" { var status = edge; status["number"] = NSNumber(value: 20); return [status, edge, window] }
    return [edge, window]
  }
  if mode == "pointer-overlay" || mode == "pointer-transparent-overlay" || mode == "scroll-overlay" || (mode == "pointer-late-overlay" && posted >= 2) {
    var overlay = window; overlay["number"] = NSNumber(value: 18)
    if mode == "pointer-transparent-overlay" { overlay["alpha"] = 0.0 }
    return [overlay, window]
  }
  return [window]
}
func AXUIElementCreateSystemWide() -> AXUIElement { appElement }
func AXUIElementCopyElementAtPosition(_ root: AXUIElement, _ x: Float, _ y: Float, _ hit: inout AXUIElement?) -> AXError {
  if mode == "pointer-no-ax-hit" { return .failure }
  hit = mode == "pointer-wrong-ax-window" ? replacement : original
  return .success
}
enum AXError { case success, failure }
func AXIsProcessTrusted() -> Bool { true }
func AXUIElementCreateApplication(_ pid: Int32) -> AXUIElement { appElement }
func AXUIElementPerformAction(_ window: AXUIElement, _ action: String) -> AXError {
  selectedWindow = mode == "wrong-window" ? replacement : window
  return .success
}
func fixtureEqual(_ a: AnyObject, _ b: AnyObject) -> Bool { a === b }
func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
  if name == "role" { return "window" as NSString }
  if name == "title" { return "Fixture" as NSString }
  if name == "focused" { return selectedWindow }
  return nil
}
func windows(_ app: AXUIElement) -> [AXUIElement] {
  if fixtureOperation != "select" && mode == "closed" { return [] }
  if fixtureOperation != "select" && mode == "reused-id" { return [replacement] }
  return [original]
}
func frame(_ window: AXUIElement) -> CGRect? {
  CGRect(x: -100, y: 20, width: fixtureOperation != "select" && mode == "resize" ? 401 : 400, height: 200)
}
func cgId(_ app: NSRunningApplication, _ window: AXUIElement, _ bounds: CGRect) throws -> Int { 17 }
final class NSRunningApplication {
  let processIdentifier: Int32
  init?(processIdentifier: Int32) { self.processIdentifier = processIdentifier }
  var launchDate: Date? { Date(timeIntervalSince1970: fixtureOperation != "select" && mode == "restarted" ? 2 : 1) }
  var isTerminated: Bool { false }
  var bundleIdentifier: String? { "fixture.app" }
  var localizedName: String? { "Fixture" }
  enum ActivationOption { case activateIgnoringOtherApps }
  func activate(options: [ActivationOption]) -> Bool { mode != "activation-failed" }
}
final class NSWorkspace {
  static let shared = NSWorkspace()
  var runningApplications: [NSRunningApplication] { [NSRunningApplication(processIdentifier: 42)!] }
  var frontmostApplication: NSRunningApplication? {
    if ["focus-stolen", "typing-focus-stolen"].contains(mode) && posted >= 1 { return NSRunningApplication(processIdentifier: 99) }
    return NSRunningApplication(processIdentifier: 42)
  }
}
func fixtureSleep(_ value: UInt32) {}
typealias CGKeyCode = UInt16
enum CGMouseButton { case left, right }
enum CGEventType: String { case mouseMoved, leftMouseDown, leftMouseUp, rightMouseDown, rightMouseUp }
enum CGEventTapLocation { case cghidEventTap }
enum CGScrollEventUnit { case pixel }
struct CGEventFlags: OptionSet {
  let rawValue: UInt64
  static let maskCommand = CGEventFlags(rawValue: 1 << 20)
  static let maskControl = CGEventFlags(rawValue: 1 << 18)
  static let maskAlternate = CGEventFlags(rawValue: 1 << 19)
  static let maskShift = CGEventFlags(rawValue: 1 << 17)
}
final class CGEvent {
  var flags: CGEventFlags = []
  var label: String
  var location = CGPoint.zero
  init?(keyboardEventSource: Any?, virtualKey: CGKeyCode, keyDown: Bool) { label = (keyDown ? "down:" : "up:") + String(virtualKey) }
  init?(mouseEventSource: Any?, mouseType: CGEventType, mouseCursorPosition: CGPoint, mouseButton: CGMouseButton) { label = mouseType.rawValue }
  init?(scrollWheelEvent2Source: Any?, units: CGScrollEventUnit, wheelCount: UInt32, wheel1: Int32, wheel2: Int32, wheel3: Int32) { label = "scroll" }
  func keyboardSetUnicodeString(stringLength: Int, unicodeString: UnsafePointer<UniChar>?) { label += ":unicode=" + String(stringLength) }
  func post(tap: CGEventTapLocation) {
    posted += 1
    FileHandle.standardError.write(Data(("POST:" + label + ":flags=" + String(flags.rawValue) + "\\n").utf8))
  }
}
`;

test(
  "native target helper guards retained window, focus, geometry and partial effects",
  { skip: process.platform !== "darwin", timeout: 90_000 },
  async (t) => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "zenx-bound-fixture-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const source = path.join(directory, "fixture.swift");
    const binary = path.join(directory, "fixture");
    const start = MAC_BOUND_TARGET_SOURCE.indexOf("func attribute(");
    const end = MAC_BOUND_TARGET_SOURCE.indexOf("func pointerWindow(");
    assert.ok(start > 0 && end > start);
    const withoutPlatform = (
      MAC_BOUND_TARGET_SOURCE.slice(0, start) +
      MAC_BOUND_TARGET_SOURCE.slice(end)
    )
      .replace("import AppKit\nimport ApplicationServices", platform)
      .replaceAll(" as CFString", "")
      .replaceAll("CFEqual(", "fixtureEqual(")
      .replaceAll("usleep(", "fixtureSleep(")
      .replaceAll("CGWindowListCopyWindowInfo(", "fixtureWindowList(")
      .replace(
        "CFGetTypeID(window) == AXUIElementGetTypeID()",
        "window is AXUIElement",
      )
      .replace(
        "CFGetTypeID(focused) == AXUIElementGetTypeID()",
        "focused is AXUIElement",
      )
      .replace(
        "owner = requestedOwner",
        "owner = requestedOwner\n    fixtureOperation = operation",
      );
    const keyboardStart = withoutPlatform.indexOf("func readKeyboardLayout()");
    const keyboardEnd = withoutPlatform.indexOf("func resolveShortcut(");
    assert.ok(keyboardStart > 0 && keyboardEnd > keyboardStart);
    const transformed = (
      withoutPlatform.slice(0, keyboardStart) +
      `func readKeyboardLayout() throws -> KeyboardLayout {
      return KeyboardLayout(id: mode == "layout-changed" && posted >= 1 ? "new-layout" : "fixture-layout", translate: { code, command in
        let mapped: CGKeyCode = command ? (mode == "layout-remapped" && posted >= 1 ? 13 : 12) : 0
        return code == mapped || (mode == "shortcut-ambiguous" && code == 0) ? "a" : ""
      })
    }
    ` +
      withoutPlatform.slice(keyboardEnd)
    ).replace("import Carbon", "");
    writeFileSync(source, transformed);
    const compilation = spawnSync("/usr/bin/swiftc", [source, "-o", binary], {
      encoding: "utf8",
      timeout: 45_000,
    });
    assert.equal(compilation.status, 0, compilation.stderr);
    for (const mode of [
      "normal",
      "wrong-window",
      "closed",
      "reused-id",
      "resize",
      "restarted",
      "activation-failed",
      "focus-stolen",
      "typing",
      "typing-focus-stolen",
      "shortcut-alt",
      "shortcut-option",
      "layout-changed",
      "layout-remapped",
      "shortcut-ambiguous",
      "pointer-normal",
      "pointer-overlay",
      "pointer-transparent-overlay",
      "pointer-late-overlay",
      "pointer-missing",
      "pointer-ambiguous",
      "pointer-wrong-ax-window",
      "pointer-no-ax-hit",
      "pointer-trusted-edge",
      "pointer-forged-edge",
      "pointer-status-over-edge",
      "scroll-normal",
      "scroll-overlay",
    ]) {
      const child = spawn(binary, [], {
        env: { ...process.env, FIXTURE_MODE: mode },
      });
      const lines = createInterface({ input: child.stdout })[
        Symbol.asyncIterator
      ]();
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const request = async (value: object) => {
        child.stdin.write(JSON.stringify(value) + "\n");
        const line = await lines.next();
        assert.equal(line.done, false, stderr);
        return JSON.parse(line.value!) as {
          result?: { bindingId: string };
          error?: string;
        };
      };
      try {
        const selected = await request({
          operation: "select",
          owner: "thread-a",
          target: { pid: 42, windowTitle: "Fixture" },
        });
        assert.ok(selected.result?.bindingId, JSON.stringify(selected));
        if (mode === "normal") {
          const next = await request({
            operation: "select",
            owner: "thread-a",
            target: { pid: 42, windowTitle: "Fixture" },
          });
          const stale = await request({
            operation: "verify",
            owner: "thread-a",
            bindingId: selected.result.bindingId,
          });
          assert.match(stale.error!, /binding expired/);
          assert.ok(next.result);
          selected.result = next.result;
          const foreign = await request({
            operation: "verify",
            owner: "thread-b",
            bindingId: selected.result!.bindingId,
          });
          assert.match(foreign.error!, /binding expired/);
        }
        const input = mode.startsWith("pointer-")
          ? { operation: "click", x: 20, y: 40, button: "left" }
          : mode.startsWith("scroll-")
            ? { operation: "scroll", deltaY: 100 }
            : mode.startsWith("typing")
              ? { operation: "type", text: "a".repeat(15) + "😀" }
              : mode.startsWith("shortcut") || mode.startsWith("layout-")
                ? {
                    operation: "shortcut",
                    key: "a",
                    modifiers: [
                      mode === "shortcut-option" ? "option" : "command",
                    ],
                  }
                : { operation: "key", key: "enter" };
        const result = await request({
          ...input,
          owner: "thread-a",
          bindingId: selected.result.bindingId,
          pointerPassthroughWindowIds: mode.includes("edge") ? [19] : [],
        });
        if (
          [
            "normal",
            "typing",
            "shortcut-alt",
            "shortcut-option",
            "pointer-normal",
            "pointer-trusted-edge",
            "scroll-normal",
          ].includes(mode)
        )
          assert.equal(result.error, undefined);
        else {
          assert.match(
            result.error!,
            [
              "focus-stolen",
              "typing-focus-stolen",
              "layout-changed",
              "layout-remapped",
              "pointer-late-overlay",
            ].includes(mode)
              ? /partially dispatched; outcome unknown/
              : /no input dispatched/,
          );
          const retry = await request({
            operation: "key",
            key: "enter",
            owner: "thread-a",
            bindingId: selected.result.bindingId,
          });
          assert.match(retry.error!, /binding expired/);
        }
        child.stdin.end();
        await new Promise<void>((resolve) =>
          child.once("close", () => resolve()),
        );
        assert.equal(
          (stderr.match(/POST:/g) ?? []).length,
          ["pointer-normal", "pointer-trusted-edge"].includes(mode)
            ? 3
            : mode === "scroll-normal"
              ? 1
              : mode === "pointer-late-overlay"
                ? 2
                : ["normal", "shortcut-alt", "shortcut-option"].includes(mode)
                  ? 2
                  : mode === "typing"
                    ? 4
                    : [
                          "focus-stolen",
                          "typing-focus-stolen",
                          "layout-changed",
                          "layout-remapped",
                        ].includes(mode)
                      ? 1
                      : 0,
          `${mode}: ${stderr}`,
        );
        if (mode === "typing") {
          assert.match(stderr, /unicode=15/);
          assert.match(stderr, /unicode=2/);
          assert.doesNotMatch(stderr, /unicode=16|unicode=1\n/);
        }
        if (mode === "shortcut-alt")
          assert.match(stderr, /POST:down:12:flags=1048576/);
        if (mode === "shortcut-option")
          assert.match(stderr, /POST:down:0:flags=524288/);
      } finally {
        child.kill("SIGKILL");
      }
    }
  },
);
