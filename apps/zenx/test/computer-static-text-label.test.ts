import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAC_ACCESSIBILITY_SOURCE } from "../src/main/capabilities/computer-provider.js";

// Run the actual shipped function with synthetic attributes. No AppKit,
// Accessibility permissions, target application, or native input is involved.
test(
  "native static text labels retain displayed values without reading editable values",
  {
    skip: process.platform !== "darwin",
  },
  () => {
    const start = MAC_ACCESSIBILITY_SOURCE.indexOf("func displayLabel(");
    const end = MAC_ACCESSIBILITY_SOURCE.indexOf(
      "\nfunc isContainerRole",
      start,
    );
    assert.ok(start >= 0 && end > start);
    const labelFunction = MAC_ACCESSIBILITY_SOURCE.slice(start, end);
    const directory = mkdtempSync(path.join(os.tmpdir(), "zenx-ax-label-"));
    try {
      const source = path.join(directory, "labels.swift");
      const binary = path.join(directory, "labels");
      writeFileSync(
        source,
        `
import Foundation
typealias AXUIElement = [String: Any]
let kAXTitleAttribute = "AXTitle"
let kAXDescriptionAttribute = "AXDescription"
let kAXHelpAttribute = "AXHelp"
let kAXIdentifierAttribute = "AXIdentifier"
let kAXRoleAttribute = "AXRole"
let kAXValueAttribute = "AXValue"
let kAXStaticTextRole = "AXStaticText"
var valueReads = 0
func textAttribute(_ element: AXUIElement, _ name: String) -> String {
  if name == kAXValueAttribute { valueReads += 1 }
  return element[name] as? String ?? ""
}
${labelFunction}
let cases: [(AXUIElement, String, Int)] = [
  (["AXRole": "AXStaticText", "AXValue": "群聊消息 中文"], "群聊消息 中文", 1),
  (["AXRole": "AXStaticText", "AXValue": ""], "", 1),
  (["AXRole": "AXStaticText", "AXValue": 42], "", 1),
  (["AXRole": "AXStaticText"], "", 1),
  (["AXRole": "AXTextField", "AXValue": "private draft"], "", 0),
  (["AXRole": "AXTextArea", "AXValue": "private draft"], "", 0),
  (["AXRole": "AXTextField", "AXSubrole": "AXSecureTextField", "AXValue": "secret"], "", 0),
  (["AXRole": "AXButton", "AXValue": "not a label"], "", 0)
]
for (element, expected, expectedReads) in cases {
  valueReads = 0
  precondition(displayLabel(element) == expected)
  precondition(valueReads == expectedReads)
}
for attribute in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXIdentifierAttribute] {
  valueReads = 0
  precondition(displayLabel(["AXRole": "AXStaticText", attribute: "existing label", "AXValue": "content"]) == "existing label")
  precondition(valueReads == 0)
}
print("12 synthetic label cases passed")
`,
      );
      const compiled = spawnSync("/usr/bin/swiftc", [source, "-o", binary], {
        encoding: "utf8",
        timeout: 60_000,
      });
      assert.equal(compiled.status, 0, compiled.stderr);
      const result = spawnSync(binary, [], {
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /12 synthetic label cases passed/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
