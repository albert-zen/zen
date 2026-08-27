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
          {
            role: "reasoning",
            reasoningContent: "public compatible reasoning",
            contentVisibility: "public",
          },
          {
            role: "assistant",
            text: "calling a tool",
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
    reasoning_effort: "medium",
    model: "test-model",
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "calling a tool",
        reasoning_content: "public compatible reasoning",
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

test("rejects raw reasoning controls that would create a second authority", () => {
  for (const [control, value] of [
    ["reasoning_effort", "xhigh"],
    ["thinking_budget", 4096],
  ] as const) {
    assert.throws(
      () =>
        new OpenAiCompatibleModel({
          baseUrl: "https://provider.test/v1",
          apiKey: fakeKey,
          defaultParams: { [control]: value },
        }),
      (error: unknown) =>
        error instanceof OpenAiCompatibleModelError &&
        error.kind === "configuration" &&
        error.message.includes(control),
    );
  }
});

test("encodes provider-specific reasoning replay contracts", async (t) => {
  await t.test("DeepSeek replays only tool-call reasoning", async () => {
    const body = await captureRequestBody({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-reasoner",
      reasoningEffort: "high",
      messages: reasoningHistory(),
      tools: [shellTool()],
    });

    assert.equal("reasoning_effort" in body, false);
    assert.deepEqual(body.messages, [
      { role: "user", content: "run pwd" },
      {
        role: "assistant",
        content: "using shell",
        reasoning_content: "tool reasoning",
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
      { role: "assistant", content: "done" },
    ]);
  });

  await t.test("Qwen preserves complete reasoning by default", async () => {
    const body = await captureRequestBody({
      provider: "custom-provider",
      baseUrl: "https://provider.test/v1",
      model: "vendor/qwen3.8-max",
      reasoningEffort: "high",
      messages: reasoningHistory(),
      tools: [shellTool()],
    });

    assert.equal(body.reasoning_effort, "high");
    assert.equal("thinking_budget" in body, false);
    assert.deepEqual(
      (body.messages as Readonly<Record<string, unknown>>[])
        .filter((message) => message.role === "assistant")
        .map((message) => message.reasoning_content),
      ["tool reasoning", "final reasoning"],
    );
  });

  await t.test("Qwen honors explicit preservation settings", async (t) => {
    await t.test("enabled", async () => {
      const body = await captureRequestBody({
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.8-max",
        defaultParams: { preserve_thinking: true },
        messages: reasoningHistory(),
        tools: [shellTool()],
      });

      assert.equal(body.preserve_thinking, true);
      assert.deepEqual(
        (body.messages as Readonly<Record<string, unknown>>[])
          .filter((message) => message.role === "assistant")
          .map((message) => message.reasoning_content),
        ["tool reasoning", "final reasoning"],
      );
    });

    await t.test("disabled", async () => {
      const body = await captureRequestBody({
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.8-max",
        defaultParams: { preserve_thinking: false },
        messages: reasoningHistory(),
        tools: [shellTool()],
      });

      assert.equal(body.preserve_thinking, false);
      assert.deepEqual(
        (body.messages as Readonly<Record<string, unknown>>[]).map(
          (message) => "reasoning_content" in message,
        ),
        [false, false, false, false],
      );
    });
  });

  await t.test(
    "DashScope GLM preserves complete reasoning by default and forwards effort",
    async (t) => {
      const body = await captureRequestBody({
        provider: "custom-provider",
        baseUrl:
          "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        model: "glm-5.2",
        reasoningEffort: "high",
        defaultParams: { tool_stream: false },
        messages: reasoningHistory(),
        tools: [shellTool()],
      });

      assert.equal(body.reasoning_effort, "high");
      assert.equal("thinking_budget" in body, false);
      assert.equal(body.tool_stream, true);
      const assistants = (
        body.messages as Readonly<Record<string, unknown>>[]
      ).filter((message) => message.role === "assistant");
      assert.equal(assistants[0]?.reasoning_content, "tool reasoning");
      assert.equal(assistants[1]?.reasoning_content, "final reasoning");

      await t.test("explicit false preserves canonical effort", async () => {
        const configured = await captureRequestBody({
          provider: "dashscope",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          model: "glm-5.2",
          reasoningEffort: "xhigh",
          defaultParams: { clear_thinking: false },
          messages: reasoningHistory(),
          tools: [shellTool()],
        });

        assert.equal(configured.clear_thinking, false);
        assert.equal(configured.reasoning_effort, "xhigh");
        assert.deepEqual(
          (configured.messages as Readonly<Record<string, unknown>>[])
            .filter((message) => message.role === "assistant")
            .map((message) => message.reasoning_content),
          ["tool reasoning", "final reasoning"],
        );
      });

      await t.test("explicit true clears all reasoning history", async () => {
        const cleared = await captureRequestBody({
          provider: "dashscope",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          model: "glm-5.2",
          defaultParams: { clear_thinking: true },
          messages: reasoningHistory(),
          tools: [shellTool()],
        });

        assert.equal(cleared.clear_thinking, true);
        assert.deepEqual(
          (cleared.messages as Readonly<Record<string, unknown>>[]).map(
            (message) => "reasoning_content" in message,
          ),
          [false, false, false, false],
        );
      });
    },
  );

  await t.test(
    "recognizes only documented DashScope host shapes",
    async (t) => {
      for (const hostname of [
        "dashscope.aliyuncs.com",
        "dashscope-intl.aliyuncs.com",
        "workspace.cn-beijing.maas.aliyuncs.com",
        "llm-abc.ap-southeast-1.maas.aliyuncs.com",
      ]) {
        await t.test(`accepts ${hostname}`, async () => {
          const body = await captureRequestBody({
            provider: "custom-provider",
            baseUrl: `https://${hostname}/compatible-mode/v1`,
            model: "glm-5.2",
            messages: reasoningHistory(),
            tools: [shellTool()],
          });

          assert.equal(body.reasoning_effort, "medium");
          assert.deepEqual(
            (body.messages as Readonly<Record<string, unknown>>[])
              .filter((message) => message.role === "assistant")
              .map((message) => message.reasoning_content),
            ["tool reasoning", "final reasoning"],
          );
        });
      }

      for (const hostname of [
        "cn-beijing.maas.aliyuncs.com",
        "extra.workspace.cn-beijing.maas.aliyuncs.com",
        "workspace.cn-beijing.maas.aliyuncs.com.evil.test",
        "workspace.cn-beijing.other.aliyuncs.com",
      ]) {
        await t.test(`rejects ${hostname}`, async () => {
          const body = await captureRequestBody({
            provider: "custom-provider",
            baseUrl: `https://${hostname}/compatible-mode/v1`,
            model: "glm-5.2",
            defaultParams: { clear_thinking: false },
            messages: reasoningHistory(),
            tools: [shellTool()],
          });

          assert.equal("reasoning_effort" in body, false);
          const assistants = (
            body.messages as Readonly<Record<string, unknown>>[]
          ).filter((message) => message.role === "assistant");
          assert.equal(assistants[0]?.reasoning_content, "tool reasoning");
          assert.equal("reasoning_content" in assistants[1]!, false);
        });
      }
    },
  );

  await t.test(
    "Zhipu GLM uses nested preserved-thinking settings",
    async (t) => {
      await t.test("standard API default", async () => {
        const body = await captureRequestBody({
          provider: "zhipu",
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
          model: "glm-5.3",
          reasoningEffort: "high",
          messages: reasoningHistory(),
          tools: [shellTool()],
        });

        assert.equal(body.reasoning_effort, "high");
        assert.equal("thinking_budget" in body, false);
        const assistants = (
          body.messages as Readonly<Record<string, unknown>>[]
        ).filter((message) => message.role === "assistant");
        assert.equal(assistants[0]?.reasoning_content, "tool reasoning");
        assert.equal("reasoning_content" in assistants[1]!, false);
      });

      await t.test("explicit preserved mode", async () => {
        const body = await captureRequestBody({
          provider: "zhipu",
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
          model: "glm-5.3",
          defaultParams: {
            thinking: { type: "enabled", clear_thinking: false },
          },
          messages: reasoningHistory(),
          tools: [shellTool()],
        });

        assert.deepEqual(
          (body.messages as Readonly<Record<string, unknown>>[])
            .filter((message) => message.role === "assistant")
            .map((message) => message.reasoning_content),
          ["tool reasoning", "final reasoning"],
        );
      });

      await t.test(
        "top-level DashScope setting does not enable preservation",
        async () => {
          const body = await captureRequestBody({
            provider: "zhipu",
            baseUrl: "https://open.bigmodel.cn/api/paas/v4",
            model: "glm-5.3",
            defaultParams: { clear_thinking: false },
            messages: reasoningHistory(),
            tools: [shellTool()],
          });

          const assistants = (
            body.messages as Readonly<Record<string, unknown>>[]
          ).filter((message) => message.role === "assistant");
          assert.equal(assistants[0]?.reasoning_content, "tool reasoning");
          assert.equal("reasoning_content" in assistants[1]!, false);
        },
      );
    },
  );

  await t.test(
    "unknown compatible fallback forwards canonical effort",
    async () => {
      const body = await captureRequestBody({
        provider: "custom-provider",
        baseUrl: "https://provider.test/v1",
        model: "custom-model",
        reasoningEffort: "xhigh",
        messages: [],
      });

      assert.equal(body.reasoning_effort, "xhigh");
      assert.equal("thinking_budget" in body, false);
    },
  );
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
        usage: {
          prompt_tokens: 3,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 1 },
        },
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
    {
      type: "usage",
      inputTokens: 3,
      cachedInputTokens: 2,
      outputTokens: 1,
      reasoningOutputTokens: 1,
    },
  ]);
});

test("normalizes DeepSeek cache hit and miss usage without changing total input", async () => {
  const adapter = adapterReturning(
    streamResponse([
      chunk({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 13,
          completion_tokens: 5,
          prompt_cache_hit_tokens: 8,
          prompt_cache_miss_tokens: 5,
        },
      }),
      "[DONE]",
    ]),
  );

  assert.deepEqual(await collect(adapter.stream(request())), [
    {
      type: "usage",
      inputTokens: 13,
      cachedInputTokens: 8,
      outputTokens: 5,
    },
  ]);
});

test("leaves cache usage unknown when the provider omits cache fields", async () => {
  const adapter = adapterReturning(
    streamResponse([
      chunk({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
      "[DONE]",
    ]),
  );

  assert.deepEqual(await collect(adapter.stream(request())), [
    { type: "usage", inputTokens: 3, outputTokens: 1 },
  ]);
});

test("ignores invalid optional compatible usage while preserving required totals", async (t) => {
  const invalidDetails = [
    {
      name: "invalid detail values",
      usage: {
        prompt_tokens_details: { cached_tokens: "2" },
        completion_tokens_details: { reasoning_tokens: "1" },
      },
    },
    {
      name: "details exceeding their totals",
      usage: {
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    },
    {
      name: "invalid detail containers",
      usage: {
        prompt_tokens_details: [],
        completion_tokens_details: "invalid",
      },
    },
    {
      name: "invalid DeepSeek cache hit",
      usage: { prompt_cache_hit_tokens: 4 },
    },
    {
      name: "invalid DeepSeek cache miss",
      usage: { prompt_cache_miss_tokens: 4 },
    },
  ] as const;

  for (const scenario of invalidDetails) {
    await t.test(scenario.name, async () => {
      const adapter = adapterReturning(
        streamResponse([
          chunk({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 3,
              completion_tokens: 1,
              ...scenario.usage,
            },
          }),
          "[DONE]",
        ]),
      );

      assert.deepEqual(await collect(adapter.stream(request())), [
        { type: "usage", inputTokens: 3, outputTokens: 1 },
      ]);
    });
  }
});

test("preserves valid zero compatible usage details", async () => {
  const adapter = adapterReturning(
    streamResponse([
      chunk({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      }),
      "[DONE]",
    ]),
  );

  assert.deepEqual(await collect(adapter.stream(request())), [
    {
      type: "usage",
      inputTokens: 3,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
    },
  ]);
});

test("still rejects invalid required compatible usage totals", async (t) => {
  for (const usage of [
    { prompt_tokens: "3", completion_tokens: 1 },
    { prompt_tokens: 3, completion_tokens: -1 },
  ]) {
    await t.test(JSON.stringify(usage), async () => {
      const adapter = adapterReturning(
        streamResponse([
          chunk({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage,
          }),
          "[DONE]",
        ]),
      );

      await assert.rejects(
        collect(adapter.stream(request())),
        /OpenAI-compatible model stream had invalid usage/u,
      );
    });
  }
});

test("captures compatible reasoning_content as public semantic reasoning", async () => {
  const adapter = adapterReturning(
    streamResponse([
      chunk({
        choices: [
          {
            index: 0,
            delta: { reasoning_content: "check " },
            finish_reason: null,
          },
        ],
      }),
      chunk({
        choices: [
          {
            index: 0,
            delta: { content: "answer ", reasoning_content: "" },
            finish_reason: null,
          },
        ],
      }),
      chunk({
        choices: [
          {
            index: 0,
            delta: { content: "done", reasoning_content: "complete" },
            finish_reason: "stop",
          },
        ],
      }),
      "[DONE]",
    ]),
  );

  assert.deepEqual(await collect(adapter.stream(request())), [
    { type: "reasoning_started", reasoningId: "reasoning:0" },
    {
      type: "reasoning_content_delta",
      reasoningId: "reasoning:0",
      delta: "check ",
    },
    { type: "text_delta", delta: "answer " },
    { type: "text_delta", delta: "done" },
    {
      type: "reasoning_content_delta",
      reasoningId: "reasoning:0",
      delta: "complete",
    },
    {
      type: "reasoning",
      reasoningId: "reasoning:0",
      reasoningContent: "check complete",
      contentVisibility: "public",
    },
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

async function captureRequestBody(options: {
  provider: string;
  baseUrl: string;
  model: string;
  reasoningEffort?: string;
  defaultParams?: Readonly<Record<string, unknown>>;
  messages: ModelRequest["messages"];
  tools?: ModelRequest["tools"];
}): Promise<Readonly<Record<string, unknown>>> {
  let body: Readonly<Record<string, unknown>> = {};
  const adapter = new OpenAiCompatibleModel({
    baseUrl: options.baseUrl,
    apiKey: fakeKey,
    provider: options.provider,
    ...(options.defaultParams === undefined
      ? {}
      : { defaultParams: options.defaultParams }),
    fetch: (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Readonly<
        Record<string, unknown>
      >;
      return streamResponse(["[DONE]"]);
    }) as typeof fetch,
  });
  await collect(
    adapter.stream(
      request({
        model: options.model,
        reasoningEffort: options.reasoningEffort ?? "medium",
        messages: options.messages,
        tools: options.tools ?? [],
      }),
    ),
  );
  return body;
}

function reasoningHistory(): ModelRequest["messages"] {
  return [
    { role: "user", text: "run pwd" },
    {
      role: "reasoning",
      reasoningContent: "tool reasoning",
      contentVisibility: "public",
    },
    {
      role: "assistant",
      text: "using shell",
      toolCalls: [
        {
          callId: "call-1",
          name: "shell",
          arguments: { command: "pwd" },
        },
      ],
    },
    { role: "tool", callId: "call-1", text: "/workspace", exitCode: 0 },
    {
      role: "reasoning",
      reasoningContent: "final reasoning",
      contentVisibility: "public",
    },
    { role: "assistant", text: "done" },
  ];
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
