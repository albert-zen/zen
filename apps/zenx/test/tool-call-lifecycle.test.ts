import assert from "node:assert/strict";
import test from "node:test";
import { withRuntimeDom } from "./agent-runtime-dom.js";
import {
  runtimeCommand,
  runtimeMessage,
  runtimeTask,
  runtimeThread,
  runtimeWait,
} from "./fixtures/agent-runtime-data.js";
import {
  commandPhase,
  commandStatus,
} from "../src/renderer/src/tool-presentation.js";
import { summarizeTraceActivity } from "../src/renderer/src/turn-projection.js";

for (const taskStatus of [
  "admitting",
  "queued",
  "running",
  "cancel_requested",
  "cancellation_unconfirmed",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
] as const) {
  test(`a returned call is completed independently of its ${taskStatus} process receipt`, () => {
    for (const status of ["completed", "failed", "declined"] as const) {
      const call = runtimeTask("call", "task", taskStatus, status);
      const before = structuredClone(call);
      assert.equal(commandPhase(call), "completed");
      assert.equal(commandStatus(call), "Completed");
      assert.equal(summarizeTraceActivity([call]).active, 0);
      assert.deepEqual(
        call,
        before,
        "presentation does not rewrite the receipt",
      );
    }
  });
}

test("yield, another pending wait, interruption and a late receipt never reactivate a returned invocation", async () => {
  await withRuntimeDom(async (h) => {
    const yielded = runtimeTask("start", "task", "running");
    const pending = {
      ...runtimeWait("wait", "task"),
      status: "inProgress" as const,
      aggregatedOutput: null,
      structuredContent: undefined,
      contentType: undefined,
    };
    await h.render(runtimeThread([yielded]));
    assert.equal(
      document.querySelector('[data-active="true"]'),
      null,
      "a returned call cannot keep a sweep/spinner while its process lives",
    );
    await h.render(
      runtimeThread([
        yielded,
        runtimeMessage("separator", "Checking output"),
        pending,
      ]),
    );
    const sequences = document.querySelectorAll(".trace-singleton");
    assert.equal(sequences[0]!.querySelector('[data-active="true"]'), null);
    assert.ok(
      sequences[1]!.querySelector(".mini-spinner"),
      "only the pending invocation spins",
    );
    await h.render(
      runtimeThread(
        [yielded, runtimeMessage("separator", "Checking output"), pending],
        "interrupted",
      ),
    );
    assert.equal(document.querySelector(".turn-history"), null);
    assert.equal(
      document.querySelector(
        ".trace-counts, .turn-outcome-primary-action, .turn-outcome-review",
      ),
      null,
    );
    assert.doesNotMatch(
      document.body.textContent!,
      /background.*running|awaiting.*task.*result|cancelled or declined/iu,
    );
    await h.click(".turn-toggle");
    assert.equal(
      document.querySelector(
        ".turn-history .mini-spinner, .turn-history [data-active='true']",
      ),
      null,
    );
    assert.match(
      document.querySelectorAll(".trace-singleton")[1]!.textContent!,
      /unknown|no.*result/iu,
      "a stopped turn is not a tool receipt",
    );
    const late = {
      ...pending,
      status: "failed" as const,
      aggregatedOutput: "synthetic command error",
      exitCode: 2,
    };
    await h.render(
      runtimeThread(
        [yielded, runtimeMessage("separator", "Checking output"), late],
        "interrupted",
      ),
    );
    assert.equal(
      document.querySelector(
        ".turn-history .mini-spinner, .turn-history [data-active='true']",
      ),
      null,
    );
    await h.click(".trace-singleton:last-child .trace-item-toggle");
    assert.match(
      document.querySelector(".trace-detail")!.textContent!,
      /synthetic command error/,
    );
    assert.doesNotMatch(
      document
        .querySelectorAll(".trace-singleton")[1]!
        .querySelector(".trace-item-toggle")!.textContent!,
      /failed|cancelled|waiting|waited|ended/iu,
    );
  });
});

test("unknown calls remain unknown and actual errors complete the invocation without pretending success", () => {
  assert.equal(
    commandPhase(runtimeCommand("missing", "pwd", "unknown")),
    "unknown",
  );
  assert.equal(
    commandPhase(runtimeCommand("pending", "pwd", "inProgress")),
    "requested",
  );
  assert.equal(
    commandPhase(runtimeCommand("error", "pwd", "failed")),
    "completed",
  );
});
