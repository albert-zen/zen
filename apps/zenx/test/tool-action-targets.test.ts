import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalItem } from "../../../src/item.js";
import { ModelReferenceRegistry } from "../../../src/model-references.js";
import { projectThreadResult } from "../src/main/capabilities/model-thread-facade.js";
import {
  projectToolActionTargets,
  resolveDeliveredMessage,
} from "../src/renderer/src/tool-action-targets.js";
const base = { threadId: "source", createdAt: "2026-10-28T00:00:00Z" };
const call = (name = "zenx_threads_send") =>
  ({
    ...base,
    id: "call",
    type: "tool_call",
    turnId: "turn",
    callId: "wire-call",
    name,
    arguments: { target: "Same name" },
  }) as CanonicalItem;
const result = (output: object, referenceBindings: unknown[] = []) =>
  ({
    ...base,
    id: "result",
    type: "tool_result",
    turnId: "turn",
    callId: "wire-call",
    output: JSON.stringify(output),
    exitCode: 0,
    referenceBindings,
  }) as CanonicalItem;

test("send receipt retains a compact exact-message reference, never native IDs in model output", () => {
  const refs = new ModelReferenceRegistry().scope("source");
  const output = projectThreadResult(
    {
      threadId: "destination-long-id",
      messageId: "delivered-long-id",
      queued: false,
    },
    {},
    refs,
  );
  assert.equal(typeof output.message, "string");
  assert.doesNotMatch(
    JSON.stringify(output),
    /destination-long-id|delivered-long-id/,
  );
  const actions = projectToolActionTargets("source", [
    call(),
    result(output, [...refs.newBindings]),
  ]);
  assert.deepEqual(actions.get("call"), {
    target: {
      kind: "thread",
      id: "destination-long-id",
      itemId: "delivered-long-id",
    },
    label: "message",
  });
});

test("trigger result uses exact bound definition, not same-name arguments or labels", () => {
  const binding = {
    ref: "r1",
    ownerThreadId: "source",
    namespace: "triggers",
    kind: "trigger",
    value: { id: "exact-trigger" },
  };
  const actions = projectToolActionTargets("source", [
    call("zenx_triggers_update"),
    result({ ref: "r1", label: "Same name" }, [binding]),
  ]);
  assert.deepEqual(actions.get("call"), {
    target: { kind: "trigger", id: "exact-trigger" },
    label: "trigger",
  });
});

test("legacy successful native receipts stay linkable; missing identities never guess", () => {
  assert.deepEqual(
    projectToolActionTargets("source", [
      call(),
      result({ threadId: "destination", messageId: "actual-message" }),
    ]).get("call"),
    {
      target: { kind: "thread", id: "destination", itemId: "actual-message" },
      label: "message",
    },
  );
  assert.deepEqual(
    projectToolActionTargets("source", [call(), result({ ref: "r1" })]).get(
      "call",
    ),
    { unavailable: "missing", label: "message" },
  );
  assert.equal(
    projectToolActionTargets("source", [
      call("custom_send"),
      result({ threadId: "destination", messageId: "actual-message" }),
    ]).size,
    0,
  );
});

test("exact message resolution follows the canonical queued identity, never text or most recent message", () => {
  const items = [
    {
      ...base,
      threadId: "destination",
      id: "queued",
      type: "thread_message_queued",
      clientId: "receipt-client",
      sender: {},
      input: [],
    },
    {
      ...base,
      threadId: "destination",
      id: "wrong",
      type: "thread_message",
      clientId: "different",
      turnId: "turn",
      content: [],
    },
    {
      ...base,
      threadId: "destination",
      id: "delivered",
      type: "thread_message",
      clientId: "receipt-client",
      turnId: "turn",
      content: [],
    },
  ] as unknown as CanonicalItem[];
  assert.deepEqual(resolveDeliveredMessage(items, "queued"), {
    itemId: "delivered",
  });
  assert.deepEqual(resolveDeliveredMessage(items, "delivered"), {
    itemId: "delivered",
  });
  assert.equal(resolveDeliveredMessage(items, "unknown"), "missing");
  assert.equal(resolveDeliveredMessage(items.slice(0, 1), "queued"), "pending");
});
