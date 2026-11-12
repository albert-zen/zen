import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Real CoreGraphics construction only. Never post, activate, request trust,
// capture a screen or open an application. These are NOT delivered event facts.
const source = `// Construction only: no event posting, activation, permissions or user data.
import ApplicationServices
import Foundation
func require(_ event: CGEvent?) -> CGEvent {
  guard let event else { fatalError("native event construction failed") }
  return event
}
func receipt(_ label: String, _ event: CGEvent) -> [String: Any] {
  return ["label": label, "type": event.type.rawValue,
    "flags": event.flags.rawValue,
    "x": event.location.x, "y": event.location.y,
    "clickState": event.getIntegerValueField(.mouseEventClickState),
    "buttonNumber": event.getIntegerValueField(.mouseEventButtonNumber),
    "keycode": event.getIntegerValueField(.keyboardEventKeycode)]
}
let point = CGPoint(x: -700.5, y: 500.25)
let mouseDown = require(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left))
let mouseUp = require(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left))
let keyDown = require(CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: true))
let keyUp = require(CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: false))
precondition(mouseDown.type == .leftMouseDown && mouseUp.type == .leftMouseUp)
precondition(mouseDown.location == point && mouseUp.location == point)
precondition(keyDown.type == .keyDown && keyUp.type == .keyUp)
precondition(keyDown.getIntegerValueField(.keyboardEventKeycode) == 36)
precondition(keyUp.getIntegerValueField(.keyboardEventKeycode) == 36)
let values = [receipt("mouseDown", mouseDown), receipt("mouseUp", mouseUp), receipt("keyDown", keyDown), receipt("keyUp", keyUp)]
let data = try JSONSerialization.data(withJSONObject: values, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
`;

test(
  "real macOS constructors expose event metadata without posting input",
  { skip: process.platform !== "darwin", timeout: 60000 },
  (t) => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "zenx-event-metadata-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "main.swift");
    const executable = path.join(directory, "metadata");
    writeFileSync(sourcePath, source);
    const compilation = spawnSync(
      "/usr/bin/swiftc",
      [sourcePath, "-o", executable],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(
      compilation.status,
      0,
      compilation.stderr || compilation.error?.message,
    );
    const result = spawnSync(executable, [], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const events = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    assert.deepEqual(
      events.map((event) => event.label),
      ["mouseDown", "mouseUp", "keyDown", "keyUp"],
    );
    assert.deepEqual(
      events.map((event) => event.type),
      [1, 2, 10, 11],
    );
    for (const event of events) {
      for (const field of [
        "type",
        "flags",
        "x",
        "y",
        "clickState",
        "buttonNumber",
        "keycode",
      ])
        assert.equal(typeof event[field], "number", field);
    }
    for (const event of events.slice(0, 2)) {
      assert.equal(event.x, -700.5);
      assert.equal(event.y, 500.25);
      assert.equal(event.buttonNumber, 0);
    }
    for (const event of events.slice(2)) assert.equal(event.keycode, 36);
    const receipt = {
      scope: "construction-only-no-post",
      actualDelivery: "not-tested",
      events,
    };
    console.log("CGEvent construction metadata: " + JSON.stringify(receipt));
    if (process.env.ZENX_COMPUTER_CONSTRUCTION_EVIDENCE)
      writeFileSync(
        process.env.ZENX_COMPUTER_CONSTRUCTION_EVIDENCE,
        JSON.stringify(receipt, null, 2) + "\n",
      );
  },
);

// Exercise AppKit -> CoreGraphics conversion used by capture-bound background
// input. A synthetic window number is sufficient for construction, not delivery.
const windowMouseSource = `
import AppKit
import ApplicationServices
import Foundation
let cocoa = CGPoint(x: 12.5, y: 87.75)
let global = CGPoint(x: -700.5, y: 500.25)
let pairs: [(String, NSEvent.EventType, NSEvent.EventType, CGMouseButton)] = [
  ("left", .leftMouseDown, .leftMouseUp, .left),
  ("right", .rightMouseDown, .rightMouseUp, .right),
  ("middle", .otherMouseDown, .otherMouseUp, .center)
]
var values: [[String: Any]] = []
for (buttonName, down, up, button) in pairs {
  for (phase, type) in [("down", down), ("up", up)] {
    guard let native = NSEvent.mouseEvent(with: type, location: cocoa,
      modifierFlags: [], timestamp: 0, windowNumber: 17, context: nil,
      eventNumber: 1, clickCount: 1, pressure: 1),
      let event = native.cgEvent else { fatalError("native window mouse construction failed") }
    precondition(native.type == type)
    precondition(native.locationInWindow == cocoa && native.windowNumber == 17)
    event.flags = []; event.location = global
    event.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button.rawValue))
    event.setIntegerValueField(.mouseEventClickState, value: 1)
    event.setIntegerValueField(.mouseEventSubtype, value: 3)
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: 17)
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: 17)
    values.append([
      "button": buttonName, "phase": phase,
      "nativeType": native.type.rawValue, "type": event.type.rawValue,
      "nativeButtonNumber": native.buttonNumber,
      "buttonNumber": event.getIntegerValueField(.mouseEventButtonNumber),
      "x": event.location.x, "y": event.location.y,
      "flags": event.flags.rawValue,
      "clickState": event.getIntegerValueField(.mouseEventClickState),
      "subtype": event.getIntegerValueField(.mouseEventSubtype),
      "window": event.getIntegerValueField(.mouseEventWindowUnderMousePointer),
      "handlingWindow": event.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent)
    ])
  }
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]))
`;

test(
  "real macOS NSEvent background button pairs preserve native metadata without posting",
  { skip: process.platform !== "darwin", timeout: 60000 },
  (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "zenx-window-mouse-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "main.swift");
    const executable = path.join(directory, "metadata");
    writeFileSync(sourcePath, windowMouseSource);
    const compilation = spawnSync(
      "/usr/bin/swiftc",
      [sourcePath, "-o", executable],
      {
        encoding: "utf8",
        timeout: 30000,
      },
    );
    assert.equal(
      compilation.status,
      0,
      compilation.stderr || compilation.error?.message,
    );
    const result = spawnSync(executable, [], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const events = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    assert.deepEqual(
      events.map((event) => event.button),
      ["left", "left", "right", "right", "middle", "middle"],
    );
    assert.deepEqual(
      events.map((event) => event.phase),
      ["down", "up", "down", "up", "down", "up"],
    );
    assert.deepEqual(
      events.map((event) => event.nativeType),
      [1, 2, 3, 4, 25, 26],
    );
    assert.deepEqual(
      events.map((event) => event.type),
      [1, 2, 3, 4, 25, 26],
    );
    // AppKit has no button argument here. Observe its constructor default, but
    // only the explicitly normalized CGEvent number is the input contract.
    for (const event of events)
      assert.equal(typeof event.nativeButtonNumber, "number");
    assert.deepEqual(
      events.map((event) => event.buttonNumber),
      [0, 0, 1, 1, 2, 2],
    );
    for (const event of events) {
      assert.equal(event.x, -700.5);
      assert.equal(event.y, 500.25);
      assert.equal(event.flags, 0);
      assert.equal(event.clickState, 1);
      assert.equal(event.subtype, 3);
      assert.equal(event.window, 17);
      assert.equal(event.handlingWindow, 17);
    }
    const receipt = {
      scope: "construction-only-no-post",
      actualDelivery: "not-tested",
      events,
    };
    console.log(
      "NSEvent window mouse construction metadata: " + JSON.stringify(receipt),
    );
    if (process.env.ZENX_COMPUTER_CONSTRUCTION_EVIDENCE)
      writeFileSync(
        process.env.ZENX_COMPUTER_CONSTRUCTION_EVIDENCE + ".window-mouse.json",
        JSON.stringify(receipt, null, 2) + "\n",
      );
  },
);
