import assert from "node:assert/strict";
import test from "node:test";
import { observeSendActivation } from "../src/renderer/src/send-observation.js";
import { parseClientSendObservation } from "../../../src/client-observation.js";
import {
  beginComposerSubmission,
  editComposer,
  emptyComposerState,
  failComposerSubmission,
} from "../src/renderer/src/composer-state.js";
test("UI activation clock is captured synchronously and submission retries retain only semantic identity", async () => {
  const first = observeSendActivation();
  let state = beginComposerSubmission(
    editComposer(emptyComposerState(), "synthetic"),
    "start",
    null,
    () => "client",
    first,
  );
  assert.equal(state.submission?.clientObservation, first);
  await Promise.resolve();
  const second = observeSendActivation();
  assert.equal(first.clock.domain, second.clock.domain);
  assert(BigInt(second.clock.monotonicNs) >= BigInt(first.clock.monotonicNs));
  assert.notEqual(first.requestId, second.requestId);
  state = beginComposerSubmission(
    failComposerSubmission(state, "client", "unknown"),
    "start",
    null,
    () => "wrong",
    second,
  );
  assert.equal(state.submission?.clientUserMessageId, "client");
  assert.equal(state.submission?.clientObservation, second);
});
test("reported clock decoder admits only bounded facts, not body or actor assertions", () => {
  const reported = observeSendActivation();
  assert.deepEqual(
    parseClientSendObservation({
      ...reported,
      actor: "human",
      input: "not telemetry",
    }),
    reported,
  );
  assert.equal(
    parseClientSendObservation({
      ...reported,
      clock: { ...reported.clock, monotonicNs: "-1" },
    }),
    undefined,
  );
  assert.equal(
    parseClientSendObservation({ ...reported, requestId: "x".repeat(201) }),
    undefined,
  );
});
