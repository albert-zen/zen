import assert from "node:assert/strict";
import test from "node:test";
import {
  pluginToolNamespace,
  responsesToolPresentation,
  supportsHostedToolSearch,
} from "../src/model/deferred-tools.js";

const weather = {
  name: "weather_lookup",
  description: "Look up weather.",
  fullDescription: "Look up weather. Detailed documented semantics.",
  pluginId: "weather",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
};
const shell = {
  name: "shell",
  description: "Run a command.",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};

test("hosted discovery requires an explicitly verified endpoint and model pair", () => {
  for (const model of ["gpt-5.4", "gpt-6-astra"]) {
    assert.equal(
      supportsHostedToolSearch("https://api.openai.com/v1/responses", model),
      true,
    );
    for (const endpoint of [
      "https://api.deepseek.com/v1/responses",
      "https://proxy.test/v1/responses",
      "https://chatgpt.com/backend-api/codex/responses",
      "https://api.openai.com/v1/chat/completions",
      "http://api.openai.com/v1/responses",
    ]) {
      assert.equal(supportsHostedToolSearch(endpoint, model), false);
    }
  }
  for (const model of [
    "deepseek-chat",
    "gpt-4.1",
    "gpt-5.3",
    "gpt-5.4-nano",
    "gpt-6-luna",
    "gpt-5.4-2099-01-01",
    "unknown",
  ]) {
    assert.equal(
      supportsHostedToolSearch("https://api.openai.com/v1/responses", model),
      false,
    );
  }
});

test("deferred namespaces retain full real definitions and stable order without expanding the prefix after discovery", () => {
  const first = responsesToolPresentation([weather, shell], true);
  const second = responsesToolPresentation(
    [shell, structuredClone(weather)],
    true,
  );
  assert.equal(JSON.stringify(first.tools), JSON.stringify(second.tools));
  assert.deepEqual(first.tools, [
    {
      type: "function",
      name: shell.name,
      description: shell.description,
      parameters: shell.inputSchema,
      strict: false,
    },
    {
      type: "namespace",
      name: pluginToolNamespace("weather"),
      description: "Tools provided by the weather plugin.",
      tools: [
        {
          type: "function",
          name: weather.name,
          description: weather.fullDescription,
          parameters: weather.inputSchema,
          strict: false,
          defer_loading: true,
        },
      ],
    },
    { type: "tool_search" },
  ]);
  assert.equal(
    first.namespaces.get(weather.name),
    pluginToolNamespace("weather"),
  );
});

test("unsupported transports keep concise actual schemas without native discovery claims", () => {
  const presentation = responsesToolPresentation([weather, shell], false);
  assert.equal(presentation.namespaces.size, 0);
  assert.ok(
    presentation.tools.every(
      (tool) => tool.type === "function" && !("defer_loading" in tool),
    ),
  );
  const tool = presentation.tools.find((tool) => tool.name === weather.name)!;
  assert.equal(tool.description, weather.description);
  assert.deepEqual(tool.parameters, weather.inputSchema);
});

test("plugin namespaces are valid bounded collision-resistant identities", () => {
  assert.match(pluginToolNamespace("a".repeat(1000)), /^[a-zA-Z0-9_-]{1,64}$/u);
  assert.notEqual(pluginToolNamespace("a/b"), pluginToolNamespace("a_b"));
});

import { createHash } from "node:crypto";
import { OpenAiResponsesModel } from "../src/model/openai-responses.js";
import type { ModelEvent, ModelRequest } from "../src/model.js";

const endpoint = "https://api.openai.com/v1/responses";
const endpointSha256 = createHash("sha256").update(endpoint).digest("hex");
const namespace = pluginToolNamespace("weather");
const searchCall = {
  type: "tool_search_call",
  execution: "server",
  call_id: null,
  status: "completed",
  arguments: { paths: [namespace] },
};
const searchOutput = {
  type: "tool_search_output",
  execution: "server",
  call_id: null,
  status: "completed",
  tools: [
    {
      type: "namespace",
      name: namespace,
      description: "Weather tools",
      tools: [
        {
          type: "function",
          name: weather.name,
          description: weather.fullDescription,
          parameters: weather.inputSchema,
          defer_loading: true,
        },
      ],
    },
  ],
};
const functionCall = {
  type: "function_call",
  id: "fc_weather",
  call_id: "call_weather",
  name: weather.name,
  namespace,
  arguments: '{"city":"Paris"}',
};
function streamFixture(output: unknown[], streamItems = true): Response {
  const events = [
    ...(streamItems
      ? output.flatMap((item, output_index) => [
          { type: "response.output_item.added", output_index, item },
          { type: "response.output_item.done", output_index, item },
        ])
      : []),
    { type: "response.completed", response: { status: "completed", output } },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
}
function modelRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "gpt-5.4",
    providerToolPresentation: {
      protocol: "openai-responses",
      tools: responsesToolPresentation([shell, weather], true).tools,
    },
    reasoningEffort: null,
    tools: [shell, weather],
    messages: [{ role: "user", text: "Weather in Paris?" }],
    signal: new AbortController().signal,
    ...overrides,
  };
}
async function collect(
  events: AsyncIterable<ModelEvent>,
): Promise<ModelEvent[]> {
  const result: ModelEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

test("hosted streamed search is semantic replay, not a local tool dispatch, and terminal output is deduplicated", async () => {
  for (const streamItems of [false, true]) {
    const adapter = new OpenAiResponsesModel({
      baseUrl: endpoint,
      apiKey: "synthetic-key",
      fetch: async () =>
        streamFixture([searchCall, searchOutput, functionCall], streamItems),
    });
    const events = await collect(adapter.stream(modelRequest()));
    assert.deepEqual(
      events.map((event) => event.type),
      ["tool_discovery", "tool_discovery", "tool_call", "usage"],
    );
    assert.deepEqual(events[0], {
      type: "tool_discovery",
      protocol: "openai-responses",
      endpointSha256,
      items: [searchCall],
    });
    assert.deepEqual(events[1], {
      type: "tool_discovery",
      protocol: "openai-responses",
      endpointSha256,
      items: [searchOutput],
    });
    assert.deepEqual(events[2], {
      type: "tool_call",
      callId: "call_weather|fc_weather",
      name: weather.name,
      providerNamespace: namespace,
      arguments: { city: "Paris" },
    });
  }
});

test("search definitions append in history while native tools and earlier input remain byte stable", async () => {
  const bodies: any[] = [];
  const adapter = new OpenAiResponsesModel({
    baseUrl: endpoint,
    apiKey: "synthetic-key",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return streamFixture([]);
    },
  });
  const initial = modelRequest();
  await collect(adapter.stream(initial));
  await collect(
    adapter.stream(
      modelRequest({
        messages: [
          ...initial.messages,
          {
            role: "tool_discovery",
            protocol: "openai-responses",
            endpointSha256,
            items: [searchCall, searchOutput],
          },
          {
            role: "assistant",
            toolCalls: [
              {
                callId: "call_weather|fc_weather",
                name: weather.name,
                providerNamespace: namespace,
                arguments: { city: "Paris" },
              },
            ],
          },
          {
            role: "tool",
            callId: "call_weather|fc_weather",
            exitCode: 0,
            text: "Sunny",
          },
        ],
      }),
    ),
  );
  assert.equal(
    JSON.stringify(bodies[0].tools),
    JSON.stringify(bodies[1].tools),
  );
  assert.deepEqual(
    bodies[1].input.slice(0, bodies[0].input.length),
    bodies[0].input,
  );
  assert.deepEqual(bodies[1].input.slice(1, 3), [searchCall, searchOutput]);
  assert.equal(bodies[1].input[3].namespace, namespace);
  assert.equal(bodies[1].input[4].type, "function_call_output");
});

test("custom endpoint and unsupported model never receive native discovery history or flags", async () => {
  for (const [baseUrl, model] of [
    ["https://proxy.test/v1/responses", "gpt-5.4"],
    [endpoint, "gpt-4.1"],
  ]) {
    let body: any;
    const adapter = new OpenAiResponsesModel({
      baseUrl: baseUrl!,
      apiKey: "synthetic-key",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return streamFixture([]);
      },
    });
    await collect(
      adapter.stream(
        modelRequest({
          model: model!,
          messages: [
            {
              role: "tool_discovery",
              protocol: "openai-responses",
              endpointSha256,
              items: [searchCall, searchOutput],
            },
          ],
        }),
      ),
    );
    assert.deepEqual(body.input, []);
    assert.ok(
      body.tools.every(
        (tool: any) => tool.type === "function" && !tool.defer_loading,
      ),
    );
  }
});

test("client search, incomplete search and foreign namespace fail closed before tool dispatch", async () => {
  for (const item of [
    { ...searchCall, execution: "client", call_id: "client_call" },
    { ...searchCall, status: "in_progress" },
    { ...functionCall, namespace: "foreign" },
    { ...searchOutput, tools: [{ type: "function", name: "not_registered" }] },
  ]) {
    const adapter = new OpenAiResponsesModel({
      baseUrl: endpoint,
      apiKey: "synthetic-key",
      fetch: async () => streamFixture([item]),
    });
    await assert.rejects(
      collect(adapter.stream(modelRequest())),
      /discovery|namespace|unavailable/iu,
    );
  }
});

test("native search is never introduced without compiler-owned sample intent", async () => {
  let body: any;
  const adapter = new OpenAiResponsesModel({
    baseUrl: endpoint,
    apiKey: "synthetic-key",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return streamFixture([]);
    },
  });
  assert.equal(
    adapter.prepareToolPresentation("gpt-5.4", [weather])?.protocol,
    "openai-responses",
  );
  assert.equal(
    adapter.prepareToolPresentation("unknown", [weather]),
    undefined,
  );
  const withoutIntent = modelRequest();
  delete withoutIntent.providerToolPresentation;
  await collect(adapter.stream(withoutIntent));
  assert.ok(body.tools.every((tool: any) => tool.type === "function"));
});

import { OpenAiCompatibleModel } from "../src/model/openai-compatible.js";
import { OpenAiSubscriptionModel } from "../src/model/openai-subscription.js";

test("DeepSeek-compatible and subscription adapters omit foreign discovery semantics", async () => {
  const bodies: any[] = [];
  const fetchBody =
    (chat: boolean): typeof globalThis.fetch =>
    async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return chat
        ? new Response(
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          )
        : streamFixture([]);
    };
  const chat = new OpenAiCompatibleModel({
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "synthetic-key",
    fetch: fetchBody(true),
  });
  const subscription = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({
      accessToken: `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`,
    }),
    fetch: fetchBody(false),
  });
  const request = modelRequest({
    messages: [
      {
        role: "tool_discovery",
        protocol: "openai-responses",
        endpointSha256,
        items: [searchCall, searchOutput],
      },
      { role: "user", text: "Continue" },
    ],
  });
  await collect(chat.stream(request));
  await collect(subscription.stream({ ...request, reasoningEffort: "medium" }));
  assert.deepEqual(bodies[0].messages, [{ role: "user", content: "Continue" }]);
  assert.ok(
    bodies[1].input.every(
      (item: any) => !String(item.type).startsWith("tool_search"),
    ),
  );
  for (const body of bodies)
    assert.ok(
      body.tools.every(
        (tool: any) => tool.type === "function" && !tool.defer_loading,
      ),
    );
});

test("discovery replay cannot cross endpoint provenance even on a native-capable destination", async () => {
  let body: any;
  const adapter = new OpenAiResponsesModel({
    baseUrl: endpoint,
    apiKey: "synthetic-key",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return streamFixture([]);
    },
  });
  await collect(
    adapter.stream(
      modelRequest({
        messages: [
          {
            role: "tool_discovery",
            protocol: "openai-responses",
            endpointSha256: "0".repeat(64),
            items: [searchCall, searchOutput],
          },
        ],
      }),
    ),
  );
  assert.deepEqual(body.input, []);
});
