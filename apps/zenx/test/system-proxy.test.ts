import assert from "node:assert/strict";
import test from "node:test";

import { proxyUrl, zenXProviderTransport } from "../src/main/system-proxy.js";

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
