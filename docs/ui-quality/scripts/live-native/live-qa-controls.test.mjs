import assert from "node:assert/strict";
import test from "node:test";
import { installLiveQa } from "./live-qa-controls.mjs";

function fixture() {
  let originalCalls = 0;
  class FakeModel {
    async *stream() {
      originalCalls++;
      yield {
        type: "tool_call",
        name: "shell",
        arguments: { command: "must not dispatch" },
      };
    }
  }
  class ZenAppServer {
    async sendMessage() {}
    async startTurn() {}
    async queueMessage() {}
    async stageSteerMessage() {}
    async replaceTurn() {}
  }
  class AppServerError extends Error {}
  installLiveQa({
    FakeModel,
    ZenAppServer,
    AppServerError,
    intervalMs: 1,
    failureMs: 1,
    admissionMs: 1,
    chunks: 2,
  });
  return {
    model: new FakeModel(),
    originalCalls: () => originalCalls,
  };
}

const request = (message, tools = []) => ({
  model: "fake",
  reasoningEffort: null,
  messages: [{ role: "user", ...message }],
  tools,
  signal: new AbortController().signal,
});
const collect = async (model, input) => {
  const events = [];
  for await (const event of model.stream(input)) events.push(event);
  return events;
};
const onlyTextAndUsage = (events) =>
  assert(events.every((event) => ["text_delta", "usage"].includes(event.type)));

test("ordinary non-QA input is a local echo, never production FakeModel fallback", async () => {
  const f = fixture();
  for (const message of [
    { text: "A normal edited message." },
    {
      content: [
        { type: "text", text: "Queue first" },
        { type: "text", text: "Steer second" },
      ],
    },
    { text: "QA_UNRECOGNIZED and !tool mentioned as prose." },
  ]) {
    const events = await collect(
      f.model,
      request(message, [{ name: "shell" }]),
    );
    onlyTextAndUsage(events);
    assert.match(events[0].delta, /^Echo: /u);
  }
  assert.equal(f.originalCalls(), 0);
});

for (const command of ["!shell echo unsafe", "!tool shell {}"])
  for (const shape of [
    "plain",
    "typed",
    "second-part",
    "qa-first-part",
    "indented-line",
  ])
    test(`rejects ${command.split(" ")[0]} in ${shape} before any output`, async () => {
      const f = fixture();
      const message =
        shape === "plain"
          ? { text: command }
          : shape === "typed"
            ? { content: [{ type: "text", text: command }] }
            : shape === "second-part"
              ? {
                  content: [
                    { type: "text", text: "ordinary input" },
                    { type: "text", text: command },
                  ],
                }
              : shape === "qa-first-part"
                ? {
                    content: [
                      { type: "text", text: "QA_STREAM" },
                      { type: "text", text: command },
                    ],
                  }
                : { text: `ordinary input\n  ${command}` };
      const events = [];
      await assert.rejects(
        async () => {
          for await (const event of f.model.stream(
            request(message, [{ name: "shell" }]),
          ))
            events.push(event);
        },
        (error) =>
          error.modelRecoveryBlocked === true &&
          /rejects !shell and !tool/u.test(error.message),
      );
      assert.deepEqual(events, []);
      assert.equal(f.originalCalls(), 0);
    });

test("supported stream/hold and admission text paths still produce text/usage only", async () => {
  const f = fixture();
  for (const text of [
    "QA_STREAM",
    "QA_HOLD",
    "QA_ADMIT: ordinary admitted text",
    "QA_REJECT: adapter-only text",
  ])
    onlyTextAndUsage(await collect(f.model, request({ text })));
  const seen = [];
  await assert.rejects(
    async () => {
      for await (const event of f.model.stream(request({ text: "QA_FAIL" })))
        seen.push(event);
    },
    (error) =>
      error.modelRecoveryBlocked === true &&
      /Synthetic QA provider failure/u.test(error.message),
  );
  onlyTextAndUsage(seen);
  assert.equal(f.originalCalls(), 0);
});
