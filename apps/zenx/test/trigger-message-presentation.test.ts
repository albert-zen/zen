import assert from "node:assert/strict";
import test from "node:test";
import { triggerMessagePresentation } from "../src/renderer/src/trigger-message-presentation.js";
import { createRealHostWakeupFixture } from "./host-wakeup-fixture.js";

test("real Host formatter projects full prompt/context and exactly roundtrips original", async () => {
  const { item } = await createRealHostWakeupFixture("trigger");
  const view = triggerMessagePresentation(item.text, item.sourceId);
  assert.equal(view.name, "Release check");
  assert.match(view.text, /^Inspect the release/u);
  assert.match(view.text, /Bounded source context/u);
  assert.equal(view.envelope! + view.text, item.text);
});

test("prompt markers, long content, whitespace and all context are preserved without a second parse", () => {
  const body = `  Explain this marker:\n\nInjected prompt:\nRegistered trigger: not a source\n${"中文 long text ".repeat(500)}\n\nBounded source context (read-only projection):\nkeep this\n`;
  const envelope =
    "[ZenX trigger wakeup]\nTrigger ID: exact/id\nReason: timer\nRegistered trigger: Daily review\n\nInjected prompt:\n";
  const view = triggerMessagePresentation(envelope + body, "exact/id");
  assert.equal(view.text, body);
  assert.equal(view.name, "Daily review");
  assert.equal(view.envelope! + view.text, envelope + body);
});

test("unknown, legacy, malformed, mismatched and ambiguous multiline headers remain completely visible", () => {
  const valid =
    "[ZenX trigger wakeup]\nTrigger ID: id\nReason: timer\nRegistered trigger: Daily\n\nInjected prompt:\nbody";
  for (const text of [
    "ordinary content",
    valid.replace("Trigger ID: id", "Trigger ID: other"),
    valid.replace("Reason: timer", "Reason: timer\nunknown field"),
    valid.replace(
      "Registered trigger: Daily",
      "Registered trigger: Daily\nextra",
    ),
    valid.replace(
      "Reason: timer",
      "Reason: timer\n\nInjected prompt:\nInjected body",
    ),
  ]) {
    assert.deepEqual(triggerMessagePresentation(text, "id"), { text });
  }
  assert.deepEqual(triggerMessagePresentation(valid), { text: valid });
});
