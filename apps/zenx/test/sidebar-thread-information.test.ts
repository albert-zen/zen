import assert from "node:assert/strict";
import test from "node:test";
import {
  nextSidebarTrigger,
  sidebarTriggerFacts,
} from "../src/renderer/src/sidebar-thread-information.js";
const timer = (nextRunAt: number, active = true) => ({
  id: String(nextRunAt),
  threadId: "thread",
  kind: "timer",
  active,
  nextRunAt,
});
test("next automation uses earliest finite future, excludes paused/due and reports unknown facts", () => {
  assert.deepEqual(
    nextSidebarTrigger([timer(70), timer(30), timer(20, false)], 25),
    { nextRunAt: 30, incomplete: false, state: "scheduled" },
  );
  assert.deepEqual(nextSidebarTrigger([timer(24), timer(70), timer(NaN)], 25), {
    nextRunAt: 70,
    incomplete: true,
    state: "scheduled",
  });
  assert.equal(nextSidebarTrigger([timer(25)], 25).state, "unknown");
  assert.equal(nextSidebarTrigger([timer(1e25)], 25).state, "unknown");
  assert.equal(nextSidebarTrigger([timer(70, false)], 25).state, "paused");
  assert.equal(
    nextSidebarTrigger(
      [{ id: "e", threadId: "t", kind: "roomMention", active: true }],
      25,
    ).state,
    "event",
  );
  assert.equal(
    nextSidebarTrigger([{ ...timer(70), sourceError: "offline" }], 25)
      .nextRunAt,
    null,
  );
});
test("narrow automation projection validates identity without copying prompts or history", () => {
  assert.deepEqual(
    sidebarTriggerFacts({
      triggers: [
        {
          ...timer(60),
          timer: { nextRunAt: 60 },
          prompt: "private",
          history: [],
        },
      ],
    }),
    [timer(60)],
  );
  assert.throws(() => sidebarTriggerFacts({ triggers: [{ id: "bad" }] }));
});

test("definition errors and unknown timers do not invent the next trigger", () => {
  const facts = sidebarTriggerFacts({
    triggers: [
      {
        id: "broken",
        threadId: "t",
        kind: "timer",
        active: true,
        timer: { nextRunAt: "tomorrow" },
      },
    ],
  });
  assert.deepEqual(nextSidebarTrigger(facts, 0), {
    nextRunAt: null,
    incomplete: true,
    state: "unknown",
  });
});
