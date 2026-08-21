import assert from "node:assert/strict";
import test from "node:test";

import {
  proxyUrl,
  withZenXProviderTransports,
  zenXProviderTransport,
} from "../src/main/system-proxy.js";

test("projects the resolved system proxy into provider child host configuration", async () => {
  const transport = await zenXProviderTransport(
    {
      cwd: "/tmp/work",
      dataDirectory: "/tmp/data",
      model: "gpt",
      models: ["gpt"],
      approvalPolicy: "never",
      provider: {
        type: "openai-subscription",
        profilePath: "/tmp/auth",
      },
    },
    async (url) => {
      assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
      return "PROXY 127.0.0.1:7897; DIRECT";
    },
  );
  assert.deepEqual(transport, { proxyUrl: "http://127.0.0.1:7897" });
});

test("projects DIRECT without a transport", async () => {
  const transport = await zenXProviderTransport(
    {
      cwd: "/tmp/work",
      dataDirectory: "/tmp/data",
      model: "gpt",
      models: ["gpt"],
      approvalPolicy: "never",
      provider: {
        type: "openai-compatible",
        baseUrl: "https://provider.example/v1",
        apiKey: "not-forwarded-by-this-helper",
      },
    },
    async () => "DIRECT",
  );
  assert.equal(transport, undefined);
});

test("resolves a separate transport for every configured Provider profile", async () => {
  const endpoints: string[] = [];
  const config = await withZenXProviderTransports(
    {
      cwd: "/tmp/work",
      dataDirectory: "/tmp/data",
      approvalPolicy: "never",
      providers: [
        {
          providerProfileId: "a",
          provider: {
            type: "openai-compatible",
            baseUrl: "https://a.example/v1",
            apiKey: "a-key",
          },
          model: "shared",
        },
        {
          providerProfileId: "b",
          provider: {
            type: "openai-compatible",
            baseUrl: "https://b.example/v1",
            apiKey: "b-key",
          },
          model: "shared",
        },
      ],
      defaultSelection: { providerProfileId: "a", modelId: "shared" },
    },
    async (endpoint) => {
      endpoints.push(endpoint);
      return endpoint.includes("a.example") ? "PROXY a.proxy:80" : "DIRECT";
    },
  );
  assert.deepEqual(endpoints, ["https://a.example/v1", "https://b.example/v1"]);
  assert.deepEqual(
    config.providers?.map((profile) => profile.transport),
    [{ proxyUrl: "http://a.proxy:80" }, undefined],
  );
});

test("accepts direct, HTTP and IPv6 proxy directives without credentials", () => {
  assert.equal(proxyUrl("DIRECT"), undefined);
  assert.equal(proxyUrl("DIRECT; PROXY proxy.test:80"), undefined);
  assert.equal(proxyUrl("HTTPS proxy.test:443"), "https://proxy.test:443");
  assert.equal(proxyUrl("PROXY 2001:db8::1:8080"), "http://[2001:db8::1]:8080");
  assert.equal(
    proxyUrl("SOCKS5 127.0.0.1:1080; PROXY proxy.test:80"),
    "http://proxy.test:80",
  );
  assert.equal(proxyUrl("SOCKS 127.0.0.1:1080; DIRECT"), undefined);
  assert.throws(
    () => proxyUrl("SOCKS5 127.0.0.1:1080"),
    /unsupported proxy types/u,
  );
  assert.throws(() => proxyUrl(""), /empty route/u);
  assert.throws(() => proxyUrl("PROXY user@proxy.test:80"), /unsupported/u);
});
