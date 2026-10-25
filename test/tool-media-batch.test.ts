import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRequest, ModelMessage } from "../src/model.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";

function validateBatches(messages: any[]) {
  let pending = new Set<string>();
  for (const message of messages) {
    if (pending.size) {
      assert.equal(
        message.role,
        "tool",
        "all pending tool replies must precede supplemental media",
      );
      assert.ok(pending.delete(message.tool_call_id));
    } else if (message.role === "assistant" && message.tool_calls?.length) {
      pending = new Set(message.tool_calls.map((call: any) => call.id));
    }
  }
  assert.equal(pending.size, 0);
}
const image = {
  type: "image" as const,
  attachment: {
    type: "attachment" as const,
    sha256: "a".repeat(64),
    mediaType: "image/png",
    byteLength: 3,
  },
};
const batch = (prefix: string, media: number[]): ModelMessage[] => [
  {
    role: "assistant",
    toolCalls: [0, 1, 2].map((i) => ({
      callId: `${prefix}${i}`,
      name: "fixture",
      arguments: {},
    })),
  },
  ...[0, 1, 2].map((i) => ({
    role: "tool" as const,
    callId: `${prefix}${i}`,
    text: `receipt ${prefix}${i}`,
    exitCode: 0,
    ...(media.includes(i)
      ? {
          modelContent: [
            { type: "text" as const, text: `media ${prefix}${i}` },
            image,
          ],
        }
      : {}),
  })),
];
for (const terminal of [false, true, "reasoning"] as const) {
  for (const positions of [[0], [1], [2], [0, 1, 2], []]) {
    test(`Chat preserves parallel reply batch for media positions ${positions}, terminal=${terminal}`, async () => {
      const messages: ModelMessage[] = [
        { role: "user", text: "before" },
        ...batch("a", positions),
        ...batch("b", [0, 2]),
        ...(terminal === "reasoning"
          ? [
              {
                role: "reasoning" as const,
                reasoningContent: "synthetic reasoning",
                contentVisibility: "public" as const,
              },
            ]
          : terminal
            ? []
            : [{ role: "user" as const, text: "after" }]),
      ];
      const original = structuredClone(messages);
      let body: any;
      const adapter = new OpenAiCompatibleModel({
        baseUrl: "https://synthetic.invalid/v1",
        apiKey: "synthetic",
        attachments: { read: async () => new Uint8Array([1, 2, 3]) },
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body));
          validateBatches(body.messages);
          return new Response(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`,
          );
        },
      });
      const request: ModelRequest = {
        model: "synthetic",
        reasoningEffort: "medium",
        messages,
        tools: [],
        signal: new AbortController().signal,
      };
      for await (const _event of adapter.stream(request)) {
        /* strict fake provider */
      }
      assert.deepEqual(
        messages,
        original,
        "canonical projection input remains unchanged",
      );
      assert.deepEqual(
        body.messages
          .filter((m: any) => Array.isArray(m.content))
          .map((m: any) => m.content[0].text),
        [...positions.map((i) => `media a${i}`), "media b0", "media b2"],
      );
      if (!terminal) assert.equal(body.messages.at(-1).content, "after");
      else if (terminal === true)
        assert.equal(body.messages.at(-1).content[0].text, "media b2");
      else {
        assert.equal(body.messages.at(-1).role, "assistant");
        assert.equal(
          body.messages.at(-1).reasoning_content,
          "synthetic reasoning",
        );
      }
      assert.equal(
        body.messages.filter((m: any) => m.role === "tool").length,
        6,
      );
      assert.equal(
        body.messages.filter((m: any) => Array.isArray(m.content)).length,
        positions.length + 2,
      );
    });
  }
}

test("deferred media rejection paths still identify only the actual rejected part", async () => {
  const messages = batch("calls", [0, 2]);
  const first = messages[1]!;
  assert.equal(first.role, "tool");
  if (first.role !== "tool") throw Error("fixture");
  const adapter = new OpenAiCompatibleModel({
    baseUrl: "https://synthetic.invalid/v1",
    apiKey: "synthetic",
    attachments: { read: async () => new Uint8Array([1, 2, 3]) },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      validateBatches(body.messages);
      assert.equal(body.messages[4].content[0].text, "media calls0");
      return new Response(
        JSON.stringify({
          error: {
            code: "invalid_image_url",
            param: "messages[4].content[1].image_url",
            message: "Synthetic rejected media",
          },
        }),
        { status: 400 },
      );
    },
  });
  await assert.rejects(
    async () => {
      for await (const _event of adapter.stream({
        model: "synthetic",
        reasoningEffort: "medium",
        messages,
        tools: [],
        signal: new AbortController().signal,
      })) {
        /* no output */
      }
    },
    (error: any) => {
      assert.equal(error.status, 400);
      assert.deepEqual(error.recoveryRejectedMediaParts, [
        first.modelContent![1],
      ]);
      return true;
    },
  );
});
