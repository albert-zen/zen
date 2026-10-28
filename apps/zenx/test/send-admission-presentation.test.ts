import assert from "node:assert/strict";
import test from "node:test";
import { withRuntimeDom } from "./agent-runtime-dom.js";
import { runtimeThread, runtimeIntro } from "./fixtures/agent-runtime-data.js";

test("initial durable input delay displays preparation, not elapsed agent work before the user bubble", async () => {
  await withRuntimeDom(async (h) => {
    // A real turn_started may arrive before user_message append completes.
    const admitting = runtimeThread([]);
    await h.render(admitting);
    assert.equal(document.querySelector(".user-row"), null);
    assert.equal(Boolean(document.querySelector(".turn-duration")), false);
    assert.equal(
      document.querySelector(".turn-running-label")?.getAttribute("data-phase"),
      "admitting",
    );
    assert.equal(
      document.querySelector(".turn-work-label")?.textContent,
      "Preparing",
    );

    const admitted = {
      ...admitting,
      turns: admitting.turns.map((turn) => ({
        ...turn,
        items: [runtimeIntro[0]!],
      })),
    };
    await h.render(admitted);
    const turn = document.querySelector(".turn")!;
    const input = turn.querySelector(".user-row")!;
    const work = turn.querySelector(".turn-running-label")!;
    assert.ok(input, "only the admitted user message appears");
    assert.ok(work.querySelector(".turn-duration"));
    assert.ok(
      [...turn.children].indexOf(input) < [...turn.children].indexOf(work),
      "input precedes work duration",
    );
  });
});
