import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OpenAiSubscriptionAuthProfile,
  SubscriptionCredentialStore,
  type OAuthCredential,
  type SubscriptionSessionEvent,
} from "../apps/cli/src/subscription-auth.js";
import { OpenAiSubscriptionModel } from "../src/model/openai-subscription.js";
import { ModelDispatchRevokedError } from "../src/model/request-observation.js";
import { FileTraceStore } from "../src/trace.js";
import { observeModelWithTrace, closeModelTrace } from "../src/trace-model.js";
import type { ModelRequest } from "../src/model.js";
const jwt = (account: string, suffix = "initial") =>
  `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.${suffix}`;
const credential = (
  account = "synthetic-account",
  suffix = "initial",
): OAuthCredential => ({
  type: "oauth",
  access: jwt(account, suffix),
  refresh: "synthetic-refresh",
  expires: Date.now() + 3600000,
  accountId: account,
});
const terminal =
  'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n';
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "synthetic",
    reasoningEffort: "medium",
    messages: [{ role: "user", text: "synthetic input" }],
    tools: [],
    signal: new AbortController().signal,
    debugContext: {
      threadId: "thread",
      turnId: "turn",
      sampleId: "sample",
      purpose: "turn",
      sampleAttempt: 1,
      contextBoundaryItemId: "input",
    },
    ...overrides,
  };
}
async function consume(
  model: ReturnType<typeof observeModelWithTrace>,
  input = request(),
) {
  for await (const _event of model.stream(input)) {
  }
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-auth-synthetic-"));
  return { root, file: path.join(root, "auth.json") };
}
test("legacy files acquire one current session identity; independent profile objects observe replacement and logout", async () => {
  const { root, file } = await fixture();
  try {
    const value = credential();
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        provider: "openai-codex",
        credential: value,
      }),
      { mode: 0o600 },
    );
    const first = new OpenAiSubscriptionAuthProfile(file),
      second = new OpenAiSubscriptionAuthProfile(file),
      store = new SubscriptionCredentialStore(file);
    const left = await first.acquireAccessLease(new AbortController().signal),
      id = JSON.parse(await readFile(file, "utf8")).sessionId;
    assert.match(id, /^[a-f0-9-]{36}$/u);
    const right = await second.acquireAccessLease(new AbortController().signal);
    assert.equal(JSON.parse(await readFile(file, "utf8")).sessionId, id);
    await store.modify(async () => credential("synthetic-account", "refresh"));
    assert.equal(JSON.parse(await readFile(file, "utf8")).sessionId, id);
    left.assertDispatchAllowed!();
    right.assertDispatchAllowed!();
    await store.replace(value);
    assert.throws(left.assertDispatchAllowed!, /no longer current/u);
    assert.throws(right.assertDispatchAllowed!, /no longer current/u);
    const next = await second.acquireAccessLease(new AbortController().signal);
    await first.logout();
    await store.replace(value);
    assert.throws(next.assertDispatchAllowed!, /no longer current/u);
    const current = await first.acquireAccessLease(
      new AbortController().signal,
    );
    await store.modify(async () => credential("different-account"));
    assert.throws(current.assertDispatchAllowed!, /no longer current/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("actual fake OAuth login rotates identical account/token session, refresh preserves it, facts contain no credentials", async () => {
  const { root, file } = await fixture();
  const events: SubscriptionSessionEvent[] = [];
  try {
    const profile = new OpenAiSubscriptionAuthProfile(file, {
      tokenEndpoint: "https://synthetic.invalid/oauth/token",
      fetch: async () =>
        Response.json({
          access_token: jwt("same-account"),
          refresh_token: "synthetic-private-refresh",
          expires_in: 3600,
        }),
      onSessionEvent: (event) => {
        events.push(event);
      },
    });
    const login = () =>
      profile.login({
        notifyAuthUrl: () => {},
        readManualCode: async () => "synthetic-code",
      });
    await login();
    const id = JSON.parse(await readFile(file, "utf8")).sessionId,
      old = await profile.acquireAccessLease(new AbortController().signal);
    await profile.renewAccessLease(
      old.accessToken,
      new AbortController().signal,
    );
    assert.equal(JSON.parse(await readFile(file, "utf8")).sessionId, id);
    old.assertDispatchAllowed!();
    await login();
    assert.notEqual(JSON.parse(await readFile(file, "utf8")).sessionId, id);
    assert.throws(old.assertDispatchAllowed!, /no longer current/u);
    await profile.logout();
    assert.deepEqual(
      events.map((event) => event.type),
      ["login", "token_refreshed", "login", "logout"],
    );
    assert.ok(!JSON.stringify(events).includes(jwt("same-account")));
    assert.ok(!JSON.stringify(events).includes("synthetic-private-refresh"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
for (const mode of [
  "logout",
  "logout-login",
  "new-login",
  "same-account-refresh",
] as const)
  test(
    `real serialized retry respects ${mode}; token string is not session authority`,
    { timeout: 15000 },
    async () => {
      const { root, file } = await fixture(),
        started = gate(),
        resume = gate();
      const store = new SubscriptionCredentialStore(file),
        value = credential();
      await store.replace(value);
      const first = new OpenAiSubscriptionAuthProfile(file),
        second = new OpenAiSubscriptionAuthProfile(file),
        trace = new FileTraceStore(path.join(root, "trace"));
      let calls = 0;
      const authorizations: string[] = [];
      const model = observeModelWithTrace(
        new OpenAiSubscriptionModel({
          acquireAccessLease: (signal) => first.acquireAccessLease(signal),
          fetch: async (_url, init) => {
            calls++;
            authorizations.push(
              new Headers(init?.headers).get("authorization")!,
            );
            if (calls === 1) {
              started.resolve();
              await resume.promise;
              return new Response("actual first response", { status: 503 });
            }
            return new Response(terminal);
          },
        }),
        trace,
      );
      try {
        const pending = consume(model).then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error }),
        );
        await started.promise;
        if (mode === "logout" || mode === "logout-login") await second.logout();
        if (mode === "logout-login" || mode === "new-login")
          await new SubscriptionCredentialStore(file).replace(value);
        if (mode === "same-account-refresh")
          await new SubscriptionCredentialStore(file).modify(async () =>
            credential("synthetic-account", "rotated"),
          );
        resume.resolve();
        const result = await pending;
        if (mode === "same-account-refresh") {
          assert.equal(result.ok, true);
          assert.equal(calls, 2);
          assert.deepEqual(authorizations, [
            `Bearer ${value.access}`,
            `Bearer ${value.access}`,
          ]);
        } else {
          assert.equal(result.ok, false);
          if (result.ok) throw new Error("fixture");
          assert.ok(result.error instanceof ModelDispatchRevokedError);
          assert.equal(calls, 1);
        }
        await closeModelTrace(trace);
        await trace.flush();
        const reader = new FileTraceStore(trace.directory),
          records = (await reader.read("thread")).records;
        assert.equal(
          records.filter((r) => r.type === "model_request_dispatched").length,
          calls,
        );
        if (mode !== "same-account-refresh") {
          const blocked = records.find(
            (r) => r.type === "model_dispatch_blocked",
          );
          assert.equal((blocked?.data as any).reason, "auth_session_changed");
          assert.equal((blocked?.data as any).preparedRequestCaptured, false);
        }
        const bytes = await Promise.all(
          records
            .filter((r) => r.type === "model_response_chunk")
            .map((r) => reader.readArtifact(r.artifacts[0]!.ref)),
        );
        assert.match(
          Buffer.concat(bytes).toString(),
          /^actual first response/u,
        );
        assert.ok(!JSON.stringify(records).includes(value.access));
      } finally {
        resume.resolve();
        await closeModelTrace(trace);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
test("logout during acknowledged capture retains prepared bytes but never invokes Fetch", async () => {
  const { root, file } = await fixture();
  await new SubscriptionCredentialStore(file).replace(credential());
  const auth = new OpenAiSubscriptionAuthProfile(file),
    other = new OpenAiSubscriptionAuthProfile(file),
    trace = new FileTraceStore(path.join(root, "trace"));
  let calls = 0;
  try {
    const model = observeModelWithTrace(
      new OpenAiSubscriptionModel({
        acquireAccessLease: (signal) => auth.acquireAccessLease(signal),
        fetch: async () => {
          calls++;
          return new Response(terminal);
        },
      }),
      trace,
    );
    await assert.rejects(
      consume(
        model,
        request({
          onTransport: async (event) => {
            if (event.type === "request") await other.logout();
          },
        }),
      ),
      ModelDispatchRevokedError,
    );
    assert.equal(calls, 0);
    const records = (await trace.read("thread")).records;
    assert.equal(records.filter((r) => r.type === "model_request").length, 1);
    assert.equal(
      records.some((r) => r.type === "model_request_dispatched"),
      false,
    );
    assert.equal(
      (records.find((r) => r.type === "model_dispatch_blocked")?.data as any)
        .preparedRequestCaptured,
      true,
    );
  } finally {
    await closeModelTrace(trace);
    await rm(root, { recursive: true, force: true });
  }
});
test("failed observation or corrupt attribution metadata cannot preserve a logged-out credential", async () => {
  const { root, file } = await fixture();
  const original = console.error;
  console.error = () => {};
  try {
    await new SubscriptionCredentialStore(file).replace(credential());
    const auth = new OpenAiSubscriptionAuthProfile(file, {
      onSessionEvent: () => {
        throw new Error("synthetic observer failure");
      },
    });
    const lease = await auth.acquireAccessLease(new AbortController().signal);
    await auth.logout();
    assert.throws(lease.assertDispatchAllowed!, /no longer current/u);
    await assert.rejects(readFile(file), { code: "ENOENT" });
    await writeFile(file, "synthetic-secret-corrupt", { mode: 0o600 });
    assert.throws(
      lease.assertDispatchAllowed!,
      (error: Error) => !error.message.includes("synthetic-secret"),
    );
    await auth.logout();
    await assert.rejects(readFile(file), { code: "ENOENT" });
  } finally {
    console.error = original;
    await rm(root, { recursive: true, force: true });
  }
});
