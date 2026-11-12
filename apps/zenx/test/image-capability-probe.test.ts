import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileTraceStore } from "../../../src/trace.js";
import { FileAttachmentStore } from "../../../src/attachment.js";
import { FileItemListStore } from "../../../src/item-list-store.js";
import { closeModelTrace } from "../../../src/trace-model.js";

async function evidence(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-probe-"));
  const trace = new FileTraceStore(path.join(directory, "trace"));
  t.after(async () => {
    await closeModelTrace(trace);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    trace,
    itemListStore: new FileItemListStore(
      path.join(directory, "context-bundles"),
    ),
    attachments: new FileAttachmentStore(path.join(directory, "attachments")),
  };
}

import { probeOpenAiCompatibleImage } from "../src/main/image-capability-probe.js";

test("explicit image probe uses the real adapter request and classifies supported, unsupported, and inconclusive", async (t) => {
  const captured = await evidence(t);
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer probe-secret");
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push(parsed);
      const model = parsed.model;
      if (model === "supported") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      } else if (model === "unsupported") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              code: "unsupported_image_input",
              message: "This model does not support image content types",
            },
          }),
        );
      } else {
        const failure =
          model === "auth"
            ? [401, "invalid_token", "Authentication failed"]
            : model === "quota"
              ? [402, "quota_exceeded", "Quota exhausted"]
              : model === "missing"
                ? [404, "model_not_found", "Model not found"]
                : model === "ambiguous"
                  ? [400, "invalid_request", "Request rejected"]
                  : [429, "rate_limit", "Try later"];
        response.writeHead(failure[0] as number, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            error: { code: failure[1], message: failure[2] },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/v1`;
    for (const [model, expected] of [
      ["supported", "supported"],
      ["unsupported", "unsupported"],
      ["rate-limited", "inconclusive"],
      ["auth", "inconclusive"],
      ["quota", "inconclusive"],
      ["missing", "inconclusive"],
      ["ambiguous", "inconclusive"],
    ] as const) {
      assert.equal(
        await probeOpenAiCompatibleImage({
          ...captured,
          baseUrl: base,
          apiKey: "probe-secret",
          provider: "fake-http-provider",
          model,
        }),
        expected,
      );
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  }
  assert.equal(requests.length, 10);
  assert.equal(
    requests.filter((request) => request.model === "rate-limited").length,
    4,
  );
  assert.equal(
    requests.filter((request) => request.model === "auth").length,
    1,
  );
  for (const request of requests) {
    assert.equal(request.max_tokens, 1);
    assert.equal(request.stream, true);
    const messages = request.messages as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    assert.deepEqual(
      messages[0]?.content.map((entry) => entry.type),
      ["text", "image_url"],
    );
    assert.match(
      (messages[0]?.content[1]?.image_url as { url: string }).url,
      /^data:image\/png;base64,/u,
    );
  }
});

test("probe transport failures are inconclusive", async (t) => {
  const captured = await evidence(t);
  assert.equal(
    await probeOpenAiCompatibleImage({
      ...captured,
      baseUrl: "https://provider.example.test/v1",
      apiKey: "secret",
      provider: "provider",
      model: "model",
      fetch: async () => {
        throw new Error("network unavailable");
      },
    }),
    "inconclusive",
  );
});

test("probe context persistence failure is explicit rather than an inconclusive provider result", async (t) => {
  const captured = await evidence(t);
  let fetches = 0;
  await assert.rejects(
    probeOpenAiCompatibleImage({
      ...captured,
      trace: {
        record: async () => ({
          durability: "degraded",
          error: "Synthetic disk failure",
        }),
      },
      baseUrl: "https://synthetic.example.test/v1",
      apiKey: "synthetic-key",
      provider: "synthetic",
      model: "synthetic",
      fetch: async () => {
        fetches++;
        return new Response();
      },
    }),
    /context source was not durable/u,
  );
  assert.equal(fetches, 0);
  assert.deepEqual(await captured.itemListStore.listThreadIds(), []);
});
