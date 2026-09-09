import assert from "node:assert/strict";
import test from "node:test";
import type { ModelEvent, ModelRequest } from "../src/model.js";
import { OpenAiSubscriptionModel } from "../src/model/openai-subscription.js";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import {
  createRunCodeModelTool,
  generateToolCatalog,
} from "../src/tool-presentation.js";

const code =
  '// @exec: {"yield_time_ms": 20, "max_output_tokens": 100}\ntext("你好\\n");';
const tool = createRunCodeModelTool([]);
const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.x`;
const terminal = {
  type: "response.completed",
  response: { status: "completed" },
};
function response(events: unknown[]): Response {
  return new Response(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
  );
}
function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "test",
    reasoningEffort: "medium",
    messages: [],
    tools: [tool],
    signal: new AbortController().signal,
    ...overrides,
  };
}
async function collect(events: AsyncIterable<ModelEvent>) {
  const result: ModelEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
function subscription(
  events: unknown[],
  capture?: (body: Record<string, any>) => void,
) {
  return new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({ accessToken: token }),
    fetch: async (_url, init) => {
      capture?.(JSON.parse(String(init?.body)));
      return response(events);
    },
  });
}

test("run_code declares pure JavaScript and code-only fallback with explicit helpers", () => {
  assert.deepEqual(tool.inputSchema.required, ["code"]);
  assert.deepEqual(Object.keys(tool.inputSchema.properties as object), [
    "code",
  ]);
  assert.match(tool.description, /JavaScript/);
  assert.doesNotMatch(
    tool.description,
    /shell-equivalent|erasable TypeScript|Node.js authority/,
  );
  for (const helper of [
    "text",
    "image",
    "audio",
    "exit",
    "store",
    "load",
    "ALL_TOOLS",
    "yield_control",
    "yield_time_ms",
    "max_output_tokens",
  ]) {
    assert.ok(tool.description.includes(helper), helper);
  }
});

test("Responses offers custom JS and replays canonical history even when run_code is no longer offered", async () => {
  const messages: ModelRequest["messages"] = [
    {
      role: "assistant",
      toolCalls: [{ callId: "call-1", name: "run_code", arguments: { code } }],
    },
    { role: "tool", callId: "call-1", text: "你好", exitCode: 0 },
  ];
  for (const tools of [[tool], []]) {
    let body: any;
    await collect(
      subscription([terminal], (b) => {
        body = b;
      }).stream(request({ tools, messages })),
    );
    if (tools.length) {
      assert.equal(body.tools[0].type, "custom");
      assert.equal(body.tools[0].format.type, "grammar");
      assert.match(body.tools[0].format.definition, /PRAGMA_LINE/);
    }
    assert.deepEqual(body.input, [
      {
        type: "custom_tool_call",
        call_id: "call-1",
        name: "run_code",
        input: code,
      },
      {
        type: "custom_tool_call_output",
        call_id: "call-1",
        output: "Exit code: 0\n你好",
      },
    ]);
  }
});

test("Responses assembles custom deltas and emits canonical code exactly once", async () => {
  const item = {
    type: "custom_tool_call",
    id: "ctc_1",
    call_id: "call-1",
    name: "run_code",
  };
  const events = await collect(
    subscription([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, input: "" },
      },
      {
        type: "response.custom_tool_call_input.delta",
        output_index: 0,
        delta: code.slice(0, 30),
      },
      {
        type: "response.custom_tool_call_input.delta",
        output_index: 0,
        delta: code.slice(30),
      },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: { status: "completed", output: [{ ...item, input: code }] },
      },
    ]).stream(request()),
  );
  assert.deepEqual(
    events.filter((e) => e.type === "tool_call"),
    [
      {
        type: "tool_call",
        callId: "call-1|ctc_1",
        name: "run_code",
        arguments: { code },
      },
    ],
  );
});

test("Responses custom done input replaces partial deltas and rejects unavailable tools", async () => {
  const item = {
    type: "custom_tool_call",
    call_id: "call-1",
    name: "run_code",
  };
  const stream = [
    { type: "response.output_item.added", output_index: 0, item },
    {
      type: "response.custom_tool_call_input.delta",
      output_index: 0,
      delta: "partial",
    },
    {
      type: "response.custom_tool_call_input.done",
      output_index: 0,
      input: code,
    },
    { type: "response.output_item.done", output_index: 0, item },
    terminal,
  ];
  const events = await collect(subscription(stream).stream(request()));
  assert.deepEqual(
    events.find((e) => e.type === "tool_call"),
    {
      type: "tool_call",
      callId: "call-1",
      name: "run_code",
      arguments: { code },
    },
  );
  await assert.rejects(
    collect(subscription(stream).stream(request({ tools: [] }))),
    /unavailable tool/,
  );
});

test("Chat Completions uses code-only JSON and replays the same canonical code", async () => {
  let body: any;
  const adapter = new OpenAiCompatibleModel({
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return response([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-2",
                    type: "function",
                    function: {
                      name: "run_code",
                      arguments: JSON.stringify({ code }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]);
    },
  });
  const events = await collect(
    adapter.stream(
      request({
        messages: [
          {
            role: "assistant",
            toolCalls: [
              { callId: "call-1", name: "run_code", arguments: { code } },
            ],
          },
        ],
      }),
    ),
  );
  assert.equal(body.tools[0].type, "function");
  assert.deepEqual(body.tools[0].function.parameters.required, ["code"]);
  assert.equal(
    body.messages[0].tool_calls[0].function.arguments,
    JSON.stringify({ code }),
  );
  assert.deepEqual(
    events.find((e) => e.type === "tool_call"),
    {
      type: "tool_call",
      callId: "call-2",
      name: "run_code",
      arguments: { code },
    },
  );
});

test("Responses handles terminal-only mixed custom/function calls and rejects a mismatched format", async () => {
  const shell = {
    name: "shell",
    description: "Shell",
    inputSchema: { type: "object" },
  };
  const output = [
    {
      type: "custom_tool_call",
      call_id: "call-code",
      name: "run_code",
      input: code,
    },
    {
      type: "function_call",
      call_id: "call-shell",
      name: "shell",
      arguments: '{"command":"pwd"}',
    },
  ];
  const events = await collect(
    subscription([
      { type: "response.completed", response: { status: "completed", output } },
    ]).stream(request({ tools: [tool, shell] })),
  );
  assert.deepEqual(
    events.filter((e) => e.type === "tool_call"),
    [
      {
        type: "tool_call",
        callId: "call-code",
        name: "run_code",
        arguments: { code },
      },
      {
        type: "tool_call",
        callId: "call-shell",
        name: "shell",
        arguments: { command: "pwd" },
      },
    ],
  );
  await assert.rejects(
    collect(
      subscription([
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              {
                type: "custom_tool_call",
                call_id: "call-shell",
                name: "shell",
                input: code,
              },
            ],
          },
        },
      ]).stream(request({ tools: [shell] })),
    ),
    /mismatched tool input format/,
  );
});

test("tool catalog shares disclosed ordinary definitions without exposing orchestration entries", () => {
  const definitions = [
    { name: "shown", description: "Visible", inputSchema: {} },
    tool,
    { name: "compact_context", description: "Compact", inputSchema: {} },
  ];
  assert.deepEqual(generateToolCatalog(definitions), [
    { name: "shown", description: "Visible" },
  ]);
  const catalog = generateToolCatalog(definitions);
  definitions[0]!.description = "changed";
  assert.equal(catalog[0]!.description, "Visible");
});

test("audio uses Chat input_audio and honest Responses text references, including tool output", async () => {
  for (const [mediaType, format] of [
    ["audio/wav", "wav"],
    ["audio/mpeg", "mp3"],
  ]) {
    // Wire fixture deliberately does not depend on attachment ingestion or decoder validation.
    const audio = JSON.parse(
      JSON.stringify({
        type: "audio",
        attachment: {
          type: "attachment",
          sha256: "a".repeat(64),
          mediaType,
          byteLength: 3,
        },
      }),
    );
    const messages: ModelRequest["messages"] = [
      { role: "user", content: [audio] },
      {
        role: "assistant",
        toolCalls: [
          {
            callId: "call-audio",
            name: "run_code",
            arguments: { code: "audio(result)" },
          },
        ],
      },
      {
        role: "tool",
        callId: "call-audio",
        text: "sound",
        exitCode: 0,
        modelContent: [audio],
      },
    ];
    let chat: any;
    const adapter = new OpenAiCompatibleModel({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      attachments: { read: async () => new Uint8Array([1, 2, 3]) },
      fetch: async (_url, init) => {
        chat = JSON.parse(String(init?.body));
        return response([
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      },
    });
    await collect(adapter.stream(request({ messages })));
    for (const message of [chat.messages[0], chat.messages[3]]) {
      assert.deepEqual(message.content, [
        { type: "input_audio", input_audio: { data: "AQID", format } },
      ]);
    }
    let responses: any;
    await collect(
      subscription([terminal], (body) => {
        responses = body;
      }).stream(request({ messages })),
    );
    for (const message of [responses.input[0], responses.input[3]]) {
      assert.equal(message.content[0].type, "input_text");
      assert.match(message.content[0].text, /audio.*not supported/i);
      assert.ok(message.content[0].text.includes("a".repeat(64)));
      assert.ok(message.content[0].text.includes(mediaType));
    }
    assert.equal(messages[0]!.role, "user");
    assert.equal(audio.type, "audio");
  }
});

test("Responses rejects malformed custom source instead of silently executing an empty program", async () => {
  await assert.rejects(
    collect(
      subscription([
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              {
                type: "custom_tool_call",
                call_id: "bad",
                name: "run_code",
                input: { code },
              },
            ],
          },
        },
      ]).stream(request()),
    ),
    /invalid custom tool input/,
  );
});
