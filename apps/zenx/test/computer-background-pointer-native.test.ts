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
  "production background mouse pairs preserve button identity and fail closed",
  { skip: process.platform !== "darwin", timeout: 90000 },
  async (t) => {
    const start = MAC_BOUND_TARGET_SOURCE.indexOf("func backgroundClickPair("),
      end = MAC_BOUND_TARGET_SOURCE.indexOf(
        "func backgroundAppKeyboard(",
        start,
      );
    assert(start > 0 && end > start);
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-background-pointer-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    // Execute the actual production functions against in-memory ports. No native
    // services, screenshots, app activation or OS input. Delivery is not tested.
    const source =
      `import Foundation
import Darwin
struct Failure: Error {}
func refuse(_ message: String) throws -> Never { throw Failure() }
enum CGMouseButton: UInt32 { case left = 0, right = 1, center = 2 }
enum Field { case mouseEventButtonNumber, mouseEventClickState, mouseEventSubtype, mouseEventWindowUnderMousePointer, mouseEventWindowUnderMousePointerThatCanHandleThisEvent }
final class CGEvent {
  var flags: Set<String> = []; var location = CGPoint.zero
  let type: NSEvent.EventType?; var fields: [Field: Int64] = [:]; let preparation: Int16?
  init(_ type: NSEvent.EventType?, _ preparation: Int16? = nil) { self.type = type; self.preparation = preparation }
  func setIntegerValueField(_ field: Field, value: Int64) { fields[field] = value }
}
final class NSEvent {
  enum EventType { case leftMouseDown, leftMouseUp, rightMouseDown, rightMouseUp, otherMouseDown, otherMouseUp }
  let cgEvent: CGEvent?
  init(_ type: EventType) { cgEvent = CGEvent(type) }
  static func mouseEvent(with type: EventType, location: CGPoint, modifierFlags: Set<String>, timestamp: Double, windowNumber: Int, context: Int?, eventNumber: Int, clickCount: Int, pressure: Double) -> NSEvent? {
    constructions += 1
    if mode == "up-construction" && constructions == 2 { return nil }
    precondition(windowNumber == 17 && location == CGPoint(x: 100, y: 150))
    return NSEvent(type)
  }
}
struct App { let processIdentifier: Int32 = 7 }
final class Binding {
  let app = App(); let windowId = 17; let bounds = CGRect(x: -100, y: 20, width: 400, height: 200)
  var capturedAt: Date? = Date(); var captureSession: Bool? = false
  func verifyApplication() throws { if !birth { try refuse("process identity changed") } }
  func verify() throws { try verifyApplication(); if mode == "stale" { try refuse("stale") } }
}
var mode = "normal", constructions = 0, generation = 0
var cancelled = false, birth = true, backgroundSettledForRequest = false
var events: [CGEvent] = [], phases: [[String: Any]] = []
struct DesktopFence: Equatable {
  let foreground: Int32 = 1; let windows = [17]; let version: Int
  init() throws { version = generation }
}
func lockedSession() throws -> Bool { false }
func windowInputPermission() throws { if cancelled || mode == "permission" { try refuse("permission/cancel") } }
let windowLocationSetter: ((CGEvent, CGPoint) -> Void)? = { _, point in precondition(point == CGPoint(x: 100, y: 50)) }
func emit(_ value: [String: Any]) { phases.append(value) }
func appStateEvent(_ subtype: Int16) throws -> CGEvent { CGEvent(nil, subtype) }
func postToTarget(_ event: CGEvent, _ pid: Int32) {
  precondition(pid == 7 && birth, "cleanup must not target a recycled PID"); events.append(event)
  if event.preparation == 1 && mode == "recycle-preparation" { birth = false }
  if event.preparation == 1 && mode == "fence-before" { generation += 1 }
  if let type = event.type, [.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(type) {
    if mode == "cancel" { cancelled = true }
    if mode == "recycle" { birth = false }
    if mode == "fence-after" { generation += 1 }
  }
}
` +
      MAC_BOUND_TARGET_SOURCE.slice(start, end) +
      `
func reset(_ value: String = "normal") { mode = value; constructions = 0; generation = 0; cancelled = false; birth = true; events = []; phases = []; backgroundSettledForRequest = false }
let names = ["left", "right", "middle"]
let downs: [NSEvent.EventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
let ups: [NSEvent.EventType] = [.leftMouseUp, .rightMouseUp, .otherMouseUp]
for (index, name) in names.enumerated() {
  for condition in ["normal", "cancel", "fence-after"] {
    reset(condition); let binding = Binding(); var posted = 0
    do { try backgroundClick(binding, ["x": 0.0, "y": 70.0, "button": name], &posted); precondition(condition == "normal") }
    catch { precondition(condition != "normal") }
    let mouse = events.filter { $0.type != nil }
    precondition(mouse.count == 2 && mouse[0].type == downs[index] && mouse[1].type == ups[index])
    precondition(mouse.allSatisfy { $0.fields[.mouseEventButtonNumber] == Int64(index) && $0.fields[.mouseEventClickState] == 1 && $0.location == CGPoint(x: 0, y: 70) })
    precondition(events.first?.preparation == 1 && events.last?.preparation == 2)
    precondition(posted == 2 && binding.capturedAt == nil && backgroundSettledForRequest)
    precondition(phases.last?["release"] as? String == "posted")
  }
}
for name in names {
  reset("recycle"); let binding = Binding(); var posted = 0
  do { try backgroundClick(binding, ["x": 0.0, "y": 70.0, "button": name], &posted); fatalError("recycled target succeeded") } catch {}
  precondition(posted == 1 && events.filter { $0.type != nil }.count == 1)
  precondition(events.filter { $0.preparation == 2 }.isEmpty)
  precondition(phases.last?["release"] as? String == "unknown")
}
reset("recycle-preparation"); let preparationBinding = Binding(); var preparationPosted = 0
 do { try backgroundClick(preparationBinding, ["x": 0.0, "y": 70.0, "button": "right"], &preparationPosted); fatalError("recycled preparation succeeded") } catch {}
precondition(preparationPosted == 0 && events.count == 1 && events.first?.preparation == 1)
precondition(phases.last?["release"] as? String == "not_needed")
reset(); let defaultBinding = Binding(); var posted = 0
try backgroundClick(defaultBinding, ["x": 0.0, "y": 70.0], &posted)
precondition(events.filter { $0.type != nil }.first?.type == .leftMouseDown)
for invalid in ["extra", 1, NSNull()] as [Any] {
  reset(); let binding = Binding(); posted = 0
  do { try backgroundClick(binding, ["x": 0.0, "y": 70.0, "button": invalid], &posted); fatalError("invalid accepted") } catch {}
  precondition(posted == 0 && events.isEmpty && constructions == 0 && binding.capturedAt != nil)
}
for condition in ["permission", "stale", "up-construction", "fence-before"] {
  reset(condition); let binding = Binding(); posted = 0
  do { try backgroundClick(binding, ["x": 0.0, "y": 70.0, "button": "right"], &posted); fatalError("refusal accepted") } catch {}
  precondition(posted == 0 && events.filter { $0.type != nil }.isEmpty)
  precondition(phases.last?["release"] as? String == "not_needed")
  if condition == "fence-before" { precondition(events.first?.preparation == 1 && events.last?.preparation == 2) }
}
print("PASS button pairs, default left, invalid pre-capture, prebuilt release, cancellation and desktop fences; delivery not tested")
`;
    const file = path.join(directory, "fixture.swift"),
      binary = path.join(directory, "fixture");
    await writeFile(file, source);
    await runProcess("/usr/bin/swiftc", [file, "-o", binary], 60000);
    assert.match(await runProcess(binary, [], 10000), /PASS button pairs/);
  },
);
