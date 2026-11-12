import assert from "node:assert/strict";
import test from "node:test";
import { MacForegroundInputDriver } from "../src/main/capabilities/computer-provider.js";

test("macOS scroll rejects zero after native pixel rounding before preparation or dispatch", async () => {
  const calls: string[] = [];
  const driver = new MacForegroundInputDriver("/unused", {
    compile: async () => {
      calls.push("compile");
      return "/fake/helper";
    },
    runProcess: async () => {
      calls.push("dispatch");
      return "";
    },
  });
  for (const deltaY of [0, 0.1, -0.1, -0.5, NaN, Infinity, 10_001]) {
    await assert.rejects(
      driver.run({ operation: "scroll", deltaY }, new AbortController().signal),
      /scroll deltaY/u,
    );
  }
  assert.deepEqual(calls, []);
});

test("macOS scroll dispatches the validated rounded pixel amount once", async () => {
  const sent: unknown[] = [];
  const driver = new MacForegroundInputDriver("/unused", {
    compile: async () => "/fake/helper",
    runProcess: async (_command, _args, _timeout, stdin) => {
      sent.push(JSON.parse(stdin!));
      return "";
    },
  });
  for (const deltaY of [0.6, -0.6, 10000, -10000]) {
    await driver.run(
      { operation: "scroll", deltaY },
      new AbortController().signal,
    );
  }
  assert.deepEqual(
    sent,
    [1, -1, 10000, -10000].map((deltaY) => ({ operation: "scroll", deltaY })),
  );
});

// This executes the shipped Swift control flow against recording API doubles.
// It never loads ApplicationServices or posts input to a desktop.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAC_FOREGROUND_INPUT_SOURCE } from "../src/main/capabilities/computer-provider.js";

const recordingCoreGraphics = `
import Foundation
func AXIsProcessTrusted() -> Bool { true }
typealias CGKeyCode = UInt16
enum CGMouseButton { case left, right }
enum CGEventType: String { case mouseMoved, leftMouseDown, leftMouseUp, rightMouseDown, rightMouseUp }
enum CGEventTapLocation { case cghidEventTap }
enum CGScrollEventUnit { case pixel }
var allocations = 0
func allocationAllowed() -> Bool {
  allocations += 1
  return allocations != Int(ProcessInfo.processInfo.environment["FAIL_ALLOCATION"] ?? "0")
}
final class CGEvent {
  let label: String
  init?(keyboardEventSource: Any?, virtualKey: CGKeyCode, keyDown: Bool) {
    guard allocationAllowed() else { return nil }
    label = keyDown ? "keyDown" : "keyUp"
  }
  init?(mouseEventSource: Any?, mouseType: CGEventType, mouseCursorPosition: CGPoint, mouseButton: CGMouseButton) {
    guard allocationAllowed() else { return nil }
    label = mouseType.rawValue
  }
  init?(scrollWheelEvent2Source: Any?, units: CGScrollEventUnit, wheelCount: UInt32, wheel1: Int32, wheel2: Int32, wheel3: Int32) {
    guard allocationAllowed() else { return nil }
    label = "scroll:\\(wheel1)"
  }
  func post(tap: CGEventTapLocation) { print(label) }
}
`;

test(
  "native input preserves construction/post order and reports every allocation failure",
  { skip: process.platform !== "darwin", timeout: 60_000 },
  (t) => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "zenx-input-contract-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const source = path.join(directory, "main.swift");
    const executable = path.join(directory, "input-contract");
    assert.ok(
      MAC_FOREGROUND_INPUT_SOURCE.startsWith("import ApplicationServices\n"),
    );
    writeFileSync(
      source,
      MAC_FOREGROUND_INPUT_SOURCE.replace(
        "import ApplicationServices",
        recordingCoreGraphics,
      ),
    );
    const compilation = spawnSync(
      "/usr/bin/swiftc",
      [source, "-o", executable],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(
      compilation.status,
      0,
      compilation.stderr || compilation.error?.message,
    );
    const cases = [
      {
        request: { operation: "key", key: "enter" },
        output: ["keyDown", "keyUp"],
      },
      {
        request: { operation: "click", x: -10, y: 20, button: "left" },
        output: ["mouseMoved", "leftMouseDown", "leftMouseUp"],
      },
      {
        request: { operation: "click", x: 10, y: 20, button: "right" },
        output: ["mouseMoved", "rightMouseDown", "rightMouseUp"],
      },
      {
        request: { operation: "scroll", deltaY: 120 },
        output: ["scroll:-120"],
      },
      {
        request: { operation: "scroll", deltaY: -120 },
        output: ["scroll:120"],
      },
    ];
    for (const { request, output } of cases) {
      for (let failure = 0; failure <= output.length; failure += 1) {
        const result = spawnSync(executable, [], {
          input: JSON.stringify(request),
          encoding: "utf8",
          timeout: 5_000,
          env: { ...process.env, FAIL_ALLOCATION: String(failure) },
        });
        if (failure === 0) {
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(result.stdout.trim().split("\n"), output);
        } else {
          assert.equal(result.status, 1, result.stderr);
          assert.deepEqual(
            result.stdout.trim() ? result.stdout.trim().split("\n") : [],
            output.slice(0, failure - 1),
            `allocation ${failure} must preserve the original posted prefix for ${request.operation}`,
          );
          assert.match(result.stderr, /could not construct/u);
          assert.match(
            result.stderr,
            failure === 1
              ? /no events dispatched/u
              : /dispatched; outcome unknown; do not retry automatically/u,
          );
        }
      }
    }
    for (const deltaY of [0, 0.1, -0.1, 10_001, -10_001]) {
      const result = spawnSync(executable, [], {
        input: JSON.stringify({ operation: "scroll", deltaY }),
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /invalid scroll request/u);
    }
  },
);
