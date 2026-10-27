import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAC_BOUND_TARGET_SOURCE,
  runProcess,
} from "../src/main/capabilities/computer-provider.js";

test(
  "native app keyboard pairs Unicode without window authority and settles cancellation/birth loss",
  { skip: process.platform !== "darwin", timeout: 90000 },
  async (t) => {
    const start = MAC_BOUND_TARGET_SOURCE.indexOf(
        "func backgroundAppKeyboard(",
      ),
      end = MAC_BOUND_TARGET_SOURCE.indexOf("struct KeyboardLayout", start);
    const chunks = MAC_BOUND_TARGET_SOURCE.indexOf("func unicodeChunks("),
      keys = MAC_BOUND_TARGET_SOURCE.indexOf("var bindings:", chunks);
    assert(start > 0 && end > start && chunks > end && keys > chunks);
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-app-keyboard-pure-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    // No AppKit/CG imports, native service, OS windows or events: real algorithm,
    // bounded in-memory event/identity/permission ports substituted at its seam.
    const source =
      `import Foundation
import Darwin
typealias UniChar = UInt16
typealias CGKeyCode = UInt16
enum SourceState { case privateState }
final class CGEventSource { init?(stateID: SourceState) {} }
final class CGEvent {
 var flags: Set<String> = []; let down: Bool; var units: [UInt16] = []; var preparation = false
 init?(keyboardEventSource: CGEventSource?, virtualKey: UInt16, keyDown: Bool) { down = keyDown }
 func keyboardSetUnicodeString(stringLength: Int, unicodeString: UnsafePointer<UniChar>?) { units = Array(UnsafeBufferPointer(start: unicodeString, count: stringLength)) }
}
struct DesktopFence: Equatable { let foreground: Int32 = 1 }
struct App { let processIdentifier: Int32 = 7 }
struct Failure: Error {}
func refuse(_ message: String) throws -> Never { throw Failure() }
var cancelled = false, birth = true, downCount = 0, abortAt = 0, recycleAt = 0
var backgroundSettledForRequest = false
var events: [CGEvent] = [], phases: [[String: Any]] = []
final class Binding {
 let app = App()
 func verifyApplication() throws { if !birth { throw Failure() } }
 func verify() throws { fatalError("App input must not consult old window authority") }
}
func windowInputPermission() throws { if cancelled { throw Failure() } }
func emit(_ value: [String: Any]) { phases.append(value) }
func appStateEvent(_ subtype: Int16) throws -> CGEvent { let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)!; event.preparation = true; return event }
func postToTarget(_ event: CGEvent, _ pid: Int32) {
 precondition(pid == 7); events.append(event)
 if !event.preparation && event.down { downCount += 1; if downCount == abortAt { cancelled = true }; if downCount == recycleAt { birth = false } }
}
` +
      MAC_BOUND_TARGET_SOURCE.slice(start, end) +
      MAC_BOUND_TARGET_SOURCE.slice(chunks, keys) +
      `
func reset() { cancelled = false; birth = true; downCount = 0; abortAt = 0; recycleAt = 0; events = []; phases = []; backgroundSettledForRequest = false }
let binding = Binding()
let text = String(repeating: "a", count: 15) + "🌙🦆中文" + String(repeating: "🦆", count: 10)
var posted = 0
let receipt = try backgroundAppKeyboard(binding, ["operation": "backgroundType", "text": text], &posted)
let downs = events.filter { !$0.preparation && $0.down }, ups = events.filter { !$0.preparation && !$0.down }
precondition(downs.count == ups.count && downs.count > 1)
precondition(downs.allSatisfy { $0.units.count <= 16 })
precondition(downs.flatMap { $0.units } == Array(text.utf16))
precondition(ups.flatMap { $0.units } == Array(text.utf16))
precondition(receipt["targetScope"] as? String == "application_current_focus")
precondition(phases.count == 2 && phases.last?["release"] as? String == "posted")
reset(); abortAt = 1; posted = 0
do { _ = try backgroundAppKeyboard(binding, ["operation": "backgroundType", "text": String(repeating: "a", count: 40)], &posted); fatalError("cancel accepted") } catch {}
precondition(events.filter { !$0.preparation && $0.down }.count == 1)
precondition(events.filter { !$0.preparation && !$0.down }.count == 1, "cancel must not skip key up")
precondition(phases.count == 2 && phases.last?["release"] as? String == "posted")
reset(); recycleAt = 1; posted = 0
do { _ = try backgroundAppKeyboard(binding, ["operation": "backgroundKeyPress", "key": "enter"], &posted); fatalError("recycled app accepted") } catch {}
precondition(events.filter { !$0.preparation && !$0.down }.isEmpty, "never release into recycled PID")
precondition(phases.last?["release"] as? String == "unknown")
reset(); birth = false; posted = 0
do { _ = try backgroundAppKeyboard(binding, ["operation": "backgroundKeyPress", "key": "enter"], &posted); fatalError("dead app accepted") } catch {}
precondition(events.isEmpty)
reset(); posted = 0
do { _ = try backgroundAppKeyboard(binding, ["operation": "backgroundKeyPress", "key": "enter", "modifiers": ["command"]], &posted); fatalError("shortcut accepted") } catch {}
precondition(events.isEmpty)
print("PASS Unicode exact chunks, no window verify, cancel-up, birth-loss unknown, zero-dispatch refusal")
`;
    const file = path.join(directory, "fixture.swift"),
      binary = path.join(directory, "fixture");
    await writeFile(file, source);
    await runProcess("/usr/bin/swiftc", [file, "-o", binary], 60000);
    const output = await runProcess(binary, [], 10000);
    assert.match(output, /PASS Unicode exact chunks/);
  },
);
