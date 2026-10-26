import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHostedAppServer } from "../../../apps/cli/src/host.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { probeOpenAiCompatibleImage } from "../src/main/image-capability-probe.js";

test("explicit image probe uses the real adapter request and classifies supported, unsupported, and inconclusive", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-probe-canonical-"),
  );
  const host = createHostedAppServer({
    cwd: "/tmp",
    dataDirectory: directory,
    provider: { type: "fake" },
    model: "fake",
    approvalPolicy: "never",
  });
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
          baseUrl: base,
          apiKey: "probe-secret",
          provider: "fake-http-provider",
          model,
          execute: (request, signal) =>
            host.runConfiguredModelOperation(
              request.input,
              request.profile,
              signal,
            ),
        }),
        expected,
      );
    }
  } finally {
    await host.closeHostResources();
    await rm(directory, { recursive: true, force: true });
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

test("probe transport failures are inconclusive", async () => {
  assert.equal(
    await probeOpenAiCompatibleImage({
      baseUrl: "https://provider.example.test/v1",
      apiKey: "secret",
      provider: "provider",
      model: "model",
      execute: async () => ({
        threadId: "synthetic",
        operationItemId: "synthetic",
        status: "failed",
        error: "Model operation failed",
        probeOutcome: "inconclusive",
      }),
    }),
    "inconclusive",
  );
});

test("explicit Responses image check uses canonical Host dispatch only and never guesses Chat fallback", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-responses-probe-"),
  );
  const host = createHostedAppServer({
    cwd: "/tmp",
    dataDirectory: directory,
    provider: { type: "fake" },
    model: "fake",
    approvalPolicy: "never",
  });
  const requests: Array<{ url: string; body: Record<string, any> }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push({ url: request.url ?? "", body: parsed });
      if (parsed.model === "supported") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
        );
      } else {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          '{"error":{"type":"invalid_request_error","message":"not supported"}}',
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    for (const model of ["supported", "ambiguous"]) {
      const outcome = await probeOpenAiCompatibleImage({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        protocol: "responses",
        apiKey: "synthetic-not-real",
        provider: "fixture",
        model,
        execute: (request, signal) =>
          host.runConfiguredModelOperation(
            request.input,
            request.profile,
            signal,
          ),
      });
      assert.equal(
        outcome,
        model === "supported" ? "supported" : "inconclusive",
      );
    }
    assert.equal(requests.length, 2);
    for (const { url, body } of requests) {
      assert.equal(url, "/v1/responses");
      assert.equal(body.max_output_tokens, 1);
      assert.equal("max_tokens" in body, false);
      assert.equal(body.input[0].content[1].type, "input_image");
    }
  } finally {
    await host.closeHostResources();
    await rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
