import assert from "node:assert/strict";
import test from "node:test";
import {
  selectChatToolMediaTransport,
  type ChatToolMediaCapability,
} from "../src/model/tool-media-transport.js";
import type { ModelRequest, ModelMessage } from "../src/model.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";

const support: ChatToolMediaCapability = {
  protocol: "chat-completions",
  endpoint: "https://synthetic.invalid/v1/chat/completions",
  model: "synthetic",
  media: ["image"],
  evidence: "synthetic fixture",
  reviewedOn: "2026-10-25",
};
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
    mediaType: "image/png" as const,
    byteLength: 3,
    width: 1,
    height: 1,
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
    test(`Native tool content preserves parallel reply batch for media positions ${positions}, terminal=${terminal}`, async () => {
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
        toolMediaCapabilities: [support],
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
          .map((m: any) => m.content[1].text),
        [...positions.map((i) => `media a${i}`), "media b0", "media b2"],
      );
      if (!terminal) assert.equal(body.messages.at(-1).content, "after");
      else if (terminal === true)
        assert.equal(body.messages.at(-1).content[1].text, "media b2");
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

test("native media rejection paths still identify only the actual rejected part", async () => {
  const messages = batch("calls", [0, 2]);
  let attempts = 0;
  const first = messages[1]!;
  assert.equal(first.role, "tool");
  if (first.role !== "tool") throw Error("fixture");
  const adapter = new OpenAiCompatibleModel({
    baseUrl: "https://synthetic.invalid/v1",
    apiKey: "synthetic",
    toolMediaCapabilities: [support],
    attachments: { read: async () => new Uint8Array([1, 2, 3]) },
    fetch: async (_url, init) => {
      attempts++;
      const body = JSON.parse(String(init?.body));
      validateBatches(body.messages);
      assert.equal(body.messages[1].content[1].text, "media calls0");
      return new Response(
        JSON.stringify({
          error: {
            code: "invalid_image_url",
            param: "messages[1].content[2].image_url",
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
      assert.equal(error.recoveryRejectedMediaParts.length, 1);
      assert.equal(error.recoveryRejectedMediaParts[0], first.modelContent![1]);
      assert.equal(attempts, 1, "no alternate-format resubmission");
      return true;
    },
  );
});

test("native declaration is scoped to exact endpoint, model and supported media", () => {
  const select = (
    endpoint = support.endpoint,
    model = support.model,
    declarations = [support],
  ) => selectChatToolMediaTransport(declarations, endpoint, model, [image]);
  assert.equal(select().encoding, "native-tool-content");
  assert.equal(select(support.endpoint + "/other").reason, "unknown-target");
  assert.equal(select(undefined, "synthetic-new").reason, "unknown-target");
  assert.equal(
    select(undefined, undefined, [{ ...support, evidence: "" }]).reason,
    "unknown-target",
  );
  assert.equal(
    select(undefined, undefined, [{ ...support, media: [] }]).reason,
    "undeclared-media",
  );
});

for (const native of [true, false]) {
  test(`single call with multiple media preserves association: native=${native}`, async () => {
    const second = {
      ...image,
      attachment: { ...image.attachment, sha256: "b".repeat(64) },
    };
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        toolCalls: [{ callId: "only", name: "view_image", arguments: {} }],
      },
      {
        role: "tool",
        callId: "only",
        exitCode: 0,
        text: "receipt",
        modelContent: [image, { type: "text", text: "between" }, second],
      },
      { role: "user", text: "real human message" },
    ];
    const original = structuredClone(messages);
    let body: any;
    const adapter = new OpenAiCompatibleModel({
      baseUrl: "https://synthetic.invalid/v1",
      apiKey: "synthetic",
      toolMediaCapabilities: native ? [support] : [],
      attachments: {
        read: async (ref) =>
          new Uint8Array([ref.sha256.startsWith("a") ? 1 : 2]),
      },
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(
          'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        );
      },
    });
    for await (const _event of adapter.stream({
      model: "synthetic",
      reasoningEffort: null,
      messages,
      tools: [],
      signal: new AbortController().signal,
    })) {
    }
    assert.equal(body.messages[1].tool_call_id, "only");
    assert.deepEqual(messages, original);
    const media = body.messages[native ? 1 : 2].content.slice(native ? 1 : 0);
    assert.deepEqual(media, [
      { type: "image_url", image_url: { url: "data:image/png;base64,AQ==" } },
      { type: "text", text: "between" },
      { type: "image_url", image_url: { url: "data:image/png;base64,Ag==" } },
    ]);
    assert.equal(body.messages[native ? 2 : 3].content, "real human message");
  });
}

test("one declaration must cover all result media; partial declarations cannot union", () => {
  const audio = {
    type: "audio" as const,
    attachment: {
      type: "attachment" as const,
      sha256: "b".repeat(64),
      mediaType: "audio/wav" as const,
      byteLength: 3,
    },
  };
  const result = selectChatToolMediaTransport(
    [support, { ...support, media: ["audio"] }],
    support.endpoint,
    support.model,
    [image, audio],
  );
  assert.equal(result.reason, "undeclared-media");
  assert.equal(result.encoding, "user-after-tool-batch");
});

for (const target of ["native", "fallback", "human"] as const) {
  test(`mixed result transports reject only the original ${target} media occurrence`, async () => {
    const native = structuredClone(image);
    const human = structuredClone(image);
    const audio = {
      type: "audio" as const,
      attachment: {
        type: "attachment" as const,
        sha256: "b".repeat(64),
        mediaType: "audio/wav" as const,
        byteLength: 3,
      },
    };
    const paths = {
      native: "messages[2].content[1].image_url",
      fallback: "messages[3].content[0].input_audio",
      human: "messages[4].content[0].image_url",
    };
    const expected = { native, fallback: audio, human };
    let attempts = 0;
    const adapter = new OpenAiCompatibleModel({
      baseUrl: "https://synthetic.invalid/v1",
      apiKey: "synthetic",
      toolMediaCapabilities: [support],
      attachments: { read: async () => new Uint8Array([1, 2, 3]) },
      fetch: async (_url, init) => {
        attempts++;
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(
          body.messages.map((m: any) => m.role),
          ["assistant", "tool", "tool", "user", "user"],
        );
        assert.equal(body.messages[1].tool_call_id, "audio");
        assert.equal(body.messages[2].tool_call_id, "image");
        return new Response(
          JSON.stringify({
            error: {
              code: "invalid_image_url",
              message: "Synthetic invalid media",
              param: paths[target],
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
          reasoningEffort: null,
          messages: [
            {
              role: "assistant",
              toolCalls: [
                { callId: "audio", name: "fixture", arguments: {} },
                { callId: "image", name: "fixture", arguments: {} },
              ],
            },
            {
              role: "tool",
              callId: "audio",
              exitCode: 0,
              text: "audio receipt",
              modelContent: [audio],
            },
            {
              role: "tool",
              callId: "image",
              exitCode: 0,
              text: "image receipt",
              modelContent: [native],
            },
            { role: "user", content: [human] },
          ],
          tools: [],
          signal: new AbortController().signal,
        })) {
        }
      },
      (error: any) => {
        assert.equal(error.recoveryRejectedMediaParts.length, 1);
        assert.equal(error.recoveryRejectedMediaParts[0], expected[target]);
        return true;
      },
    );
    assert.equal(attempts, 1);
  });
}

test("adapter observation reports bounded native/fallback decisions without target URLs", async () => {
  const observations: any[] = [];
  const adapter = new OpenAiCompatibleModel({
    baseUrl: "https://secret-host.invalid/v1",
    apiKey: "secret-value",
    toolMediaCapabilities: [support],
    attachments: { read: async () => new Uint8Array([1, 2, 3]) },
    fetch: async (_url, init) => {
      assert.doesNotMatch(
        String(init?.body),
        /toolMediaTransport|unknownTarget|reviewedOn/,
      );
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
      );
    },
  });
  for await (const _event of adapter.stream({
    model: "synthetic",
    reasoningEffort: null,
    messages: batch("calls", [0, 2]),
    tools: [],
    signal: new AbortController().signal,
    onRequest: (event) => observations.push(event),
  })) {
  }
  assert.deepEqual(observations[0].toolMediaTransport, {
    nativeToolContent: 0,
    compatibilitySupplement: 2,
    unknownTarget: 2,
    undeclaredMedia: 0,
    nativeSupportUnverified: 0,
    conflictingEvidence: 0,
  });
  assert.doesNotMatch(
    JSON.stringify(observations[0].toolMediaTransport),
    /synthetic|secret|http|endpoint/,
  );
});

test("conflicting evidence cannot silently enable an otherwise matching native declaration", () => {
  const result = selectChatToolMediaTransport(
    [support],
    support.endpoint,
    support.model,
    [image],
    [support],
  );
  assert.equal(result.encoding, "user-after-tool-batch");
  assert.equal(result.reason, "conflicting-evidence");
});
