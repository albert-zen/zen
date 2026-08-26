import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { png1x1 } from "./fixtures.js";

import {
  OpenAiSubscriptionAuthProfile,
  SubscriptionCredentialStore,
  type OAuthCredential,
} from "../apps/cli/src/subscription-auth.js";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import { InMemoryAttachmentStore } from "../src/attachment.js";
import type { ModelEvent, ModelRequest, ModelTool } from "../src/model.js";
import { OpenAiSubscriptionModel } from "../src/model/openai-subscription.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";

const accountId = "acct_zen_test";
const secretAccessToken = jwt(accountId);

test("maps AttachmentRef input to a Responses image part", async () => {
  const attachments = new InMemoryAttachmentStore();
  const ref = await attachments.importBytes(png1x1());
  let body: Record<string, unknown> = {};
  const adapter = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({ accessToken: secretAccessToken }),
    attachments,
    fetch: async (_input, init) => {
      body = requestBody(init);
      return sseResponse([
        {
          type: "response.completed",
          response: { status: "completed", output: [] },
        },
      ]);
    },
  });

  await collect(
    adapter.stream(
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image", attachment: ref },
            ],
          },
        ],
      }),
    ),
  );
  assert.deepEqual(body.input, [
    {
      role: "user",
      content: [
        { type: "input_text", text: "describe" },
        {
          type: "input_image",
          image_url: `data:image/png;base64,${Buffer.from(png1x1()).toString("base64")}`,
        },
      ],
    },
  ]);
});

test("sends a native Codex Responses request and maps SSE output", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const adapter = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({ accessToken: secretAccessToken }),
    endpoint: "https://example.test/backend-api/codex/responses",
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return sseResponse([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "reasoning", id: "rs_1", summary: [] },
        },
        {
          type: "response.reasoning_summary_text.delta",
          output_index: 0,
          delta: "checked",
        },
        {
          type: "response.reasoning_summary_text.delta",
          output_index: 0,
          delta: "",
        },
        {
          type: "response.reasoning_summary_part.done",
          output_index: 0,
        },
        {
          type: "response.reasoning_summary_text.delta",
          output_index: 0,
          delta: "the command",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "reasoning",
            id: "rs_1",
            summary: [
              { type: "summary_text", text: "checked" },
              { type: "summary_text", text: "the command" },
            ],
            encrypted_content: "encrypted-reasoning-state",
          },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [],
          },
        },
        {
          type: "response.output_text.delta",
          output_index: 1,
          delta: "done",
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        },
        {
          type: "response.output_item.added",
          output_index: 2,
          item: {
            type: "function_call",
            id: "fc_2",
            call_id: "call_2",
            name: "shell",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 2,
          delta: '{"command":"',
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 2,
          arguments: '{"command":"pwd"}',
        },
        {
          type: "response.output_item.done",
          output_index: 2,
          item: {
            type: "function_call",
            id: "fc_2",
            call_id: "call_2",
            name: "shell",
            arguments: '{"command":"pwd"}',
          },
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              {
                type: "reasoning",
                id: "rs_1",
                summary: [
                  {
                    type: "summary_text",
                    text: "checked",
                  },
                  {
                    type: "summary_text",
                    text: "the command",
                  },
                ],
              },
              {
                type: "message",
                id: "msg_1",
                role: "assistant",
                content: [{ type: "output_text", text: "done" }],
              },
              {
                type: "function_call",
                id: "fc_2",
                call_id: "call_2",
                name: "shell",
                arguments: '{"command":"pwd"}',
              },
            ],
            usage: { input_tokens: 12, output_tokens: 7 },
          },
        },
      ]);
    },
  });

  const events = await collect(
    adapter.stream(
      request({
        sessionId: "thread-one",
        messages: [
          { role: "user", text: "first" },
          {
            role: "assistant",
            text: "running",
            toolCalls: [
              {
                callId: "call_1|fc_1",
                name: "shell",
                arguments: { command: "echo first" },
              },
            ],
          },
          {
            role: "tool",
            callId: "call_1|fc_1",
            text: "first",
            exitCode: 0,
          },
        ],
        tools: [shellTool()],
      }),
    ),
  );

  assert.deepEqual(events, [
    { type: "reasoning_started", reasoningId: "reasoning:0" },
    {
      type: "reasoning_summary_delta",
      reasoningId: "reasoning:0",
      delta: "checked",
    },
    {
      type: "reasoning_summary_delta",
      reasoningId: "reasoning:0",
      delta: "\n\nthe command",
    },
    {
      type: "reasoning",
      reasoningId: "reasoning:0",
      summary: "checked\n\nthe command",
      reasoningContent: "encrypted-reasoning-state",
      contentVisibility: "opaque",
      providerItemId: "rs_1",
    },
    { type: "text_delta", delta: "done" },
    {
      type: "tool_call",
      callId: "call_2|fc_2",
      name: "shell",
      arguments: { command: "pwd" },
    },
    { type: "usage", inputTokens: 12, outputTokens: 7 },
  ]);
  assert.equal(capturedUrl, "https://example.test/backend-api/codex/responses");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${secretAccessToken}`);
  assert.equal(headers.get("chatgpt-account-id"), accountId);
  assert.equal(headers.get("openai-beta"), "responses=experimental");
  assert.equal(headers.get("session-id"), "thread-one");
  assert.equal(headers.get("x-client-request-id"), "thread-one");

  const body = requestBody(capturedInit);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(body.reasoning, { effort: "medium" });
  assert.equal(body.prompt_cache_key, "thread-one");
  assert.deepEqual(body.tools, [
    {
      type: "function",
      name: "shell",
      description: "Run a command",
      parameters: shellTool().inputSchema,
      strict: null,
    },
  ]);
  assert.deepEqual(body.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "first" }],
    },
    {
      type: "message",
      id: "msg_zen_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "running", annotations: [] }],
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "shell",
      arguments: '{"command":"echo first"}',
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: "Exit code: 0\nfirst",
    },
  ]);
  assert.equal(JSON.stringify(body.input).includes("encrypted_content"), false);
});

test("keeps raw reasoning text private on the existing reasoning event", async () => {
  const adapter = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({ accessToken: secretAccessToken }),
    fetch: async () =>
      sseResponse([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "reasoning", id: "rs_private", summary: [] },
        },
        {
          type: "response.reasoning_text.delta",
          output_index: 0,
          delta: "raw chain of thought",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "reasoning",
            id: "rs_private",
            summary: [],
            content: [{ type: "reasoning_text", text: "raw chain of thought" }],
            encrypted_content: "encrypted-private-state",
          },
        },
        {
          type: "response.completed",
          response: { status: "completed", output: [] },
        },
      ]),
  });

  const events = await collect(adapter.stream(request()));
  assert.deepEqual(events, [
    { type: "reasoning_started", reasoningId: "reasoning:0" },
    {
      type: "reasoning",
      reasoningId: "reasoning:0",
      reasoningContent: "encrypted-private-state",
      contentVisibility: "opaque",
      providerItemId: "rs_private",
    },
    { type: "usage", inputTokens: 0, outputTokens: 0 },
  ]);
  assert.equal(JSON.stringify(events).includes("raw chain of thought"), false);
});

test("a fresh adapter replays existing reasoning history for a stateless tool round", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const responses = [
    sseResponse([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_first",
          summary: [],
        },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_first",
          summary: [
            { type: "summary_text", text: "first step" },
            { type: "summary_text", text: "second step" },
          ],
          encrypted_content: "provider-private-state",
        },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_first",
          call_id: "call_first",
          name: "shell",
          arguments: '{"command":"pwd"}',
        },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_first",
          call_id: "call_first",
          name: "shell",
          arguments: '{"command":"pwd"}',
        },
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [],
          usage: { input_tokens: 2, output_tokens: 1 },
        },
      },
    ]),
    sseResponse([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_final",
          role: "assistant",
          content: [],
        },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        delta: "finished",
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [],
          usage: { input_tokens: 4, output_tokens: 2 },
        },
      },
    ]),
  ];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    bodies.push(requestBody(init));
    const response = responses.shift();
    if (response === undefined) {
      throw new Error("unexpected request");
    }
    return response;
  };
  const initialMessages: ModelRequest["messages"] = [
    { role: "user", text: "run pwd" },
  ];

  const firstAdapter = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({ accessToken: secretAccessToken }),
    fetch,
  });
  const firstEvents = await collect(
    firstAdapter.stream(
      request({ messages: initialMessages, tools: [shellTool()] }),
    ),
  );
  assert.deepEqual(firstEvents[0], {
    type: "reasoning_started",
    reasoningId: "reasoning:0",
  });
  assert.deepEqual(firstEvents[1], {
    type: "reasoning",
    reasoningId: "reasoning:0",
    reasoningContent: "provider-private-state",
    summary: "first step\n\nsecond step",
    contentVisibility: "opaque",
    providerItemId: "rs_first",
  });
  assert.deepEqual(firstEvents[2], {
    type: "tool_call",
    callId: "call_first|fc_first",
    name: "shell",
    arguments: { command: "pwd" },
  });

  const secondAdapter = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({ accessToken: secretAccessToken }),
    fetch,
  });
  await collect(
    secondAdapter.stream(
      request({
        messages: [
          ...initialMessages,
          {
            role: "reasoning",
            reasoningContent: "provider-private-state",
            summary: "first step\n\nsecond step",
            contentVisibility: "opaque",
            providerItemId: "rs_first",
          },
          {
            role: "assistant",
            toolCalls: [
              {
                callId: "call_first|fc_first",
                name: "shell",
                arguments: { command: "pwd" },
              },
            ],
          },
          {
            role: "tool",
            callId: "call_first|fc_first",
            text: "/workspace",
            exitCode: 0,
          },
        ],
        tools: [shellTool()],
      }),
    ),
  );

  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1]?.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "run pwd" }],
    },
    {
      type: "reasoning",
      id: "rs_first",
      encrypted_content: "provider-private-state",
      summary: [{ type: "summary_text", text: "first step\n\nsecond step" }],
    },
    {
      type: "function_call",
      call_id: "call_first",
      name: "shell",
      arguments: '{"command":"pwd"}',
    },
    {
      type: "function_call_output",
      call_id: "call_first",
      output: "Exit code: 0\n/workspace",
    },
  ]);
});

test("renews a rejected access lease once before exposing HTTP 401", async () => {
  const refreshedAccessToken = jwt(accountId, "refreshed");
  const authorizations: string[] = [];
  let renewals = 0;
  const adapter = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({ accessToken: secretAccessToken }),
    renewAccessLease: async (rejectedAccessToken) => {
      renewals += 1;
      assert.equal(rejectedAccessToken, secretAccessToken);
      return { accessToken: refreshedAccessToken };
    },
    fetch: async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization")!);
      return new Response(null, { status: 401 });
    },
  });

  await assert.rejects(
    async () => await collect(adapter.stream(request())),
    /request failed with HTTP 401/u,
  );
  assert.equal(renewals, 1);
  assert.deepEqual(authorizations, [
    `Bearer ${secretAccessToken}`,
    `Bearer ${refreshedAccessToken}`,
  ]);
});

test("independent title and Agent profiles converge after a rejected access token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-auth-divergence-"));
  const profilePath = path.join(root, "openai-subscription-auth.json");
  const rejectedAccessToken = jwt(accountId, "rejected");
  const refreshedAccessToken = jwt(accountId, "renewed");
  const store = new SubscriptionCredentialStore(profilePath);
  await store.modify(async () => ({
    type: "oauth",
    access: rejectedAccessToken,
    refresh: "rotating-refresh",
    expires: Date.now() + 3_600_000,
    accountId,
  }));
  let refreshes = 0;
  const tokenFetch: typeof globalThis.fetch = async (_input, init) => {
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "rotating-refresh");
    refreshes += 1;
    return Response.json({
      access_token: refreshedAccessToken,
      refresh_token: "renewed-refresh",
      expires_in: 3600,
    });
  };
  const titleProfile = new OpenAiSubscriptionAuthProfile(profilePath, {
    fetch: tokenFetch,
    tokenEndpoint: "https://example.test/oauth/token",
  });
  const agentProfile = new OpenAiSubscriptionAuthProfile(profilePath, {
    fetch: tokenFetch,
    tokenEndpoint: "https://example.test/oauth/token",
  });
  const completed = (): Response =>
    sseResponse([
      {
        type: "response.completed",
        response: { status: "completed", output: [] },
      },
    ]);
  const title = new OpenAiSubscriptionModel({
    acquireAccessLease: async (signal) =>
      await titleProfile.acquireAccessLease(signal),
    renewAccessLease: async (rejected, signal) =>
      await titleProfile.renewAccessLease(rejected, signal),
    fetch: async () => completed(),
  });
  const agentAuthorizations: string[] = [];
  const agent = new OpenAiSubscriptionModel({
    acquireAccessLease: async (signal) =>
      await agentProfile.acquireAccessLease(signal),
    renewAccessLease: async (rejected, signal) =>
      await agentProfile.renewAccessLease(rejected, signal),
    fetch: async (_input, init) => {
      const authorization = new Headers(init?.headers).get("authorization")!;
      agentAuthorizations.push(authorization);
      return authorization === `Bearer ${rejectedAccessToken}`
        ? new Response(null, { status: 401 })
        : completed();
    },
  });

  try {
    await collect(title.stream(request({ model: "gpt-5.6-luna" })));
    await collect(agent.stream(request({ model: "gpt-5.6-terra" })));

    assert.equal(refreshes, 1);
    assert.deepEqual(agentAuthorizations, [
      `Bearer ${rejectedAccessToken}`,
      `Bearer ${refreshedAccessToken}`,
    ]);
    assert.equal(
      (await new SubscriptionCredentialStore(profilePath).read())?.access,
      refreshedAccessToken,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the hosted App Server renews a rejected subscription lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-host-auth-renewal-"));
  const profilePath = path.join(root, "openai-subscription-auth.json");
  const rejectedAccessToken = jwt(accountId, "host-rejected");
  const refreshedAccessToken = jwt(accountId, "host-renewed");
  await new SubscriptionCredentialStore(profilePath).modify(async () => ({
    type: "oauth",
    access: rejectedAccessToken,
    refresh: "host-refresh",
    expires: Date.now() + 3_600_000,
    accountId,
  }));
  const authorizations: string[] = [];
  let refreshes = 0;
  const providerFetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input).includes("/oauth/token")) {
      refreshes += 1;
      return Response.json({
        access_token: refreshedAccessToken,
        refresh_token: "host-renewed-refresh",
        expires_in: 3600,
      });
    }
    const authorization = new Headers(init?.headers).get("authorization")!;
    authorizations.push(authorization);
    return authorization === `Bearer ${rejectedAccessToken}`
      ? new Response(null, { status: 401 })
      : sseResponse([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "msg_host", content: [] },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            delta: "renewed",
          },
          {
            type: "response.completed",
            response: { status: "completed", output: [] },
          },
        ]);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = providerFetch;
  let host: ReturnType<typeof createHostedAppServer>;
  try {
    host = createHostedAppServer({
      cwd: root,
      dataDirectory: root,
      model: "gpt-5.6-terra",
      approvalPolicy: "never",
      provider: { type: "openai-subscription", profilePath },
      journal: new InMemoryThreadJournal(),
      threadMetadata: new InMemoryThreadMetadataStore(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  try {
    const thread = await host.startThread();
    const turn = await host.startTurn(thread.id, "hello");
    await turn.done;
    assert.equal(
      (await host.readThread(thread.id)).turns[0]?.status,
      "completed",
    );
    assert.equal(refreshes, 1);
    assert.deepEqual(authorizations, [
      `Bearer ${rejectedAccessToken}`,
      `Bearer ${refreshedAccessToken}`,
    ]);
  } finally {
    await host.closeProviderTransport();
    await rm(root, { recursive: true, force: true });
  }
});

test("redacts an access token if a provider error echoes it", async () => {
  const adapter = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({ accessToken: secretAccessToken }),
    fetch: async () =>
      sseResponse([
        {
          type: "error",
          code: "bad_request",
          message: `bad bearer ${secretAccessToken}`,
        },
      ]),
  });

  await assert.rejects(
    async () => await collect(adapter.stream(request())),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(secretAccessToken), false);
      assert.match(error.message, /\[redacted\]/u);
      return true;
    },
  );
});

test("rejects an incomplete response after transient partial text", async () => {
  const adapter = new OpenAiSubscriptionModel({
    acquireAccessLease: async () => ({ accessToken: secretAccessToken }),
    endpoint: "https://example.test/backend-api/codex/responses",
    fetch: async () =>
      sseResponse([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "message",
            id: "msg_partial",
            role: "assistant",
            content: [],
          },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          delta: "partial answer",
        },
        {
          type: "response.incomplete",
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [],
            usage: { input_tokens: 4, output_tokens: 2 },
          },
        },
      ]),
  });
  const events: ModelEvent[] = [];

  await assert.rejects(async () => {
    for await (const event of adapter.stream(request())) {
      events.push(event);
    }
  }, /response was incomplete: max_output_tokens/u);
  assert.deepEqual(events, [{ type: "text_delta", delta: "partial answer" }]);
});

test("browser PKCE login stores an independent mode-0600 profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-login-"));
  const profilePath = path.join(root, "openai-subscription-auth.json");
  let authorizationUrl: URL | undefined;
  let tokenBody: URLSearchParams | undefined;
  const profile = new OpenAiSubscriptionAuthProfile(profilePath, {
    fetch: async (_input, init) => {
      tokenBody = new URLSearchParams(String(init?.body));
      return Response.json({
        access_token: secretAccessToken,
        refresh_token: "zen-refresh",
        expires_in: 3600,
      });
    },
    tokenEndpoint: "https://example.test/oauth/token",
  });

  await profile.login({
    readManualCode: async () => "manual-authorization-code",
    notifyAuthUrl: (url) => {
      authorizationUrl = new URL(url);
    },
  });

  assert.equal(authorizationUrl?.origin, "https://auth.openai.com");
  assert.equal(authorizationUrl?.pathname, "/oauth/authorize");
  assert.equal(
    authorizationUrl?.searchParams.get("client_id"),
    "app_EMoamEEZ73f0CkXaXp7hrann",
  );
  assert.equal(
    authorizationUrl?.searchParams.get("code_challenge_method"),
    "S256",
  );
  assert.equal(authorizationUrl?.searchParams.get("originator"), "zen");
  assert.equal(tokenBody?.get("grant_type"), "authorization_code");
  assert.equal(tokenBody?.get("code"), "manual-authorization-code");
  assert.equal(tokenBody?.get("refresh_token"), null);
  const profileMetadata = await stat(profilePath);
  assert(profileMetadata.isFile());
  if (process.platform !== "win32") {
    assert.equal(profileMetadata.mode & 0o777, 0o600);
  }

  const stored = await readFile(profilePath, "utf8");
  assert.equal(stored.includes("zen-refresh"), true);
  assert.equal(stored.includes(".codex/auth.json"), false);
  assert.deepEqual(await profile.status(), {
    authenticated: true,
    expired: false,
    expiresAt: JSON.parse(stored).credential.expires as number,
    accountId,
  });

  if (process.platform !== "win32") {
    await chmod(profilePath, 0o644);
    await assert.rejects(
      profile.status(),
      /profile is readable by group or others/u,
    );
  }
});

test("serializes rotating refresh across independent profile instances", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-refresh-"));
  const profilePath = path.join(root, "openai-subscription-auth.json");
  const store = new SubscriptionCredentialStore(profilePath);
  const expired: OAuthCredential = {
    type: "oauth",
    access: jwt(accountId),
    refresh: "single-use-refresh",
    expires: 1,
    accountId,
  };
  await store.modify(async () => expired);

  let refreshes = 0;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "single-use-refresh");
    refreshes += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    return Response.json({
      access_token: secretAccessToken,
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    });
  };
  const first = new OpenAiSubscriptionAuthProfile(profilePath, {
    fetch,
    tokenEndpoint: "https://example.test/oauth/token",
  });
  const second = new OpenAiSubscriptionAuthProfile(profilePath, {
    fetch,
    tokenEndpoint: "https://example.test/oauth/token",
  });
  const signal = new AbortController().signal;

  const [left, right] = await Promise.all([
    first.acquireAccessLease(signal),
    second.acquireAccessLease(signal),
  ]);

  assert.equal(refreshes, 1);
  assert.equal(left.accessToken, secretAccessToken);
  assert.equal(right.accessToken, secretAccessToken);
  const profileMetadata = await stat(profilePath);
  assert(profileMetadata.isFile());
  if (process.platform !== "win32") {
    assert.equal(profileMetadata.mode & 0o777, 0o600);
  }
  const stored = await readFile(profilePath, "utf8");
  assert.equal(stored.includes("rotated-refresh"), true);
  assert.equal(stored.includes("single-use-refresh"), false);
});

test("serializes rejected-token renewal across independent profile instances", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-rejected-refresh-"));
  const profilePath = path.join(root, "openai-subscription-auth.json");
  const rejectedAccessToken = jwt(accountId, "rejected-concurrent");
  const refreshedAccessToken = jwt(accountId, "refreshed-concurrent");
  const store = new SubscriptionCredentialStore(profilePath);
  await store.modify(async () => ({
    type: "oauth",
    access: rejectedAccessToken,
    refresh: "single-use-rejected-refresh",
    expires: Date.now() + 3_600_000,
    accountId,
  }));
  let refreshes = 0;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("refresh_token"), "single-use-rejected-refresh");
    refreshes += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    return Response.json({
      access_token: refreshedAccessToken,
      refresh_token: "rotated-rejected-refresh",
      expires_in: 3600,
    });
  };
  const first = new OpenAiSubscriptionAuthProfile(profilePath, {
    fetch,
    tokenEndpoint: "https://example.test/oauth/token",
  });
  const second = new OpenAiSubscriptionAuthProfile(profilePath, {
    fetch,
    tokenEndpoint: "https://example.test/oauth/token",
  });
  const signal = new AbortController().signal;

  try {
    const [left, right] = await Promise.all([
      first.renewAccessLease(rejectedAccessToken, signal),
      second.renewAccessLease(rejectedAccessToken, signal),
    ]);
    assert.equal(refreshes, 1);
    assert.equal(left.accessToken, refreshedAccessToken);
    assert.equal(right.accessToken, refreshedAccessToken);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aborts promptly while another process owns the profile lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-lock-abort-"));
  const profilePath = path.join(root, "openai-subscription-auth.json");
  const lockPath = `${profilePath}.lock`;
  await mkdir(lockPath, { mode: 0o700 });
  const store = new SubscriptionCredentialStore(profilePath);
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("turn interrupted", "AbortError"));
  }, 25);

  try {
    await assert.rejects(
      store.modify(async () => {
        throw new Error("change must not run while the lock is held");
      }, controller.signal),
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError",
    );
    assert(Date.now() - startedAt < 500);
  } finally {
    clearTimeout(timer);
    await rm(root, { recursive: true, force: true });
  }
});

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    messages: [],
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

function shellTool(): ModelTool {
  return {
    name: "shell",
    description: "Run a command",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  };
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("expected a JSON request body");
  }
  const value: unknown = JSON.parse(body);
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}

function sseResponse(events: readonly Record<string, unknown>[]): Response {
  return new Response(
    `${events
      .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
      .join("")}data: [DONE]\r\n\r\n`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function jwt(id: string, marker = "default"): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", marker })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: id },
  })}.signature`;
}

async function collect(
  source: AsyncIterable<ModelEvent>,
): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}
