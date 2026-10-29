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
