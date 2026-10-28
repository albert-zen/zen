import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { OpenAiResponsesModel } from "../src/model/openai-responses.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import type {
  ModelEvent,
  ModelRequest,
  ReasoningModelMessage,
} from "../src/model.js";
import { png1x1 } from "./fixtures.js";

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "test-model",
    reasoningEffort: null,
    messages: [],
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}
function sse(events: unknown[] = []): Response {
  return new Response(
    [
      ...events,
      {
        type: "response.completed",
        response: { status: "completed", output: [] },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("") + "data: [DONE]\n\n",
  );
}
async function collect(
  events: AsyncIterable<ModelEvent>,
): Promise<ModelEvent[]> {
  const result: ModelEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
const baseUrl = "https://example.test/v1";
const apiKey = "synthetic-key-not-a-credential";
const provenance = {
  version: 1 as const,
  adapter: "public-responses" as const,
  endpointSha256: createHash("sha256")
    .update(`${baseUrl}/responses`)
    .digest("hex"),
};

test("public Responses retains developer instructions independently of Chat compatibility", async () => {
  let body: any;
  const adapter = new OpenAiResponsesModel({
    baseUrl: "https://api.openai.com/v1",
    apiKey,
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return sse();
    },
  });
  await collect(
    adapter.stream(
      request({
        messages: [
          { role: "developer", text: "Keep this instruction role" },
          { role: "user", text: "Synthetic request" },
        ],
      }),
    ),
  );
  assert.equal(body.input[0].role, "developer");
  assert.equal(body.input[0].content[0].text, "Keep this instruction role");
});

test("public Responses encodes multiple tool images natively without supplemental user messages", async () => {
  const attachments = new InMemoryAttachmentStore();
  const attachment = await attachments.importBytes(png1x1());
  const image = { type: "image" as const, attachment };
  let body: any;
  let url: unknown;
  let headers: Headers;
  const adapter = new OpenAiResponsesModel({
    baseUrl,
    apiKey,
    attachments,
    fetch: async (target, init) => {
      url = target;
      headers = new Headers(init?.headers);
      body = JSON.parse(String(init?.body));
      return sse();
    },
  });
  const messages: ModelRequest["messages"] = [
    {
      role: "assistant",
      toolCalls: [
        { callId: "a|fc_a", name: "view_image", arguments: {} },
        { callId: "b|fc_b", name: "shell", arguments: {} },
      ],
    },
    {
      role: "tool",
      callId: "a|fc_a",
      text: "image A",
      exitCode: 0,
      modelContent: [image, image],
    },
    { role: "tool", callId: "b|fc_b", text: "done", exitCode: 0 },
  ];
  const original = structuredClone(messages);
  await collect(
    adapter.stream(
      request({
        messages,
        tools: [
          {
            name: "run_code",
            description: "Code",
            inputSchema: {
              type: "object",
              properties: { code: { type: "string" } },
            },
          },
        ],
      }),
    ),
  );
  assert.equal(url, `${baseUrl}/responses`);
  assert.equal(headers!.get("authorization"), `Bearer ${apiKey}`);
  for (const header of [
    "chatgpt-account-id",
    "openai-beta",
    "originator",
    "session_id",
  ])
    assert.equal(headers!.has(header), false);
  assert.deepEqual(
    body.input.map((item: any) => item.type),
    [
      "function_call",
      "function_call",
      "function_call_output",
      "function_call_output",
    ],
  );
  assert.equal(body.input[2].call_id, "a");
  assert.equal(body.input[3].call_id, "b");
  assert.deepEqual(body.input[2].output[0], {
    type: "input_text",
    text: "image A",
  });
  assert.equal(body.input[3].output, "done");
  assert.equal(body.input[2].output[1].type, "input_image");
  assert.equal(
    body.input[2].output[2].image_url,
    body.input[2].output[1].image_url,
  );
  assert.equal(body.tools[0].type, "function");
  assert.equal(body.tools[0].strict, false);
  assert.equal(body.store, false);
  assert.equal("previous_response_id" in body, false);
  assert.equal("reasoning" in body, false);
  assert.deepEqual(messages, original);
});

test("public Responses retains real vendor reasoning IDs and explicit replay provenance", async () => {
  let body: any;
  const adapter = new OpenAiResponsesModel({
    baseUrl,
    apiKey,
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return sse([
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "reasoning",
            id: "rs_actual",
            encrypted_content: "opaque",
            summary: [{ type: "summary_text", text: "summary" }],
          },
        },
      ]);
    },
  });
  const events = await collect(adapter.stream(request()));
  const event = events.find((e) => e.type === "reasoning");
  assert.ok(event?.type === "reasoning");
  assert.equal(event.providerItemId, "rs_actual");
  assert.deepEqual(event.opaqueReplayProvenance, provenance);
  const message: ReasoningModelMessage = {
    role: "reasoning",
    reasoningContent: event.reasoningContent,
    contentVisibility: event.contentVisibility,
    providerItemId: event.providerItemId!,
    opaqueReplayProvenance: event.opaqueReplayProvenance!,
  };
  await collect(adapter.stream(request({ messages: [message] })));
  assert.equal(body.input[0].id, "rs_actual");
  assert.equal(body.input[0].encrypted_content, "opaque");
  assert.equal(JSON.stringify(body).includes("endpointSha256"), false);
  assert.equal(JSON.stringify(body).includes(provenance.endpointSha256), false);
});

test("public Responses rejects old, cross-endpoint and malformed opaque continuation before fetch", async () => {
  let calls = 0;
  const adapter = new OpenAiResponsesModel({
    baseUrl,
    apiKey,
    fetch: async () => {
      calls++;
      return sse();
    },
  });
  for (const metadata of [
    undefined,
    { ...provenance, endpointSha256: "0".repeat(64) },
    { ...provenance, version: 2 },
  ]) {
    await assert.rejects(
      collect(
        adapter.stream(
          request({
            messages: [
              {
                role: "reasoning",
                reasoningContent: "opaque",
                contentVisibility: "opaque",
                providerItemId: "rs_actual",
                ...(metadata === undefined
                  ? {}
                  : { opaqueReplayProvenance: metadata as typeof provenance }),
              },
            ],
          }),
        ),
      ),
      /unknown or different transport provenance/u,
    );
  }
  assert.equal(calls, 0);
});

test("public Responses maps native output rejection pointer to the canonical image without fallback", async () => {
  const attachments = new InMemoryAttachmentStore();
  const image = {
    type: "image" as const,
    attachment: await attachments.importBytes(png1x1()),
  };
  let calls = 0;
  const adapter = new OpenAiResponsesModel({
    baseUrl,
    apiKey,
    attachments,
    fetch: async () => {
      calls++;
      return new Response(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            code: "invalid_image",
            param: "input[1].output[1]",
            message: "invalid image",
          },
        }),
        { status: 400 },
      );
    },
  });
  await assert.rejects(
    collect(
      adapter.stream(
        request({
          messages: [
            {
              role: "assistant",
              toolCalls: [{ callId: "a", name: "view_image", arguments: {} }],
            },
            {
              role: "tool",
              callId: "a",
              text: "image",
              exitCode: 0,
              modelContent: [image],
            },
          ],
        }),
      ),
    ),
    (error: any) => {
      assert.equal(error.status, 400);
      assert.equal(error.retryable, false);
      assert.equal(error.modelRecoveryBlocked, true);
      assert.equal(error.recoveryRejectedMediaParts[0], image);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("public Responses rejects credential-bearing endpoint and owned parameters", () => {
  for (const url of [
    "https://user:pass@example.test/v1",
    "https://example.test/v1?key=x",
    "https://example.test/v1#secret",
    "https://example.test/v1/chat/completions",
  ])
    assert.throws(() => new OpenAiResponsesModel({ baseUrl: url, apiKey }));
  for (const key of [
    "store",
    "previous_response_id",
    "input",
    "include",
    "reasoning",
  ])
    assert.throws(
      () =>
        new OpenAiResponsesModel({
          baseUrl,
          apiKey,
          defaultParams: { [key]: true },
        }),
      /owned by the adapter/u,
    );
});

test("public Responses redacts transport exception details", async () => {
  const adapter = new OpenAiResponsesModel({
    baseUrl,
    apiKey,
    fetch: async () => {
      throw new Error(apiKey);
    },
  });
  await assert.rejects(
    collect(adapter.stream(request())),
    (error: Error) =>
      !error.message.includes(apiKey) &&
      /before receiving/u.test(error.message),
  );
});

test("opaque provenance decoder accepts legacy records and rejects unknown metadata", async () => {
  const { decodeCanonicalItem } = await import("../src/item.js");
  const { compileModelMessages } = await import("../src/model.js");
  const base = {
    id: "reasoning",
    threadId: "thread",
    turnId: "turn",
    createdAt: "2026-10-25T00:00:00.000Z",
    type: "reasoning",
  };
  assert.deepEqual(decodeCanonicalItem({ ...base, summary: "legacy" }), {
    ...base,
    summary: "legacy",
  });
  const old = {
    ...base,
    reasoningContent: "encrypted",
    contentVisibility: "opaque",
    providerItemId: "rs_vendor",
  };
  assert.deepEqual(decodeCanonicalItem(old), old);
  const current = decodeCanonicalItem({
    ...old,
    opaqueReplayProvenance: provenance,
  });
  assert.deepEqual(
    decodeCanonicalItem(JSON.parse(JSON.stringify(current))),
    current,
  );
  for (const metadata of [
    { ...provenance, version: 2 },
    { ...provenance, adapter: "subscription" },
    { ...provenance, endpointSha256: "https://secret.test" },
    { ...provenance, key: "forbidden" },
    null,
  ]) {
    assert.throws(
      () => decodeCanonicalItem({ ...old, opaqueReplayProvenance: metadata }),
      /opaque.*(?:provenance|Provenance)/u,
    );
  }
  assert.throws(
    () =>
      decodeCanonicalItem({
        ...old,
        contentVisibility: "public",
        opaqueReplayProvenance: provenance,
      }),
    /opaque/u,
  );
  assert.throws(
    () =>
      decodeCanonicalItem({
        ...base,
        summary: "legacy",
        opaqueReplayProvenance: provenance,
      }),
    /requires opaque content/u,
  );
  assert.equal(current.type, "reasoning");
  if (current.type === "reasoning" && current.contentVisibility === "opaque")
    assert.deepEqual(current.opaqueReplayProvenance, provenance);
});

test("public Responses refuses reasoning without stateless encrypted continuation even when the summary is empty", async () => {
  for (const summary of [
    [],
    [{ type: "summary_text", text: "public summary" }],
  ]) {
    const adapter = new OpenAiResponsesModel({
      baseUrl,
      apiKey,
      fetch: async () =>
        sse([
          {
            type: "response.output_item.done",
            output_index: 0,
            item: { type: "reasoning", id: "rs_without_encryption", summary },
          },
          {
            type: "response.output_item.done",
            output_index: 1,
            item: {
              type: "function_call",
              id: "fc",
              call_id: "call",
              name: "shell",
              arguments: "{}",
            },
          },
        ]),
    });
    const seen: ModelEvent[] = [];
    await assert.rejects(
      (async () => {
        for await (const event of adapter.stream(
          request({
            tools: [
              {
                name: "shell",
                description: "Synthetic",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          }),
        ))
          seen.push(event);
      })(),
      /without encrypted continuation/u,
    );
    assert.equal(
      seen.some((event) => event.type === "tool_call"),
      false,
    );
  }
});

test("ordinary user-image rejection is distinct from native tool-output rejection", async () => {
  const attachments = new InMemoryAttachmentStore();
  const image = {
    type: "image" as const,
    attachment: await attachments.importBytes(png1x1()),
  };
  const adapter = new OpenAiResponsesModel({
    baseUrl,
    apiKey,
    attachments,
    fetch: async () =>
      new Response(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            code: "invalid_image",
            param: "input[0].content[1]",
            message: "User image rejected",
          },
        }),
        { status: 400 },
      ),
  });
  await assert.rejects(
    collect(
      adapter.stream(
        request({
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "fixture" }, image],
            },
            {
              role: "assistant",
              toolCalls: [{ callId: "a", name: "view_image", arguments: {} }],
            },
            {
              role: "tool",
              callId: "a",
              text: "tool",
              exitCode: 0,
              modelContent: [image],
            },
          ],
        }),
      ),
    ),
    (error: any) => {
      assert.equal(error.modelRecoveryBlocked, false);
      assert.equal(error.recoveryRejectedMediaParts[0], image);
      return true;
    },
  );
});

test("public Responses does not expose an error-body reader's exception details", async () => {
  const adapter = new OpenAiResponsesModel({
    baseUrl,
    apiKey,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(apiKey));
          },
        }),
        { status: 400 },
      ),
  });
  await assert.rejects(collect(adapter.stream(request())), (error: any) => {
    assert.equal(error.status, 400);
    assert.equal(error.modelRecoveryBlocked, true);
    assert.equal(error.message.includes(apiKey), false);
    return true;
  });
});

test("same-profile protocol changes keep Chat text history usable but reject public opaque state on subscription", async () => {
  const { OpenAiSubscriptionModel } =
    await import("../src/model/openai-subscription.js");
  const { OpenAiCompatibleModel } =
    await import("../src/model/openai-compatible.js");
  const { compileModelMessages } = await import("../src/model.js");
  const { decodeCanonicalItem } = await import("../src/item.js");
  const base = {
    threadId: "thread",
    turnId: "turn",
    createdAt: "2026-10-25T00:00:00.000Z",
  };
  const selection = {
    providerProfileId: "same-profile",
    modelId: "same-model",
    reasoningEffort: "medium",
  };
  const items = [
    decodeCanonicalItem({
      ...base,
      id: "turn",
      type: "turn_started",
      selection,
    }),
    decodeCanonicalItem({
      ...base,
      id: "reasoning",
      type: "reasoning",
      contentVisibility: "opaque",
      reasoningContent: "opaque-private-state",
      providerItemId: "rs_real",
      opaqueReplayProvenance: provenance,
    }),
  ];
  const messages = [
    {
      role: "reasoning" as const,
      reasoningContent: "opaque-private-state",
      contentVisibility: "opaque" as const,
      providerItemId: "rs_real",
      opaqueReplayProvenance: provenance,
    },
    { role: "assistant" as const, text: "Completed answer" },
    { role: "user" as const, text: "Continue as text" },
  ];
  let leases = 0;
  let subscriptionFetches = 0;
  const subscription = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => {
      leases++;
      return { accessToken: "synthetic" };
    },
    fetch: async () => {
      subscriptionFetches++;
      return sse();
    },
  });
  await assert.rejects(
    collect(subscription.stream(request({ messages }))),
    /cannot replay public Responses opaque state/u,
  );
  assert.equal(leases, 0);
  assert.equal(subscriptionFetches, 0);
  let chatCalls = 0;
  const chat = new OpenAiCompatibleModel({
    baseUrl,
    apiKey,
    fetch: async (_url, init) => {
      chatCalls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(
        JSON.stringify(body).includes("opaque-private-state"),
        false,
      );
      assert.equal(
        JSON.stringify(body).includes("opaqueReplayProvenance"),
        false,
      );
      assert.ok(
        body.messages.some(
          (message: any) => message.content === "Completed answer",
        ),
      );
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
      );
    },
  });
  await collect(chat.stream(request({ messages })));
  assert.equal(chatCalls, 1);
});

test("public Responses static instructions match the exact wire value", async () => {
  for (const instructions of [
    undefined,
    null,
    "",
    "  keep whitespace\n",
    "s".repeat(20000),
  ]) {
    let body: any;
    const adapter = new OpenAiResponsesModel({
      baseUrl,
      apiKey,
      defaultParams: { instructions },
      fetch: async (_target, init) => {
        body = JSON.parse(String(init?.body));
        return sse();
      },
    });
    await collect(adapter.stream(request()));
    assert.equal(adapter.contextInstructions, instructions ?? "");
    assert.equal(body.instructions, "");
    await collect(
      adapter.stream(
        request({ messages: [{ role: "system", text: instructions ?? "" }] }),
      ),
    );
    assert.equal(body.instructions, "");
    assert.deepEqual(body.input, [
      {
        role: "system",
        content: [{ type: "input_text", text: instructions ?? "" }],
      },
    ]);
  }
});

test("public Responses rejects non-string static instructions", () => {
  for (const instructions of [0, 1, true, false, {}, []]) {
    assert.throws(
      () =>
        new OpenAiResponsesModel({
          baseUrl,
          apiKey,
          defaultParams: { instructions },
        }),
      /instructions must be a string or null/,
    );
  }
});

test("public Responses forwards a compiler operation output-token limit without changing content", async () => {
  let body: any;
  const adapter = new OpenAiResponsesModel({
    baseUrl,
    apiKey,
    defaultParams: { max_output_tokens: 99 },
    fetch: async (_target, init) => {
      body = JSON.parse(String(init?.body));
      return sse();
    },
  });
  await collect(adapter.stream(request({ maxOutputTokens: 1 })));
  assert.equal(body.max_output_tokens, 1);
  const limitedInput = body.input;
  await collect(adapter.stream(request()));
  assert.equal(body.max_output_tokens, 99);
  assert.deepEqual(body.input, limitedInput);
});
