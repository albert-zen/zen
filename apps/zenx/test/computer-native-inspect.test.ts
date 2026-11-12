import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ComputerZenXCapabilityPackage,
  ElectronMacComputerBackend,
  MacAccessibilityDriver,
  MAC_ACCESSIBILITY_SOURCE,
  type ComputerInspection,
  type ComputerTarget,
} from "../src/main/capabilities/computer-provider.js";

const target = { pid: 7, windowTitle: "Synthetic A" };
const otherTarget = { pid: 7, windowTitle: "Synthetic B" };
const signal = new AbortController().signal;

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function rawInspection(
  selected: ComputerTarget = target,
  partial = false,
  count = 2,
) {
  return {
    target: {
      pid: 7,
      applicationName: "Synthetic",
      windowTitle: selected.windowTitle,
    },
    targetContext: { pid: 7, windowTitle: selected.windowTitle, windowId: 17 },
    controls: Array.from({ length: count }, (_, index) => ({
      selector: { role: "AXButton", title: `合成 ${index}` },
      role: "AXButton",
      title: `合成 ${index}`,
      enabled: true,
      // Deliberately leave native actions populated: the Host must independently
      // refuse grants from partial diagnostics, not trust a helper to clear them.
      actions: ["AXPress", "AXSetValue"],
      inWebArea: false,
    })),
    truncated: false,
    diagnostics: {
      visitedCount: count,
      visitLimit: 1024,
      visitLimitReached: false,
      maxDepth: 24,
      maxDepthVisited: 1,
      depthLimitReached: false,
      outputLimit: 120,
      outputLimitReached: false,
      actionableCount: count,
      semanticCount: 0,
      fallbackCount: 0,
      encounteredWebArea: false,
      webAreaControlCount: 0,
      webAreaActionableCount: 0,
      nativeRead: {
        status: partial ? ("partial" as const) : ("complete" as const),
        readCount: 20,
        errorCount: partial ? 1 : 0,
        errorCodes: partial ? [-25204] : [],
        deadlineReached: false,
        elapsedMs: 20,
        budgetMs: 9750,
      },
    },
  };
}

async function withBackend(
  run: (request: Record<string, unknown>) => Promise<unknown>,
  exercise: (backend: ElectronMacComputerBackend) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-inspect-mock-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  // Only the platform guard is changed. The injected driver never compiles,
  // launches a process, loads Electron/AppKit or addresses a real application.
  Object.defineProperty(process, "platform", { value: "darwin" });
  const backend = new ElectronMacComputerBackend(directory, { run });
  try {
    await exercise(backend);
  } finally {
    await backend.close();
    Object.defineProperty(process, "platform", platform);
    await rm(directory, { recursive: true, force: true });
  }
}

test("native inspect passes one original deadline and keeps the 10s process limit", async () => {
  const calls: Record<string, unknown>[] = [];
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  const driver = new MacAccessibilityDriver("/synthetic-unused", {
    compile: async () => {
      now = 9000;
      return "/synthetic-never-spawned";
    },
    runProcess: async (_command, _args, timeout, input) => {
      assert.equal(timeout, 10_000);
      const request = JSON.parse(input!) as Record<string, unknown>;
      calls.push(request);
      if (request.operation === "inspect") {
        assert.equal(request.inspectDeadlineUnixMs, 18_750);
      } else assert.equal(request.inspectDeadlineUnixMs, undefined);
      return "{}";
    },
  });
  try {
    await driver.run({
      operation: "inspect",
      target,
      inspectDeadlineUnixMs: 1,
    });
    await driver.run({ operation: "press", target });
    assert.equal(calls.length, 2);
  } finally {
    Date.now = originalNow;
  }
});

test("native inspect cannot spawn after cancellation during helper preparation", async () => {
  const controller = new AbortController();
  let launches = 0;
  const driver = new MacAccessibilityDriver("/synthetic-unused", {
    compile: async () => {
      controller.abort();
      return "/unused";
    },
    runProcess: async () => {
      launches += 1;
      return "{}";
    },
  });
  await assert.rejects(
    driver.run({ operation: "inspect", target }, controller.signal),
    /abort/iu,
  );
  assert.equal(launches, 0);
});

test("partial native observations and every cursor page are read-only even with forged actions", async () => {
  const calls: Record<string, unknown>[] = [];
  await withBackend(
    async (request) => {
      calls.push(request);
      return rawInspection(target, true, 40);
    },
    async (backend) => {
      const capability = new ComputerZenXCapabilityPackage(backend);
      const invoke = (name: string, args: Record<string, unknown>) =>
        capability.invoke(name, {
          callId: "synthetic",
          name,
          arguments: args,
          cwd: "/",
          signal,
          threadId: "synthetic-owner",
        });
      type Page = ComputerInspection & {
        nextCursor?: string;
        coverage: { sourceComplete: boolean; reasons: string[] };
      };
      const first = (await invoke("computer_inspect", { target })) as Page;
      assert.equal(first.controls.length, 32);
      assert.equal(first.coverage.sourceComplete, false);
      assert.equal(first.diagnostics?.actionableCount, 0);
      assert.ok(first.coverage.reasons.includes("ax_read_error"));
      assert.ok(
        first.controls.every((control) => control.actions.length === 0),
      );
      const tail = (await invoke("computer_inspect", {
        target,
        cursor: first.nextCursor,
      })) as Page;
      assert.equal(tail.controls.length, 8);
      assert.equal(tail.observationId, first.observationId);
      assert.equal(tail.coverage.sourceComplete, false);
      assert.ok(tail.coverage.reasons.includes("ax_read_error"));
      assert.ok(tail.controls.every((control) => control.actions.length === 0));
      await assert.rejects(
        backend.press(target, tail.controls[0]!.selector),
        /observation only/u,
      );
      await assert.rejects(
        backend.setValue(target, first.controls[0]!.selector, "synthetic"),
        /observation only/u,
      );
      await assert.rejects(
        invoke("computer_press", {
          target,
          control: first.controls[0]!.selector,
        }),
        /observation only/u,
      );
      assert.equal(
        calls.length,
        1,
        "cursor reads and refused mutations must never dispatch native work",
      );
    },
  );
});

test("deadline partial cannot be promoted by a misleading complete status or missing truncated flag", async () => {
  await withBackend(
    async () => {
      const result = rawInspection();
      result.diagnostics.nativeRead.deadlineReached = true;
      return result;
    },
    async (backend) => {
      const result = await backend.inspect(target);
      assert.equal(result.truncated, true);
      assert.equal(result.diagnostics?.nativeRead?.status, "partial");
      assert.ok(
        result.controls.every((control) => control.actions.length === 0),
      );
      await assert.rejects(
        backend.press(target, result.controls[0]!.selector),
        /observation only/u,
      );
    },
  );
});

test("existing deterministic traversal and output truncation still permit verified controls", async () => {
  const calls: Record<string, unknown>[] = [];
  await withBackend(
    async (request) => {
      calls.push(request);
      const result = rawInspection();
      result.truncated = true;
      result.diagnostics.visitLimitReached = true;
      result.diagnostics.depthLimitReached = true;
      result.diagnostics.outputLimitReached = true;
      return request.operation === "inspect"
        ? result
        : { target: result.target };
    },
    async (backend) => {
      const result = await backend.inspect(target);
      assert.deepEqual(result.controls[0]!.actions, ["press", "set_value"]);
      await backend.press(target, result.controls[0]!.selector);
      assert.deepEqual(
        calls.map((call) => call.operation),
        ["inspect", "press"],
      );
    },
  );
});

test("failed fresh inspect revokes only the same target's old grant and does not retry", async () => {
  let fail = false;
  const calls: Record<string, unknown>[] = [];
  await withBackend(
    async (request) => {
      calls.push(request);
      const selected = request.target as ComputerTarget;
      if (
        request.operation === "inspect" &&
        fail &&
        selected.windowTitle === target.windowTitle
      )
        throw new Error("synthetic helper timed out after 10000ms");
      const result = rawInspection(selected);
      return request.operation === "inspect"
        ? result
        : { target: result.target };
    },
    async (backend) => {
      const first = await backend.inspect(target);
      const other = await backend.inspect(otherTarget);
      fail = true;
      await assert.rejects(backend.inspect(target), /timed out/u);
      await assert.rejects(
        backend.press(target, first.controls[0]!.selector),
        /stale/u,
      );
      await backend.press(otherTarget, other.controls[0]!.selector);
      assert.deepEqual(
        calls.map((call) => call.operation),
        ["inspect", "inspect", "inspect", "press"],
      );
    },
  );
});

test("older failed inspect cannot clear a newer grant", async () => {
  const older = deferred();
  let reads = 0;
  await withBackend(
    async (request) => {
      if (request.operation === "inspect" && reads++ === 0)
        return older.promise;
      return request.operation === "inspect"
        ? rawInspection()
        : { target: rawInspection().target };
    },
    async (backend) => {
      const first = backend.inspect(target);
      const rejected = assert.rejects(first, /older failed/u);
      const newer = await backend.inspect(target);
      older.reject(new Error("older failed"));
      await rejected;
      await backend.press(target, newer.controls[0]!.selector);
    },
  );
});

test("older successful inspect cannot overwrite a newer read-only partial", async () => {
  const older = deferred();
  let reads = 0;
  await withBackend(
    async () => (reads++ === 0 ? older.promise : rawInspection(target, true)),
    async (backend) => {
      const first = backend.inspect(target);
      const rejected = assert.rejects(first, /superseded/u);
      const newer = await backend.inspect(target);
      older.resolve(rawInspection());
      await rejected;
      await assert.rejects(
        backend.press(target, newer.controls[0]!.selector),
        /observation only/u,
      );
      assert.equal(reads, 2);
    },
  );
});

test("late already-dispatched mutation receipt survives inspect and cannot restore an old grant", async () => {
  const mutation = deferred();
  let reads = 0;
  let mutations = 0;
  await withBackend(
    async (request) => {
      if (request.operation === "press") {
        mutations += 1;
        return mutation.promise;
      }
      return rawInspection(target, reads++ > 0);
    },
    async (backend) => {
      const first = await backend.inspect(target);
      const pressed = backend.press(target, first.controls[0]!.selector);
      assert.equal(mutations, 1);
      const partial = await backend.inspect(target);
      mutation.resolve({ target: rawInspection().target });
      const receipt = await pressed;
      assert.deepEqual(receipt.control, first.controls[0]!.selector);
      await assert.rejects(
        backend.press(target, first.controls[0]!.selector),
        /stale/u,
      );
      await assert.rejects(
        backend.press(target, partial.controls[0]!.selector),
        /observation only/u,
      );
      assert.equal(mutations, 1);
    },
  );
});

function nativeSection(start: string, end: string) {
  const first = MAC_ACCESSIBILITY_SOURCE.indexOf(start);
  const last = MAC_ACCESSIBILITY_SOURCE.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `production Swift section ${start}`);
  return MAC_ACCESSIBILITY_SOURCE.slice(first, last);
}

// The shipped Swift functions run with recording AX API doubles and a fake
// monotonic clock. No AppKit/ApplicationServices import, AX permission, window,
// input, desktop capture, subprocess helper or network is involved in the fixture.
test(
  "native AX reads share a bounded deadline and disclose failures using synthetic APIs",
  {
    skip: process.platform !== "darwin",
    timeout: 60_000,
  },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-ax-budget-"));
    try {
      const source = path.join(directory, "main.swift");
      const binary = path.join(directory, "inspect-fixture");
      await writeFile(
        source,
        `${nativeFixture}\n${nativeSection("final class InspectReadBudget", "func elementFrame")}\n${nativeSection("func children(", "func supportsTextValue")}\n${nativeSection("func supportsTextValue(", "func matches(")}\n${nativeSection("struct WalkEntry", "func cgWindowBounds")}\nfunc runInspection() -> [String: Any] {\nvar response: [String: Any]\n${nativeSection('case "inspect":', 'case "press":').replace('case "inspect":', "")}\nreturn response\n}\n${nativeCases}`,
      );
      const compiled = spawnSync("/usr/bin/swiftc", [source, "-o", binary], {
        encoding: "utf8",
        timeout: 45_000,
      });
      assert.equal(compiled.status, 0, compiled.stderr);
      for (const name of [
        "empty",
        "unsupported",
        "read-error",
        "wide",
        "depth",
        "deadline",
        "read-timeout",
        "attribute-error",
        "actions-error",
        "settable-error",
        "values-error",
        "timeout-config-error",
        "role-error",
        "deadline-conversion",
        "non-inspect",
      ]) {
        const result = spawnSync(binary, [name], {
          encoding: "utf8",
          timeout: 5_000,
        });
        assert.equal(result.status, 0, `${name}: ${result.stderr}`);
        assert.match(result.stdout, /synthetic case passed/u);
      }
      for (const [name, message] of [
        ["target-error", /exact target/u],
        ["target-deadline", /deadline/u],
        ["permission", /Accessibility denied/u],
        ["window-bound", /bounded read/u],
      ] as const) {
        const result = spawnSync(binary, [name], {
          encoding: "utf8",
          timeout: 5_000,
        });
        assert.equal(result.status, 1, `${name}: ${result.stderr}`);
        assert.match(result.stderr, message);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

const nativeFixture = `
import Foundation
import CoreFoundation
typealias AXUIElement = NSString
enum AXError: Int32 { case success = 0, failure = -25200, invalidUIElement = -25202, cannotComplete = -25204, attributeUnsupported = -25205, actionUnsupported = -25206, apiDisabled = -25211, noValue = -25212 }
let kAXChildrenAttribute = "AXChildren", kAXWindowsAttribute = "AXWindows", kAXRoleAttribute = "AXRole", kAXValueAttribute = "AXValue"
let kAXTitleAttribute = "AXTitle", kAXDescriptionAttribute = "AXDescription", kAXHelpAttribute = "AXHelp", kAXIdentifierAttribute = "AXIdentifier", kAXEnabledAttribute = "AXEnabled", kAXSubroleAttribute = "AXSubrole"
let kAXStaticTextRole = "AXStaticText", kAXWindowRole = "AXWindow", kAXGroupRole = "AXGroup", kAXToolbarRole = "AXToolbar", kAXScrollAreaRole = "AXScrollArea", kAXSplitGroupRole = "AXSplitGroup"
var clock = 0.0, cost = 0.0
var childCount = 0, chainLength = 0
var roleErrorsRemaining = 1
var errorMode = ""
var reads: [String] = [], copies: [Int] = [], timeouts: [(String, Float, Double)] = []
let root: AXUIElement = "root"
let selectedWindow: AXUIElement? = nil
let requestedWindowTitle: String? = "Synthetic"
let resolvedTarget: [String: Any] = ["pid": 7, "applicationName": "Synthetic", "windowTitle": "Synthetic"]
struct Running { let processIdentifier = 7; let bundleIdentifier: String? = "dev.synthetic"; let launchDate: Date? = nil }
let running = Running()
func fail(_ message: String) -> Never { FileHandle.standardError.write(Data((message + "\\n").utf8)); exit(1) }
func failAccessibilityDenied() -> Never { fail("macOS Accessibility denied") }
func frameFingerprint(_ element: AXUIElement) -> String { "" }
func elementFrame(_ element: AXUIElement) -> CGRect? { nil }
func uniqueActionWindowId(_ element: AXUIElement, _ bounds: CGRect) -> Int? { nil }
func AXUIElementGetTypeID() -> CFTypeID { CFStringGetTypeID() }
func AXUIElementSetMessagingTimeout(_ element: AXUIElement, _ seconds: Float) -> AXError {
  precondition(seconds > 0)
  if let budget = inspectReadBudget { precondition(Double(seconds) <= budget.deadline - clock) }
  timeouts.append((element as String, seconds, clock))
  return errorMode == "timeout-config-error" ? .invalidUIElement : .success
}
func read(_ label: String) -> AXError {
  reads.append(label); clock += cost
  if errorMode == "read-error" && label == "count:root:AXChildren" { return .cannotComplete }
  if errorMode == "unsupported" && label == "count:root:AXChildren" { return .attributeUnsupported }
  if errorMode == "attribute-error" && label == "attribute:child-0:AXTitle" { return .cannotComplete }
  if errorMode == "actions-error" && label == "actions:child-0" { return .cannotComplete }
  if errorMode == "settable-error" && label == "settable:child-0" { return .cannotComplete }
  if errorMode == "values-error" && label == "copy:root" { return .cannotComplete }
  if errorMode == "role-error" && label == "attribute:child-0:AXRole" && roleErrorsRemaining > 0 {
    roleErrorsRemaining -= 1; return .cannotComplete
  }
  return .success
}
func AXUIElementCopyAttributeValue(_ element: AXUIElement, _ name: CFString, _ output: UnsafeMutablePointer<CFTypeRef?>) -> AXError {
  let key = name as String
  let status = read("attribute:" + (element as String) + ":" + key)
  if status != .success { return status }
  if key == kAXRoleAttribute {
    let role = element == "child-0" && errorMode == "role-error" ? "AXWebArea" :
      (element == "child-0" && errorMode == "settable-error" ? "AXTextField" : "AXButton")
    output.pointee = role as NSString; return .success
  }
  if key == kAXTitleAttribute { output.pointee = ("合成 " + (element as String)) as NSString; return .success }
  if key == kAXEnabledAttribute { output.pointee = NSNumber(value: true); return .success }
  return .noValue
}
func AXUIElementGetAttributeValueCount(_ element: AXUIElement, _ name: CFString, _ output: UnsafeMutablePointer<CFIndex>) -> AXError {
  let key = name as String, node = element as String
  let status = read("count:" + node + ":" + key)
  if status != .success { return status }
  if key == "AXChildrenInNavigationOrder" { output.pointee = 0; return .success }
  if errorMode == "role-error" && node == "child-0" { output.pointee = 1; return .success }
  if chainLength > 0 { output.pointee = node.count < chainLength ? 1 : 0 }
  else { output.pointee = node == "root" ? childCount : 0 }
  return .success
}
func AXUIElementCopyAttributeValues(_ element: AXUIElement, _ name: CFString, _ start: CFIndex, _ count: CFIndex, _ output: UnsafeMutablePointer<CFArray?>) -> AXError {
  let status = read("copy:" + (element as String)); if status != .success { return status }
  precondition(start == 0 && count <= 1024); copies.append(count)
  let values: [NSString] = (0..<count).map { index in
    (errorMode == "role-error" && element == "child-0" ? "web-leaf" :
      (chainLength > 0 ? (element as String) + "x" : "child-" + String(index))) as NSString
  }
  output.pointee = values as CFArray; return .success
}
func AXUIElementCopyActionNames(_ element: AXUIElement, _ output: UnsafeMutablePointer<CFArray?>) -> AXError {
  let status = read("actions:" + (element as String)); if status != .success { return status }
  output.pointee = ["AXPress"] as CFArray; return .success
}
func AXUIElementIsAttributeSettable(_ element: AXUIElement, _ name: CFString, _ output: UnsafeMutablePointer<DarwinBoolean>) -> AXError {
  let status = read("settable:" + (element as String)); output.pointee = false; return status
}
`;

const nativeCases = `
let scenario = CommandLine.arguments[1]
inspectReadBudget = InspectReadBudget(seconds: 9.75, now: { clock })
switch scenario {
case "empty":
  let children = inspectChildren(root, limit: 12)
  precondition(children.elements.isEmpty && !children.omitted && !inspectReadBudget!.partial && copies.isEmpty)
case "unsupported":
  errorMode = scenario
  let children = inspectChildren(root, limit: 12)
  precondition(children.elements.isEmpty && !inspectReadBudget!.partial)
  precondition(reads.contains("count:root:AXChildrenInNavigationOrder"))
case "read-error":
  errorMode = scenario
  let result = runInspection()
  let diagnostics = result["diagnostics"] as! [String: Any]
  let native = diagnostics["nativeRead"] as! [String: Any]
  precondition(native["status"] as? String == "partial")
  precondition(native["errorCodes"] as? [Int] == [-25204])
  precondition(native["deadlineReached"] as? Bool == false)
  precondition(!reads.contains("count:root:AXChildrenInNavigationOrder"))
  let controls = result["controls"] as! [[String: Any]]
  precondition(controls.count == 1 && (controls[0]["actions"] as! [String]).isEmpty)
case "wide":
  childCount = 1_000_000_000
  let result = walk(root)
  precondition(result.entries.count == 1024 && result.visitLimitReached)
  precondition(copies == [1023] && !inspectReadBudget!.partial)
case "depth":
  chainLength = 100
  let result = walk(root, maxDepth: 2)
  precondition(result.entries.count == 3 && result.depthLimitReached)
  precondition(copies == [1, 1] && !inspectReadBudget!.partial)
case "deadline":
  childCount = 20; cost = 0.01
  inspectReadBudget = InspectReadBudget(seconds: 0.4, now: { clock })
  let result = runInspection()
  let controls = result["controls"] as! [[String: Any]]
  let diagnostics = result["diagnostics"] as! [String: Any]
  let native = diagnostics["nativeRead"] as! [String: Any]
  precondition(native["status"] as? String == "partial" && native["deadlineReached"] as? Bool == true)
  precondition((diagnostics["visitedCount"] as! Int) < (diagnostics["visitLimit"] as! Int))
  precondition(diagnostics["visitLimitReached"] as? Bool == false)
  precondition(diagnostics["depthLimitReached"] as? Bool == false)
  precondition(controls.count > 0 && controls.count < 21)
  precondition(controls.allSatisfy { ($0["actions"] as! [String]).isEmpty })
  let before = reads.count
  _ = attribute(root, kAXTitleAttribute); _ = actions(root); _ = isSettable(root, kAXValueAttribute)
  _ = elementArrayAttribute(root, kAXChildrenAttribute)
  precondition(reads.count == before)
case "read-timeout":
  cost = 0.1
  _ = textAttribute(root, kAXRoleAttribute)
  _ = textAttribute("child", kAXRoleAttribute)
  precondition(timeouts.count == 2 && timeouts[1].1 < timeouts[0].1)
  precondition(timeouts[0].0 == "root" && timeouts[1].0 == "child")
  childCount = 1
  _ = actions(root); _ = isSettable(root, kAXValueAttribute)
  _ = elementArrayAttribute(root, kAXChildrenAttribute)
  precondition(timeouts.count == reads.count && timeouts.count == 6)
  precondition(zip(timeouts, timeouts.dropFirst()).allSatisfy { pair in pair.0.1 > pair.1.1 })
case "attribute-error", "actions-error", "settable-error", "values-error":
  childCount = 2; errorMode = scenario
  let result = runInspection()
  let native = (result["diagnostics"] as! [String: Any])["nativeRead"] as! [String: Any]
  precondition(native["status"] as? String == "partial" && native["errorCodes"] as? [Int] == [-25204])
  let controls = result["controls"] as! [[String: Any]]
  precondition(!controls.isEmpty && controls.allSatisfy { ($0["actions"] as! [String]).isEmpty })
  precondition(!controls.contains { $0["title"] as? String == "合成 child-0" })
case "timeout-config-error":
  errorMode = scenario
  _ = textAttribute(root, kAXRoleAttribute)
  precondition(reads.isEmpty && inspectReadBudget!.errorCodes == [-25202] && inspectReadBudget!.partial)
case "role-error":
  childCount = 2; errorMode = scenario
  let result = runInspection()
  let diagnostics = result["diagnostics"] as! [String: Any]
  let native = diagnostics["nativeRead"] as! [String: Any]
  let controls = result["controls"] as! [[String: Any]]
  precondition(native["status"] as? String == "partial" && native["errorCodes"] as? [Int] == [-25204])
  precondition(controls.count == 2 && controls.allSatisfy { ($0["actions"] as! [String]).isEmpty })
  precondition(!controls.contains { $0["title"] as? String == "合成 child-0" || $0["title"] as? String == "合成 web-leaf" })
  precondition(reads.filter { $0 == "attribute:child-0:AXRole" }.count == 1)
  precondition(!reads.contains("count:child-0:AXChildren"))
  precondition(diagnostics["encounteredWebArea"] as? Bool == false)
  precondition(diagnostics["webAreaControlCount"] as? Int == 0)
case "deadline-conversion":
  clock = 50
  var wall = 100.0
  let converted = InspectReadBudget(deadlineUnixMs: 102_500, wallNow: { wall }, now: { clock })
  precondition(converted.started == 50 && converted.deadline == 52.5)
  wall = 1_000_000; clock = 50.5
  precondition(converted.available() && converted.deadline == 52.5)
  precondition(converted.diagnostics()["elapsedMs"] as? Double == 500)
  inspectReadBudget = InspectReadBudget(deadlineUnixMs: 99_500, wallNow: { 100 }, now: { clock })
  _ = textAttribute(root, kAXRoleAttribute)
  precondition(inspectReadBudget!.deadlineReached && inspectReadBudget!.deadline == clock && reads.isEmpty && timeouts.isEmpty)
  let capped = InspectReadBudget(deadlineUnixMs: 1_000_000_000, wallNow: { 100 }, now: { clock })
  precondition(capped.deadline - capped.started == 9.75)
case "non-inspect":
  inspectReadBudget = nil
  _ = textAttribute(root, kAXRoleAttribute)
  precondition(timeouts.isEmpty && reads.count == 1)
case "target-error":
  _ = inspectReadBudget!.record(.cannotComplete)
  inspectReadBudget!.requireResolvedTarget()
case "target-deadline":
  clock = 10
  inspectReadBudget!.requireResolvedTarget()
case "permission":
  _ = inspectReadBudget!.record(.apiDisabled)
case "window-bound":
  childCount = 1_000_000_000
  _ = elementArrayAttribute(root, kAXWindowsAttribute)
default: preconditionFailure("unknown fixture")
}
print("synthetic case passed: " + scenario)
`;
