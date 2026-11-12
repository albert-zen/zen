import assert from "node:assert/strict";
import test from "node:test";
import { startMockModelServer } from "../scripts/mock-model-server.mjs";
import { OpenAiCompatibleModel } from "../../../src/model/openai-compatible.js";
const tool = {
  name: "shell",
  description: "Test shell",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};
test("real compatible adapter reads mock text, tool request/result, error and cancellation without credentials", async () => {
  const server = await startMockModelServer();
  const adapter = new OpenAiCompatibleModel({
    baseUrl: server.url,
    apiKey: "local-mock-only",
  });
  const request = (text, overrides = {}) => ({
    model: "zenx-mock",
    reasoningEffort: "medium",
    messages: [{ role: "user", text }],
    tools: [tool],
    signal: new AbortController().signal,
    ...overrides,
  });
  const collect = async (req) => {
    const values = [];
    for await (const event of adapter.stream(req)) values.push(event);
    return values;
  };
  try {
    const plain = await collect(request("hello"));
    assert.match(
      plain
        .filter((x) => x.type === "text_delta")
        .map((x) => x.delta)
        .join(""),
      /local simulated response/,
    );
    const calls = await collect(request("[mock:tool]"));
    const call = calls.find((x) => x.type === "tool_call");
    assert.equal(call?.name, "shell");
    assert.match(call.arguments.command, /mock-tool-ok/);
    const answer = await collect(
      request("[mock:tool]", {
        messages: [
          { role: "user", text: "[mock:tool]" },
          { role: "assistant", toolCalls: [call] },
          {
            role: "tool",
            callId: call.callId,
            text: "mock-tool-ok",
            exitCode: 0,
          },
        ],
      }),
    );
    assert.match(
      answer
        .filter((x) => x.type === "text_delta")
        .map((x) => x.delta)
        .join(""),
      /mock-tool-ok/,
    );
    await assert.rejects(collect(request("[mock:error]")), /HTTP 400/);
    const controller = new AbortController();
    let chunks = 0;
    await assert.rejects(async () => {
      for await (const event of adapter.stream(
        request("[mock:slow]", { signal: controller.signal }),
      )) {
        if (event.type === "text_delta") {
          chunks++;
          controller.abort();
        }
      }
    });
    assert.ok(chunks > 0);
  } finally {
    await server.close();
  }
});
