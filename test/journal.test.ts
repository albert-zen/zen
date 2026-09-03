import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonlThreadJournal } from "../src/journal.js";

const createdAt = "2026-09-03T00:00:00.000Z";

test("JSONL read accepts every current and legacy canonical Item shape", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-journal-shapes-"),
  );
  const filename = path.join(directory, "thread.jsonl");
  const base = (id: string, type: string) => ({
    id,
    threadId: "thread",
    createdAt,
    type,
  });
  const selection = {
    providerProfileId: "provider",
    modelId: "model",
    reasoningEffort: "medium",
  };
  const items: unknown[] = [
    {
      ...base("metadata-legacy", "thread_metadata"),
      cwd: "/tmp",
      model: "model",
      provider: "provider",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    {
      ...base("metadata-current", "thread_metadata"),
      cwd: "/tmp",
      ...selection,
      sandbox: "danger-full-access",
      approvalPolicy: "always",
    },
    {
      ...base("configuration-legacy", "thread_configuration_changed"),
      model: { from: "model", to: "other" },
    },
    {
      ...base("configuration-current", "thread_configuration_changed"),
      selection: { from: selection, to: { ...selection, modelId: "other" } },
    },
    {
      ...base("compaction", "context_compaction"),
      coveredThroughItemId: "completed",
      summary: "summary",
      retainedItemIds: ["started", "completed"],
      ...selection,
      algorithmVersion: "v1",
      tokenUsage: { inputTokens: 1, outputTokens: 2 },
    },
    { ...base("started", "turn_started"), turnId: "turn", selection },
    {
      ...base("completed", "turn_completed"),
      turnId: "turn",
      status: "completed",
    },
    {
      ...base("aborted", "turn_aborted"),
      turnId: "turn",
      reason: "stopped",
    },
    {
      ...base("replacement-legacy", "turn_replacement_requested"),
      turnId: "turn",
      successorTurnId: "next",
      clientId: "client",
      text: "replace",
    },
    {
      ...base("replacement-current", "turn_replacement_requested"),
      turnId: "turn",
      successorTurnId: "next",
      clientId: "client-2",
      input: [{ type: "text", text: "replace" }],
    },
    {
      ...base("user-legacy", "user_message"),
      turnId: "turn",
      text: "hello",
    },
    {
      ...base("user-current", "user_message"),
      turnId: "turn",
      clientId: "client",
      deliveryAfter: "response",
      content: [
        { type: "text", text: "hello" },
        {
          type: "image",
          attachment: {
            type: "attachment",
            sha256: "a".repeat(64),
            mediaType: "image/png",
            byteLength: 68,
            width: 1,
            height: 1,
          },
        },
      ],
    },
    { ...base("agent", "agent_message"), turnId: "turn", text: "answer" },
    {
      ...base("usage", "model_usage"),
      turnId: "turn",
      modelResponseId: "response",
      inputTokens: 3,
      cachedInputTokens: 1,
      outputTokens: 4,
      reasoningOutputTokens: 2,
    },
    {
      ...base("reasoning-legacy", "reasoning"),
      turnId: "turn",
      summary: "summary",
    },
    {
      ...base("reasoning-current", "reasoning"),
      turnId: "turn",
      reasoningContent: "content",
      summary: "summary",
      contentVisibility: "public",
      providerItemId: "provider-item",
    },
    {
      ...base("call", "tool_call"),
      turnId: "turn",
      callId: "call",
      modelResponseId: "response",
      parentCallId: "parent",
      name: "shell",
      arguments: { command: "true" },
    },
    {
      ...base("result-legacy", "tool_result"),
      turnId: "turn",
      callId: "call",
      output: "legacy",
      exitCode: 7,
    },
    {
      ...base("result-current", "tool_result"),
      turnId: "turn",
      callId: "call-2",
      output: "current",
      exitCode: 0,
      executionStatus: "completed",
      contentType: "example/result",
      structuredContent: { ok: true },
    },
    {
      ...base("failure", "failure"),
      turnId: "turn",
      code: "provider_error",
      message: "failed",
    },
  ];

  try {
    await writeFile(
      filename,
      `${items.map((item) => JSON.stringify(item)).join("\n")}\n`,
    );
    assert.equal(
      (await new JsonlThreadJournal(directory).read("thread")).length,
      items.length,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL read rejects malformed canonical Item shapes with line context", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-journal-invalid-"),
  );
  const filename = path.join(directory, "thread.jsonl");
  const validBase = {
    id: "item",
    threadId: "thread",
    createdAt,
  };
  const invalidItems = [
    { ...validBase, type: "future_item" },
    {
      ...validBase,
      type: "thread_metadata",
      cwd: 42,
      model: "model",
      provider: "provider",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    {
      ...validBase,
      type: "thread_configuration_changed",
      selection: { from: { providerProfileId: "provider" }, to: {} },
    },
    {
      ...validBase,
      type: "turn_started",
      turnId: "turn",
      createdAt: "not-a-time",
    },
    {
      ...validBase,
      type: "model_usage",
      turnId: "turn",
      modelResponseId: "response",
      inputTokens: 1e400,
      outputTokens: 1,
    },
    {
      ...validBase,
      type: "user_message",
      turnId: "turn",
      content: [{ type: "image", attachment: { type: "attachment" } }],
    },
    {
      ...validBase,
      type: "tool_result",
      turnId: "turn",
      callId: "call",
      output: "bad status",
      exitCode: 0,
      executionStatus: "maybe",
    },
  ];

  try {
    for (const invalid of invalidItems) {
      await writeFile(filename, `${JSON.stringify(invalid)}\n`);
      await assert.rejects(
        new JsonlThreadJournal(directory).read("thread"),
        /Invalid canonical Item .* at line 1/u,
      );
    }
    await writeFile(
      filename,
      `{"id":"usage","threadId":"thread","createdAt":"${createdAt}","type":"model_usage","turnId":"turn","modelResponseId":"response","inputTokens":1e400,"outputTokens":1}\n`,
    );
    await assert.rejects(
      new JsonlThreadJournal(directory).read("thread"),
      /inputTokens must be a non-negative safe integer/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
