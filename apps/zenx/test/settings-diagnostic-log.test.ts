import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isRendererSettingsDiagnostic,
  SettingsDiagnosticLog,
  runDiagnosedProviderMutation,
} from "../src/main/settings-diagnostic-log.js";
import { BoundedLocalDiagnosticLog } from "../src/main/bounded-diagnostic-log.js";

const attemptId = "10e870b0-3264-46b4-8a9b-e079f08ad985";

test("renderer cannot submit a forged Host save outcome", () => {
  assert.equal(
    isRendererSettingsDiagnostic({ event: "provider-save-outcome" }),
    false,
  );
  assert.equal(
    isRendererSettingsDiagnostic({ event: "provider-save-reconciled" }),
    false,
  );
  assert.equal(
    isRendererSettingsDiagnostic({ event: "provider-validation-rejected" }),
    true,
  );
});

test("a rejected Provider mutation returns the same safe outcome and attempt as its Host log", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-settings-diagnostic-"),
  );
  try {
    const log = new SettingsDiagnosticLog(root);
    const failure = new Error(
      "secret-api-key https://private.example/model-id",
    );
    const reply = await runDiagnosedProviderMutation({
      log,
      operation: "edit",
      attemptId,
      knownRejectionCode: (error) =>
        error === failure ? "revision-conflict" : undefined,
      configurationStatus: async () => "applied",
      mutate: async () => {
        throw failure;
      },
    });
    assert.deepEqual(reply, {
      ok: false,
      outcome: "failed",
      code: "revision-conflict",
      attemptId,
    });
    const raw = await readFile(
      path.join(root, "diagnostics", "settings.jsonl"),
      "utf8",
    );
    assert.deepEqual(JSON.parse(raw.trim()), {
      timestamp: JSON.parse(raw.trim()).timestamp,
      event: "provider-save-outcome",
      attemptId,
      operation: "edit",
      outcome: reply.outcome,
    });
    assert.equal(JSON.stringify(reply).includes(failure.message), false);
    assert.equal(raw.includes(failure.message), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared diagnostic storage refuses one record larger than its file limit", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-settings-diagnostic-"),
  );
  try {
    const log = new BoundedLocalDiagnosticLog({
      userDataDirectory: root,
      fileName: "other.jsonl",
      maxBytes: 512,
      normalize: () => ({ value: "x".repeat(800) }),
    });
    assert.equal(await log.record({}), false);
    await assert.rejects(lstat(path.join(root, "diagnostics", "other.jsonl")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local validation failure is recorded with only allowlisted fields", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-settings-diagnostic-"),
  );
  try {
    const log = new SettingsDiagnosticLog(root);
    assert.equal(
      await log.record({
        event: "provider-validation-rejected",
        attemptId,
        operation: "edit",
        reason: "reasoning_default_invalid",
        modelIndex: 2,
        apiKey: "secret-api-key",
        providerProfileId: "sensitive-provider",
        modelId: "private-model",
        baseUrl: "https://private.example/path",
        message: "sensitive error text",
      }),
      true,
    );
    const directory = path.join(root, "diagnostics");
    const file = path.join(directory, "settings.jsonl");
    const raw = await readFile(file, "utf8");
    const record = JSON.parse(raw.trim());
    assert.deepEqual(Object.keys(record), [
      "timestamp",
      "event",
      "attemptId",
      "operation",
      "reason",
      "modelIndex",
    ]);
    assert.equal(record.reason, "reasoning_default_invalid");
    assert.equal(record.modelIndex, 2);
    for (const sensitive of [
      "secret-api-key",
      "sensitive-provider",
      "private-model",
      "private.example",
      "sensitive error text",
    ]) {
      assert.equal(raw.includes(sensitive), false);
    }
    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid reason and out-of-range row cannot be written", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-settings-diagnostic-"),
  );
  try {
    const log = new SettingsDiagnosticLog(root);
    for (const event of [
      {
        event: "provider-validation-rejected",
        attemptId,
        operation: "add",
        reason: "key=secret",
      },
      {
        event: "provider-validation-rejected",
        attemptId,
        operation: "add",
        reason: "model_id_missing",
        modelIndex: 1024,
      },
      {
        event: "provider-save-outcome",
        attemptId: "secret",
        operation: "edit",
        outcome: "failed",
      },
    ]) {
      assert.equal(await log.record(event), false);
    }
    await assert.rejects(
      lstat(path.join(root, "diagnostics", "settings.jsonl")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valid highest model row can be diagnosed", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-settings-diagnostic-"),
  );
  try {
    const log = new SettingsDiagnosticLog(root);
    assert.equal(
      await log.record({
        event: "provider-validation-rejected",
        attemptId,
        operation: "edit",
        reason: "reasoning_efforts_duplicate",
        modelIndex: 1023,
      }),
      true,
    );
    const raw = await readFile(
      path.join(root, "diagnostics", "settings.jsonl"),
      "utf8",
    );
    assert.equal(JSON.parse(raw.trim()).modelIndex, 1023);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnostic files rotate within a fixed budget", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-settings-diagnostic-"),
  );
  try {
    const log = new SettingsDiagnosticLog(root, { maxBytes: 600 });
    for (let index = 0; index < 30; index++) {
      assert.equal(
        await log.record({
          event: "provider-validation-rejected",
          attemptId,
          operation: "add",
          reason: "context_window_invalid",
          modelIndex: index,
        }),
        true,
      );
    }
    const directory = path.join(root, "diagnostics");
    const current = path.join(directory, "settings.jsonl");
    const prior = `${current}.1`;
    assert.ok((await stat(current)).size <= 600);
    assert.ok((await stat(prior)).size <= 600);
    for (const file of [current, prior]) {
      for (const line of (await readFile(file, "utf8")).trim().split("\n")) {
        assert.equal(JSON.parse(line).event, "provider-validation-rejected");
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host outcome distinguishes rejected, committed error, and unconfirmed saves", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-settings-diagnostic-"),
  );
  try {
    const log = new SettingsDiagnosticLog(root);
    let configurationStatus: string | undefined = "applied";
    const replies = [
      await runDiagnosedProviderMutation({
        log,
        operation: "add",
        attemptId,
        configurationStatus: async () => configurationStatus,
        mutate: async ({ markCommitted }) => {
          markCommitted();
          return "saved";
        },
      }),
    ];
    const failed = new Error("do not persist this error text");
    replies.push(
      await runDiagnosedProviderMutation({
        log,
        operation: "edit",
        attemptId,
        preflight: () => {
          throw failed;
        },
        configurationStatus: async () => configurationStatus,
        mutate: async () => "never reached",
      }),
    );
    replies.push(
      await runDiagnosedProviderMutation({
        log,
        operation: "edit",
        attemptId,
        configurationStatus: async () => configurationStatus,
        mutate: async () => {
          throw failed;
        },
      }),
    );
    replies.push(
      await runDiagnosedProviderMutation({
        log,
        operation: "edit",
        attemptId,
        knownRejectionCode: (error) =>
          error === failed ? "validation-rejected" : undefined,
        configurationStatus: async () => configurationStatus,
        mutate: async () => {
          throw failed;
        },
      }),
    );
    replies.push(
      await runDiagnosedProviderMutation({
        log,
        operation: "edit",
        attemptId,
        configurationStatus: async () => configurationStatus,
        mutate: async ({ markCommitted }) => {
          markCommitted();
          throw failed;
        },
      }),
    );
    configurationStatus = "unconfirmed";
    replies.push(
      await runDiagnosedProviderMutation({
        log,
        operation: "edit",
        attemptId,
        configurationStatus: async () => configurationStatus,
        mutate: async ({ markCommitted }) => {
          markCommitted();
          throw failed;
        },
      }),
    );
    replies.push(
      await runDiagnosedProviderMutation({
        log,
        operation: "edit",
        attemptId,
        configurationStatus: async () => configurationStatus,
        mutate: async () => "saved but application unconfirmed",
      }),
    );
    assert.deepEqual(replies, [
      { ok: true, settings: "saved", outcome: "success", attemptId },
      { ok: false, outcome: "failed", code: "save-rejected", attemptId },
      {
        ok: false,
        outcome: "unconfirmed",
        code: "save-unconfirmed",
        attemptId,
      },
      {
        ok: false,
        outcome: "failed",
        code: "validation-rejected",
        attemptId,
      },
      {
        ok: false,
        outcome: "committed-error",
        code: "save-finalization-failed",
        attemptId,
      },
      {
        ok: false,
        outcome: "committed-error",
        code: "save-finalization-failed",
        attemptId,
      },
      {
        ok: true,
        settings: "saved but application unconfirmed",
        outcome: "unconfirmed",
        attemptId,
      },
    ]);
    const raw = await readFile(
      path.join(root, "diagnostics", "settings.jsonl"),
      "utf8",
    );
    assert.deepEqual(
      raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).outcome),
      [
        "success",
        "failed",
        "unconfirmed",
        "failed",
        "committed-error",
        "committed-error",
        "unconfirmed",
      ],
    );
    assert.deepEqual(
      raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).outcome),
      replies.map((reply) => reply.outcome),
    );
    assert.ok(
      raw
        .trim()
        .split("\n")
        .every((line) => JSON.parse(line).attemptId === attemptId),
    );
    assert.equal(raw.includes(failed.message), false);
    assert.equal(JSON.stringify(replies).includes(failed.message), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnostic write failure never changes a save result", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-settings-diagnostic-"),
  );
  try {
    const occupiedPath = path.join(root, "occupied");
    await writeFile(occupiedPath, "file blocks directory creation");
    const log = new SettingsDiagnosticLog(occupiedPath);
    // The mutation result must win even when the diagnostic sink is unusable.
    assert.deepEqual(
      await runDiagnosedProviderMutation({
        log,
        operation: "add",
        attemptId,
        configurationStatus: async () => "applied",
        mutate: async ({ markCommitted }) => {
          markCommitted();
          return 42;
        },
      }),
      { ok: true, settings: 42, outcome: "success", attemptId },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
