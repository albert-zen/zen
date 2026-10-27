import assert from "node:assert/strict";
import test from "node:test";
import { createManualTurnRetryRequester } from "../src/renderer/src/manual-turn-retry.js";
import { recoveryScenario } from "./fixtures/loop-recovery-scenario.js";
import {
  editComposer,
  emptyComposerState,
} from "../src/renderer/src/composer-state.js";

function gate() {
  let resolve!: (value: { turnId: string }) => void;
  const promise = new Promise<{ turnId: string }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("manual retry coalesces main/side duplicate clicks with one stable request identity", async () => {
  const response = gate();
  const calls: unknown[] = [];
  const retry = createManualTurnRetryRequester(
    async (params) => {
      calls.push(params);
      return response.promise;
    },
    () => "manual-1",
  );
  const thread = recoveryScenario("failed", "reload");
  const first = retry(thread, thread.turns[0]!.id);
  const duplicate = retry(thread, thread.turns[0]!.id);
  assert.equal(first, duplicate);
  await Promise.resolve();
  assert.deepEqual(calls.map(withoutObservation), [
    {
      threadId: thread.id,
      expectedTurnId: thread.turns[0]!.id,
      clientUserMessageId: "manual-1",
      language: "en",
    },
  ]);
  response.resolve({ turnId: "continuation-1" });
  await first;
  await retry(thread, thread.turns[0]!.id);
  assert.equal(
    calls.length,
    1,
    "stale view cannot launch twice after acceptance",
  );
});

test("ambiguous retry failure retains request identity and never reads or rewrites a draft", async () => {
  const calls: unknown[] = [];
  let ids = 0;
  const retry = createManualTurnRetryRequester(
    async (params) => {
      calls.push(params);
      if (calls.length === 1) throw new Error("transport disconnected");
      return { turnId: "continued" };
    },
    () => `manual-${++ids}`,
  );
  const thread = recoveryScenario("stopped", "reload");
  const draft = editComposer(emptyComposerState(), "Unrelated unsent draft 📝");
  // Draft text, image references and caret live outside this action's API.
  const before = structuredClone(draft);
  await assert.rejects(retry(thread, thread.turns[0]!.id), /disconnected/);
  await retry(thread, thread.turns[0]!.id);
  assert.deepEqual(withoutObservation(calls[0]), withoutObservation(calls[1]));
  assert.notDeepEqual(
    (calls[0] as { clientObservation: unknown }).clientObservation,
    (calls[1] as { clientObservation: unknown }).clientObservation,
  );
  assert.equal(ids, 1);
  assert.deepEqual(draft, before);
});

for (const phase of [
  "running",
  "recovering",
  "continuing",
  "completed",
] as const) {
  test(`manual retry rejects ${phase} locally without sending`, async () => {
    let sent = false;
    const retry = createManualTurnRetryRequester(async () => {
      sent = true;
      return { turnId: "bad" };
    });
    const thread = recoveryScenario(phase, "reload");
    await assert.rejects(retry(thread, thread.turns[0]!.id), /no longer/);
    assert.equal(sent, false);
  });
}

test("manual retry refuses historical targets and leaves canonical data unchanged", async () => {
  let sent = false;
  const retry = createManualTurnRetryRequester(async () => {
    sent = true;
    return { turnId: "bad" };
  });
  const thread = recoveryScenario("failed", "reload");
  thread.turns.push({ ...thread.turns[0]!, id: "newer", status: "completed" });
  const before = structuredClone(thread);
  await assert.rejects(retry(thread, thread.turns[0]!.id), /no longer/);
  assert.equal(sent, false);
  assert.deepEqual(thread, before);
});

test("retry freezes localized continuation language across ambiguous acknowledgements", async () => {
  const calls: Array<{ language: string; clientUserMessageId: string }> = [];
  let language: "zh-CN" | "en" = "zh-CN";
  const retry = createManualTurnRetryRequester(
    async (params) => {
      calls.push(params);
      return { turnId: calls.length === 1 ? "" : "continued" };
    },
    () => "localized-1",
    () => language,
  );
  const thread = recoveryScenario("failed", "reload");
  await assert.rejects(retry(thread, thread.turns[0]!.id), /unconfirmed/);
  language = "en";
  await retry(thread, thread.turns[0]!.id);
  assert.deepEqual(
    calls.map(({ language }) => language),
    ["zh-CN", "zh-CN"],
  );
  assert.deepEqual(withoutObservation(calls[0]), withoutObservation(calls[1]));
  assert.notDeepEqual(
    (calls[0] as { clientObservation: unknown }).clientObservation,
    (calls[1] as { clientObservation: unknown }).clientObservation,
  );
  assert.equal(
    "input" in calls[0]!,
    false,
    "unsent composer input is never a retry parameter",
  );
});

function withoutObservation(value: unknown) {
  const { clientObservation: _observation, ...semantic } = value as Record<
    string,
    unknown
  >;
  return semantic;
}
