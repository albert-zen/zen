import assert from "node:assert/strict";
import test from "node:test";
import type { Thread } from "../src/protocol-client/index.js";
import type { QueuedInputItem } from "../../../src/item.js";
import { withRuntimeDom } from "./agent-runtime-dom.js";
import { applyQueueItem, queueScenario } from "./fixtures/agent-queue-data.js";

const base = {
  id: "pending-source",
  threadId: "runtime-thread",
  clientId: "pending-client",
  createdAt: "2026-11-03T00:00:00.000Z",
  input: [{ type: "text" as const, text: "Synthetic pending message" }],
  deliveryMode: "batch-next" as const,
};
const agent = (messageType: "guidance" | "follow_up"): QueuedInputItem => ({
  ...base,
  type: "thread_message_queued",
  messageType,
  sender: {
    threadId: "source",
    toolCallId: "source-tool",
    callId: "source-call",
  },
});
const host = (intent: "steer" | "queue"): QueuedInputItem => ({
  ...base,
  type: "host_message_queued",
  sender: "host",
  source: "bootstrap",
  text: "Synthetic Host message",
  intent,
});
for (const [name, inputs, waits] of [
  ["explicit follow-up", [agent("follow_up")], true],
  ["ordinary Agent guidance", [agent("guidance")], false],
  ["Host steer", [host("steer")], false],
  ["explicit Host queue", [host("queue")], true],
  [
    "mixed guidance and follow-up",
    [
      agent("guidance"),
      { ...agent("follow_up"), id: "second", clientId: "second-client" },
    ],
    false,
  ],
] as const) {
  test(`Queue count uses canonical timing for ${name}`, async () => {
    await withRuntimeDom(async (h) => {
      const seed = queueScenario(1);
      let thread: Thread = {
        ...seed,
        queuedMessages: [],
        canonicalItems: seed.canonicalItems!.filter(
          (item) => item.type !== "user_message_queued",
        ),
      };
      for (const item of inputs) thread = applyQueueItem(thread, item);
      await h.render(thread);
      const label = document.querySelector(".queue-shelf-toggle")!.textContent!;
      assert.equal(label.startsWith("After this turn"), waits);
      assert.ok(label.includes(` · ${inputs.length} message`));
    });
  });
}
for (const mismatch of ["client", "revision", "owner", "missing"] as const) {
  test(`Queue count does not invent delivery timing for ${mismatch} mismatch`, async () => {
    await withRuntimeDom(async (h) => {
      const thread = queueScenario(1);
      if (mismatch === "missing") thread.canonicalItems = [];
      else if (mismatch === "owner") thread.id = "other-thread";
      else
        thread.queuedMessages = thread.queuedMessages!.map((message) => ({
          ...message,
          ...(mismatch === "client"
            ? { clientId: "different-client" }
            : { revision: 9 }),
        }));
      await h.render(thread);
      assert.match(
        document.querySelector(".queue-shelf-toggle")!.textContent!,
        /^Pending send · 1 message$/,
      );
    });
  });
}
