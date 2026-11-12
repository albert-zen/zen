import assert from "node:assert/strict";
import test from "node:test";
import {
  foregroundAgentName,
  stopForegroundOwner,
} from "../src/main/foreground-activity-owner.js";
import type { ZenXRoom } from "../src/main/trigger-types.js";

const rooms = [
  { members: [{ threadId: "a", name: "Atlas" }] },
  {
    members: [
      { threadId: "a", name: "Atlas" },
      { threadId: "b", name: "Birch" },
    ],
  },
] as ZenXRoom[];
test("foreground identity uses unique trusted Room membership with a generic fallback", () => {
  assert.equal(foregroundAgentName("a", rooms), "Atlas");
  assert.equal(foregroundAgentName("b", rooms), "Birch");
  assert.equal(foregroundAgentName("unknown", rooms), "ZenX Agent");
  assert.equal(foregroundAgentName(undefined, rooms), "ZenX Agent");
  assert.equal(
    foregroundAgentName("a", [
      ...rooms,
      { members: [{ threadId: "a", name: "Other" }] } as ZenXRoom,
    ]),
    "ZenX Agent",
  );
});

function fixture(
  options: {
    status?: string;
    id?: string;
    call?: string;
    rejection?: unknown;
  } = {},
) {
  const calls: { method: string; params: unknown }[] = [];
  const port = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "turn/interrupt") {
        if (options.rejection) throw options.rejection;
        return {};
      }
      return {
        thread: {
          id: options.id ?? "a",
          items: [
            {
              id: options.call ?? "call",
              type: "tool_call",
              turnId: "old-turn",
            },
          ],
          turns: [
            { id: "old-turn", status: options.status ?? "inProgress" },
            { id: "new-turn", status: "inProgress" },
          ],
        },
      };
    },
  } as Parameters<typeof stopForegroundOwner>[0];
  return { port, calls };
}
test("Stop interrupts only the canonical call's exact active Turn", async () => {
  const { port, calls } = fixture();
  await stopForegroundOwner(port, {
    threadId: "a",
    canonicalToolCallId: "call",
  });
  assert.deepEqual(calls[1], {
    method: "turn/interrupt",
    params: { threadId: "a", turnId: "old-turn" },
  });
});
test("missing identity, old calls, unavailable items and wrong-thread replies cannot interrupt a newer Turn", async () => {
  for (const options of [
    { status: "completed" },
    { id: "other" },
    { call: "unrelated" },
  ]) {
    const f = fixture(options);
    await stopForegroundOwner(f.port, {
      threadId: "a",
      canonicalToolCallId: "call",
    });
    assert.equal(f.calls.length, 1);
  }
  const f = fixture();
  await stopForegroundOwner(f.port, { threadId: "a" });
  assert.equal(f.calls.length, 0);
});
test("natural completion races are never retried against a different Turn", async () => {
  const f = fixture({ rejection: { data: { zenCode: "turn_not_running" } } });
  await stopForegroundOwner(f.port, {
    threadId: "a",
    canonicalToolCallId: "call",
  });
  assert.equal(f.calls.length, 2);
  const g = fixture({ rejection: new Error("transport failed") });
  await assert.rejects(
    stopForegroundOwner(g.port, { threadId: "a", canonicalToolCallId: "call" }),
    /transport failed/,
  );
  assert.equal(g.calls.length, 2);
});
