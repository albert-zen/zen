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
