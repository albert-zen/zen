import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelEvent, ModelRequest } from "../src/model.js";
import {
  OpenAiCompatibleModel,
  OpenAiCompatibleModelError,
} from "../src/model/openai-compatible.js";

const fakeKey = "fake-key-that-must-not-leak";

test("maps Zen context and protects model execution fields", async () => {
  let capturedUrl = "";
  let capturedAuthorization = "";
  let capturedBody: Readonly<Record<string, unknown>> = {};
  const adapter = new OpenAiCompatibleModel({
    baseUrl: "https://provider.test/v1/",
    apiKey: fakeKey,
    provider: "test-provider",
    defaultParams: {
      temperature: 0,
      model: "wrong-model",
      messages: [{ role: "user", content: "wrong messages" }],
      tools: [],
      tool_choice: "none",
      n: 9,
      stream: false,
    },
    fetch: (async (input, init) => {
      capturedUrl = String(input);
      capturedAuthorization =
        new Headers(init?.headers).get("authorization") ?? "";
      capturedBody = JSON.parse(String(init?.body)) as Readonly<
        Record<string, unknown>
      >;
      return streamResponse([
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        "[DONE]",
      ]);
    }) as typeof fetch,
  });

  await collect(
    adapter.stream(
      request({
        messages: [
          { role: "user", text: "hello" },
          { role: "assistant", text: "calling a tool" },
          {
            role: "assistant",
            toolCalls: [
              {
                callId: "call-1",
                name: "shell",
                arguments: { command: "pwd" },
              },
            ],
          },
          { role: "tool", callId: "call-1", text: "/workspace", exitCode: 0 },
        ],
        tools: [
          {
            name: "shell",
            description: "Run a command",
            inputSchema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
      }),
    ),
  );

  assert.equal(adapter.provider, "test-provider");
  assert.equal(capturedUrl, "https://provider.test/v1/chat/completions");
  assert.equal(capturedAuthorization, `Bearer ${fakeKey}`);
  assert.deepEqual(capturedBody, {
    temperature: 0,
    model: "test-model",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "calling a tool" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "shell", arguments: '{"command":"pwd"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        content: "Exit code: 0\n/workspace",
      },
    ],
    n: 1,
    stream: true,
    tools: [
      {
        type: "function",
        function: {
          name: "shell",
          description: "Run a command",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      },
    ],
    tool_choice: "auto",
  });
});

test("removes configured tools when a request exposes no tools", async () => {
  let capturedBody: Readonly<Record<string, unknown>> = {};
  const adapter = new OpenAiCompatibleModel({
    baseUrl: "https://provider.test/v1",
    apiKey: fakeKey,
    defaultParams: {
      tools: [{ type: "function", function: { name: "injected" } }],
      tool_choice: "required",
    },
    fetch: (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Readonly<
        Record<string, unknown>
      >;
      return streamResponse(["[DONE]"]);
    }) as typeof fetch,
  });

  await collect(adapter.stream(request()));

  assert.equal("tools" in capturedBody, false);
  assert.equal("tool_choice" in capturedBody, false);
});

test("parses SSE split at every byte including a multibyte character", async () => {
  const body = [
    sse(
      chunk({
        choices: [{ index: 0, delta: { content: "你" }, finish_reason: null }],
      }),
      "\r\n",
    ),
    sse(
      chunk({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
      "\r\n",
    ),
    sse("[DONE]", "\r\n"),
  ].join("");
  const bytes = new TextEncoder().encode(body);
  const adapter = adapterReturning(
    new Response(byteStream([...bytes].map((byte) => Uint8Array.of(byte)))),
  );

  assert.deepEqual(await collect(adapter.stream(request())), [
    { type: "text_delta", delta: "你" },
    { type: "usage", inputTokens: 3, outputTokens: 1 },
  ]);
});

test("assembles interleaved parallel tool-call deltas without losing ids", async () => {
  const adapter = adapterReturning(
    streamResponse([
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-a",
                  function: { name: "shell", arguments: '{"command"' },
                },
                {
                  index: 1,
                  id: "call-b",
                  function: { name: "shell", arguments: '{"command"' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 1, id: "", function: { arguments: ':"pwd"}' } },
                { index: 0, id: "", function: { arguments: ':"ls"}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      chunk({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      }),
      "[DONE]",
    ]),
  );

  assert.deepEqual(
    await collect(adapter.stream(request({ tools: [shellTool()] }))),
    [
      {
        type: "tool_call",
        callId: "call-a",
        name: "shell",
        arguments: { command: "ls" },
      },
      {
        type: "tool_call",
        callId: "call-b",
        name: "shell",
        arguments: { command: "pwd" },
      },
    ],
  );
});

test("rejects malformed or unavailable tool calls instead of executing raw input", async (t) => {
  await t.test("malformed arguments", async () => {
    const adapter = adapterReturning(
      streamResponse([
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "shell", arguments: '{"command":' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        "[DONE]",
      ]),
    );

    await assert.rejects(
      collect(adapter.stream(request({ tools: [shellTool()] }))),
      /invalid tool arguments/u,
    );
  });

  await t.test("unavailable tool", async () => {
    const adapter = adapterReturning(
      streamResponse([
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "not-offered", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        "[DONE]",
      ]),
    );

    await assert.rejects(
      collect(adapter.stream(request({ tools: [shellTool()] }))),
      /unavailable tool/u,
    );
  });
});

test("rejects truncated, malformed, incomplete, and post-terminal streams", async (t) => {
  await t.test("truncated", async () => {
    const adapter = adapterReturning(
      streamResponse([
        chunk({ choices: [{ index: 0, delta: { content: "partial" } }] }),
      ]),
    );
    await assert.rejects(
      collect(adapter.stream(request())),
      /without a terminal marker/u,
    );
  });

  await t.test("malformed JSON", async () => {
    const adapter = adapterReturning(streamResponse(['{"choices":']));
    await assert.rejects(collect(adapter.stream(request())), /invalid JSON/u);
  });

  await t.test("length finish", async () => {
    const adapter = adapterReturning(
      streamResponse([
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }),
        "[DONE]",
      ]),
    );
    await assert.rejects(
      collect(adapter.stream(request())),
      /response was incomplete/u,
    );
  });

  await t.test("data after done", async () => {
    const adapter = adapterReturning(
      streamResponse([
        "[DONE]",
        chunk({ choices: [{ index: 0, delta: { content: "late" } }] }),
      ]),
    );
    await assert.rejects(
      collect(adapter.stream(request())),
      /continued after completion/u,
    );
  });
});

test("accepts a clean finish reason when a compatible provider omits DONE", async () => {
  const adapter = adapterReturning(
    streamResponse([
      chunk({ choices: [{ index: 0, delta: { content: "ok" } }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    ]),
  );
  assert.deepEqual(await collect(adapter.stream(request())), [
    { type: "text_delta", delta: "ok" },
  ]);
});

test("stops at DONE even when a compatible provider keeps the HTTP stream open", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse("[DONE]")));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { status: 200 },
  );
  const adapter = adapterReturning(response);
  assert.deepEqual(await collect(adapter.stream(request())), []);
  assert.equal(cancelled, true);
});

test("normalizes HTTP and streaming provider errors without leaking secrets", async (t) => {
  await t.test("HTTP error", async () => {
    const adapter = new OpenAiCompatibleModel({
      baseUrl: "https://provider.test/v1",
      apiKey: fakeKey,
      fetch: (async () =>
        Response.json(
          {
            error: {
              code: "unsupported_image_input",
              message: `image input is unsupported: ${fakeKey}`,
            },
          },
          { status: 401, headers: { "x-request-id": "req_safe-1" } },
        )) as typeof fetch,
    });

    await assert.rejects(
      collect(adapter.stream(request())),
      (error: unknown) => {
        assert.ok(error instanceof OpenAiCompatibleModelError);
        assert.equal(error.kind, "http");
        assert.equal(error.status, 401);
        assert.equal(error.requestId, "req_safe-1");
        assert.equal(error.retryable, false);
        assert.equal(error.explicitlyRejectsImageInput, true);
        assert.equal(String(error).includes(fakeKey), false);
        assert.equal(JSON.stringify(error).includes(fakeKey), false);
        return true;
      },
    );
  });

  await t.test("request id containing the API key is discarded", async () => {
    const adapter = new OpenAiCompatibleModel({
      baseUrl: "https://provider.test/v1",
      apiKey: fakeKey,
      fetch: (async () =>
        new Response(null, {
          status: 401,
          headers: { "x-request-id": `req_${fakeKey}` },
        })) as typeof fetch,
    });

    await assert.rejects(
      collect(adapter.stream(request())),
      (error: unknown) => {
        assert.ok(error instanceof OpenAiCompatibleModelError);
        assert.equal(error.kind, "http");
        assert.equal(error.requestId, undefined);
        assert.equal(String(error).includes(fakeKey), false);
        return true;
      },
    );
  });

  await t.test("stream error payload", async () => {
    const adapter = adapterReturning(
      streamResponse([chunk({ error: { message: fakeKey } })]),
    );
    await assert.rejects(
      collect(adapter.stream(request())),
      (error: unknown) => {
        assert.ok(error instanceof OpenAiCompatibleModelError);
        assert.equal(error.kind, "protocol");
        assert.equal(String(error).includes(fakeKey), false);
        return true;
      },
    );
  });

  await t.test("retryable HTTP status is metadata only", async () => {
    const adapter = new OpenAiCompatibleModel({
      baseUrl: "https://provider.test/v1",
      apiKey: fakeKey,
      fetch: (async () => new Response(null, { status: 429 })) as typeof fetch,
    });
    await assert.rejects(
      collect(adapter.stream(request())),
      (error: unknown) => {
        assert.ok(error instanceof OpenAiCompatibleModelError);
        assert.equal(error.retryable, true);
        return true;
      },
    );
  });
});

test("propagates aborts during stream consumption", async () => {
  const controller = new AbortController();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(
          new TextEncoder().encode(
            sse(
              chunk({ choices: [{ index: 0, delta: { content: "first" } }] }),
            ),
          ),
        );
      },
    }),
    { status: 200 },
  );
  const adapter = adapterReturning(response);
  const iterator = adapter
    .stream(request({ signal: controller.signal }))
    [Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "text_delta", delta: "first" },
  });
  controller.abort(new Error("turn interrupted"));
  await assert.rejects(iterator.next(), /turn interrupted/u);
});

function adapterReturning(response: Response): OpenAiCompatibleModel {
  return new OpenAiCompatibleModel({
    baseUrl: "https://provider.test/v1",
    apiKey: fakeKey,
    fetch: (async () => response) as typeof fetch,
  });
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "test-model",
    reasoningEffort: "medium",
    messages: [],
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

function shellTool(): ModelRequest["tools"][number] {
  return {
    name: "shell",
    description: "Run a command",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  };
}

function chunk(value: unknown): string {
  return JSON.stringify(value);
}

function sse(data: string, newline = "\n"): string {
  return `data: ${data}${newline}${newline}`;
}

function streamResponse(events: readonly string[]): Response {
  return new Response(
    byteStream([
      new TextEncoder().encode(events.map((event) => sse(event)).join("")),
    ]),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function byteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunkValue of chunks) {
        controller.enqueue(chunkValue);
      }
      controller.close();
    },
  });
}

async function collect(
  events: AsyncIterable<ModelEvent>,
): Promise<ModelEvent[]> {
  const collected: ModelEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
