import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { supportingRailsData } from "./fixtures/supporting-rails-data.js";
test("default fixture remains unchanged unless explicitly selected", () => {
  for (const mode of [null, "", "unknown"])
    assert.equal(supportingRailsData(mode), null);
});
test("long scene has genuinely distinct cards, multilingual long names and inert data", () => {
  const data = supportingRailsData("long")!;
  assert.ok(data.project.length > 60 && data.thread.length > 80);
  assert.ok(data.children.every((name) => name.length > 30));
  assert.match(data.children[1]!, /资料卡/);
  assert.deepEqual(
    data.layout.widgets.map((w) => w.type),
    ["lineage", "triggers"],
  );
  assert.ok(data.layout.widgets.every((w) => !w.collapsed && w.visible));
  assert.deepEqual(data.layout.widgets[1]!.config, {
    filter: "all",
    showPaused: true,
  });
  assert.ok(
    data.triggers.every(
      (t) => t.id.startsWith("synthetic-") && t.threadId === "thread-1",
    ),
  );
});
test("collapsed scene represents a saved layout, not a claim of native click acceptance", () => {
  assert.ok(
    supportingRailsData("collapsed")!.layout.widgets.every((w) => w.collapsed),
  );
});
test("fixture only extends read-only commands and still rejects information mutation", async () => {
  const source = await readFile(
    new URL("./fixtures/ui-polish-visual.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /rails && pluginId === "zenx-triggers" && command === "sidebar-facts"/,
  );
  assert.match(source, /admissionId: "synthetic-rails-triggers"/);
  assert.match(source, /key: "zenx-triggers:sidebar-facts"/);
  assert.match(source, /Navigation preview does not admit information edits/);
  assert.match(
    source,
    /value: readingScene \? guardReadingBridge\(zenx\) : zenx/,
  );
});
