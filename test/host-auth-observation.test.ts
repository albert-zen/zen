import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHostedAppServer } from "../apps/cli/src/host.js";
import { FileTraceStore } from "../src/trace.js";

test("actual Host observes external session admission without copying credentials into Trace", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-auth-observation-"),
  );
  const profilePath = path.join(directory, "synthetic-auth.json");
  const originalFetch = globalThis.fetch;
  const access = `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.synthetic-signature`;
  await writeFile(
    profilePath,
    JSON.stringify({
      version: 1,
      provider: "openai-codex",
      credential: {
        type: "oauth",
        access,
        refresh: "synthetic-private-refresh",
        expires: Date.now() + 3600000,
        accountId: "synthetic-account",
      },
    }),
    { mode: 0o600 },
  );
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const host = createHostedAppServer({
    cwd: directory,
    dataDirectory: directory,
    provider: { type: "openai-subscription", profilePath },
    model: "synthetic",
    modelCatalog: [
      {
        id: "synthetic",
        isDefault: true,
        contextWindow: 32768,
        inputModalities: ["text"],
        supportedReasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
      },
    ],
    approvalPolicy: "never",
    toolPresentation: "direct",
  });
  try {
    const thread = await host.startThread();
    await (
      await host.startTurn(thread.id, "synthetic nonsecret input")
    ).done;
    assert.equal(calls, 1);
    assert.equal(
      (await host.readThread(thread.id)).turns.at(-1)?.status,
      "completed",
    );
    await host.closeHostResources();
    const trace = new FileTraceStore(path.join(directory, "trace"));
    const owners = (await trace.listThreadIds()).filter((id) =>
      id.startsWith("authentication-"),
    );
    assert.equal(owners.length, 1);
    const records = (await trace.read(owners[0]!)).records;
    assert.equal(records.length, 1);
    assert.equal(records[0]!.type, "authentication_session_observed");
    assert.equal(
      (records[0]!.data as { type: string }).type,
      "session_admitted",
    );
    assert.equal(JSON.stringify(records).includes(access), false);
    assert.equal(
      JSON.stringify(records).includes("synthetic-private-refresh"),
      false,
    );
    assert.equal(
      (await host.listThreads()).length,
      1,
      "observation owner never creates a hidden Thread",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await host.closeHostResources();
    await rm(directory, { recursive: true, force: true });
  }
});
