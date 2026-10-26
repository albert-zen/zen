import assert from "node:assert/strict";
import test from "node:test";
import {
  ContextCalibration,
  type ContextEstimateRequest,
} from "../src/context-calibration.js";
import { estimateModelInput } from "../src/model-usage.js";
import type { CanonicalItem } from "../src/item.js";
import type { ModelAdapter } from "../src/model.js";

function request(): ContextEstimateRequest {
  return {
    threadId: "thread",
    items: [],
    adapter: { provider: "protocol", async *stream() {} } as ModelAdapter,
    selection: {
      providerProfileId: "profile",
      modelId: "model",
      reasoningEffort: null,
    },
    messages: [{ role: "user", text: "中文输入".repeat(100) }],
    tools: [
      {
        name: "tool",
        description: "tool",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };
}
const sum = (e: ReturnType<typeof estimateModelInput>) =>
  e.instructions + e.toolDefinitions + e.pluginContext + e.conversation;

test("same-request provider input anchors one total; append-only delta and categories stay additive", () => {
  const c = new ContextCalibration();
  const r = request();
  const first = c.prepare(r);
  assert.deepEqual(first.estimate, estimateModelInput(r.messages, r.tools));
  c.record(r.threadId, first.receipt, 731);
  assert.equal(c.prepare(r).estimate.total, 731);
  const next = {
    ...r,
    messages: [...r.messages, { role: "user" as const, text: "next result" }],
  };
  const raw = estimateModelInput(next.messages, next.tools);
  const expected = 731 + raw.total - first.receipt.rawTotal;
  assert.equal(c.prepare(next).estimate.total, expected);
  assert.equal(sum(c.prepare(next).estimate), expected);
  assert.ok(
    Object.values(c.prepare(next).estimate).every(Number.isSafeInteger),
  );
  // The next response replaces the anchor, never accumulates thread input.
  const second = c.prepare(next);
  c.record(r.threadId, second.receipt, 811);
  assert.equal(c.prepare(next).estimate.total, 811);
});
test("scope, adapter generation, rewritten prefixes, and compaction invalidate the anchor", () => {
  const c = new ContextCalibration();
  const r = request();
  c.record(r.threadId, c.prepare(r).receipt, 731);
  const cases: ContextEstimateRequest[] = [
    { ...r, threadId: "other" },
    { ...r, adapter: { ...r.adapter } },
    { ...r, selection: { ...r.selection, modelId: "other" } },
    { ...r, selection: { ...r.selection, providerProfileId: "other" } },
    { ...r, selection: { ...r.selection, reasoningEffort: "high" } },
    { ...r, tools: [{ ...r.tools[0]!, description: "changed" }] },
    { ...r, inputModalities: ["text"] },
    { ...r, messages: [{ role: "user", text: "rewritten history" }] },
    { ...r, messages: [] },
    {
      ...r,
      items: [{ id: "compacted", type: "context_compaction" } as CanonicalItem],
    },
  ];
  for (const changed of cases)
    assert.deepEqual(
      c.prepare(changed).estimate,
      estimateModelInput(
        changed.messages,
        changed.tools,
        changed.adapter.contextInstructions,
      ),
    );
});
test("new static instructions, protocol and disposed media never reuse an old receipt", () => {
  const c = new ContextCalibration();
  const r = request();
  c.record(r.threadId, c.prepare(r).receipt, 731);
  Object.defineProperty(r.adapter, "contextInstructions", {
    value: "new static instructions",
    configurable: true,
  });
  assert.deepEqual(
    c.prepare(r).estimate,
    estimateModelInput(r.messages, r.tools, "new static instructions"),
  );
  Object.defineProperty(r.adapter, "contextInstructions", { value: undefined });
  Object.defineProperty(r.adapter, "provider", { value: "new protocol" });
  assert.deepEqual(
    c.prepare(r).estimate,
    estimateModelInput(r.messages, r.tools),
  );
});
test("absent or invalid usage and restart do not invent calibration; cache subset is not added", () => {
  const c = new ContextCalibration();
  const r = request();
  const before = c.prepare(r);
  for (const count of [
    NaN,
    Infinity,
    -1,
    0,
    1.2,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    c.record(r.threadId, before.receipt, count);
    assert.deepEqual(c.prepare(r).estimate, before.estimate);
  }
  const providerUsage = { inputTokens: 731, cachedInputTokens: 700 };
  c.record(r.threadId, before.receipt, providerUsage.inputTokens);
  assert.equal(c.prepare(r).estimate.total, 731);
  assert.deepEqual(
    new ContextCalibration().prepare(r).estimate,
    before.estimate,
  );
});

test("allocation stays exact at safe-integer scale and changed media is not an append", () => {
  const c = new ContextCalibration();
  const r = request();
  c.record(r.threadId, c.prepare(r).receipt, Number.MAX_SAFE_INTEGER);
  const calibrated = c.prepare(r).estimate;
  assert.equal(sum(calibrated), Number.MAX_SAFE_INTEGER);
  const altered = {
    ...r,
    messages: [
      {
        role: "tool" as const,
        callId: "image",
        exitCode: 0,
        text: "media omitted after recovery",
      },
    ],
  };
  assert.deepEqual(
    c.prepare(altered).estimate,
    estimateModelInput(altered.messages, altered.tools),
  );
});
