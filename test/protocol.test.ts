import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { png1x1, shellPrintCommand } from "./fixtures.js";

import { createHostedAppServer } from "../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../src/journal.js";
import {
  CodexClient,
  CodexClientError,
  responseResult,
} from "../src/protocol/codex/client.js";
import { CodexConnection } from "../src/protocol/codex/connection.js";
import { encodeModelKey } from "../src/protocol/codex/model-key.js";
import { serveCodexWebSocket } from "../src/protocol/codex/websocket.js";
import { InMemoryThreadMetadataStore } from "../src/thread-metadata.js";
import { isRecord, type JsonRpcMessage } from "../src/protocol/codex/wire.js";

function testHost(
  approvalPolicy: "always" | "never" = "never",
  models: readonly string[] = ["fake"],
) {
  return createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: path.join(os.tmpdir(), "unused-zen-test-data"),
    model: models[0] ?? "fake",
    models,
    approvalPolicy,
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
    threadMetadata: new InMemoryThreadMetadataStore(),
  });
}

test("imports Codex localImage and image inputs before canonical turn/start", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-protocol-image-"));
  const localPath = path.join(root, "ephemeral-local.png");
  await writeFile(localPath, png1x1());
  const appServer = createHostedAppServer({
    cwd: root,
    dataDirectory: root,
    model: "fake-image",
    modelCatalog: [
      {
        id: "fake-image",
        isDefault: true,
        supportedReasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
        inputModalities: ["text", "image"],
        source: "manual",
      },
    ],
    approvalPolicy: "never",
    provider: { type: "fake" },
  });
  const messages: JsonRpcMessage[] = [];
  let turnCompleted = deferred<void>();
  const connection = new CodexConnection({
    appServer,
    zenHome: path.join(root, "home"),
    send: (message) => {
      messages.push(message);
      if ("method" in message && message.method === "turn/completed") {
        turnCompleted.resolve();
      }
    },
  });
  try {
    await connection.receive({ id: 1, method: "initialize", params: {} });
    await connection.receive({ method: "initialized" });
    await connection.receive({ id: 2, method: "thread/start", params: {} });
    const started = messages.find(
      (message) => "result" in message && String(message.id) === "2",
    );
    assert(
      started !== undefined && "result" in started && isRecord(started.result),
    );
    const thread = responseResult<Record<string, unknown>>(
      started.result,
      "thread",
    );
    await connection.receive({
      id: 3,
      method: "turn/start",
      params: {
        threadId: thread.id,
        input: [{ type: "image", url: "https://example.test/image.png" }],
      },
    });
    const remoteImageFailure = messages.find(
      (message) => "error" in message && String(message.id) === "3",
    );
    assert(remoteImageFailure !== undefined && "error" in remoteImageFailure);
    assert(
      isRecord(remoteImageFailure.error.data) &&
        remoteImageFailure.error.data.zenCode === "attachment_invalid",
    );
    assert.deepEqual(
      (await appServer.readThread(String(thread.id))).items.map(
        (item) => item.type,
      ),
      ["thread_metadata"],
    );
    await connection.receive({
      id: 4,
      method: "turn/start",
      params: {
        threadId: thread.id,
        input: [
          { type: "text", text: "local" },
          { type: "localImage", path: localPath },
        ],
      },
    });
    await within(turnCompleted.promise);

    const firstSnapshot = await appServer.readThread(String(thread.id));
    const retainedRef = firstSnapshot.items
      .filter((item) => item.type === "user_message")
      .flatMap((item) => item.content ?? [])
      .find((part) => part.type === "image");
    assert(retainedRef?.type === "image");

    turnCompleted = deferred<void>();
    await connection.receive({
      id: 5,
      method: "turn/start",
      params: {
        threadId: thread.id,
        input: [
          {
            type: "image",
            url: `data:image/png;base64,${Buffer.from(png1x1()).toString("base64")}`,
          },
        ],
      },
    });
    await within(turnCompleted.promise);

    turnCompleted = deferred<void>();
    await connection.receive({
      id: 6,
      method: "turn/start",
      params: {
        threadId: thread.id,
        input: [{ type: "attachment", attachment: retainedRef.attachment }],
      },
    });
    await within(turnCompleted.promise);

    const snapshot = await appServer.readThread(String(thread.id));
    const canonicalMessages = snapshot.items.filter(
      (item) => item.type === "user_message",
    );
    assert.equal(canonicalMessages.length, 3);
    assert(
      canonicalMessages.every((item) =>
        item.content?.some((part) => part.type === "image"),
      ),
    );
    const attachmentDirectories = await readdir(
      path.join(root, "attachments", "sha256"),
    );
    assert.equal(attachmentDirectories.length, 1);
    const journal = await readFile(
      path.join(root, "threads", `${String(thread.id)}.jsonl`),
      "utf8",
    );
    assert.equal(journal.includes(localPath), false);
    assert.equal(journal.includes("base64"), false);
  } finally {
    connection.close();
    await appServer.closeProviderTransport();
    await rm(root, { recursive: true, force: true });
  }
});

test("enforces the Codex initialize handshake and method boundary", async () => {
  const messages: JsonRpcMessage[] = [];
  const connection = new CodexConnection({
    appServer: testHost(),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    send: (message) => {
      messages.push(message);
    },
  });

  await connection.receive({ id: 1, method: "thread/list", params: {} });
  assert.deepEqual(messages.pop(), {
    id: 1,
    error: { code: -32600, message: "Not initialized" },
  });

  await connection.receive({
    id: 2,
    method: "initialize",
    params: {
      clientInfo: { name: "test", title: "Test", version: "1" },
      capabilities: null,
    },
  });
  const initialized = messages.pop();
  assert(
    initialized !== undefined &&
      "result" in initialized &&
      typeof initialized.result === "object",
  );

  await connection.receive({ id: 3, method: "initialize", params: {} });
  assert.deepEqual(messages.pop(), {
    id: 3,
    error: { code: -32600, message: "Already initialized" },
  });

  await connection.receive({ method: "initialized" });
  await connection.receive({ id: 4, method: "not/a-method", params: {} });
  assert.deepEqual(messages.pop(), {
    id: 4,
    error: { code: -32601, message: "Method not found: not/a-method" },
  });
  connection.close();
});

test("projects the exact T3 Code provider bootstrap from host configuration", async () => {
  const messages: JsonRpcMessage[] = [];
  const connection = new CodexConnection({
    appServer: testHost("never", ["gpt-5.6-terra", "gpt-5.6-sol"]),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    send: (message) => {
      messages.push(message);
    },
  });

  await connection.receive({ id: 1, method: "initialize", params: {} });
  messages.pop();
  await connection.receive({ method: "initialized" });

  await connection.receive({ id: 2, method: "account/read", params: {} });
  assert.deepEqual(messages.pop(), {
    id: 2,
    result: { account: null, requiresOpenaiAuth: false },
  });

  const cwds = [process.cwd(), path.join(os.tmpdir(), "second-workspace")];
  await connection.receive({
    id: 3,
    method: "skills/list",
    params: { cwds },
  });
  assert.deepEqual(messages.pop(), {
    id: 3,
    result: {
      data: cwds.map((cwd) => ({ cwd, skills: [], errors: [] })),
    },
  });

  await connection.receive({ id: 4, method: "model/list", params: {} });
  assert.deepEqual(messages.pop(), {
    id: 4,
    result: {
      data: [
        {
          id: wireModel("gpt-5.6-terra"),
          model: wireModel("gpt-5.6-terra"),
          upgrade: null,
          upgradeInfo: null,
          availabilityNux: null,
          displayName: "gpt-5.6-terra",
          description: "Model configured by the Zen host",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "medium" },
          ],
          defaultReasoningEffort: "medium",
          inputModalities: ["text"],
          supportsPersonality: false,
          additionalSpeedTiers: [],
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: true,
        },
        {
          id: wireModel("gpt-5.6-sol"),
          model: wireModel("gpt-5.6-sol"),
          upgrade: null,
          upgradeInfo: null,
          availabilityNux: null,
          displayName: "gpt-5.6-sol",
          description: "Model configured by the Zen host",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "medium" },
          ],
          defaultReasoningEffort: "medium",
          inputModalities: ["text"],
          supportsPersonality: false,
          additionalSpeedTiers: [],
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: false,
        },
      ],
      nextCursor: null,
    },
  });
  connection.close();
});

test("switches models canonically and synchronizes thread settings", async () => {
  const appServer = testHost("never", ["fake", "other"]);
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const initiating = await CodexClient.connect(server.url);
  const observing = await CodexClient.connect(server.url);
  try {
    await initiating.initialize({
      name: "initiating",
      title: "Initiating",
      version: "1",
    });
    await observing.initialize({
      name: "observing",
      title: "Observing",
      version: "1",
    });
    const started = await initiating.request("thread/start", {
      model: "fake",
      cwd: process.cwd(),
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
    const thread = responseResult<Record<string, unknown>>(started, "thread");
    if (typeof thread.id !== "string") {
      throw new Error("thread/start omitted id");
    }
    await observing.request("thread/resume", { threadId: thread.id });

    const updated = deferred<Record<string, unknown>>();
    initiating.onNotification("thread/settings/updated", (params) => {
      if (isRecord(params)) {
        updated.resolve(params);
      }
    });
    const response = await initiating.request("thread/settings/update", {
      threadId: thread.id,
      model: "other",
    });
    assert.deepEqual(response, {});
    const notification = await within(updated.promise);
    assert.equal(notification.threadId, thread.id);
    assert(
      isRecord(notification.threadSettings) &&
        notification.threadSettings.model === wireModel("other"),
    );

    const snapshot = await appServer.readThread(thread.id);
    assert.equal(snapshot.model, "other");
    assert.equal(
      snapshot.items.filter(
        (item) => item.type === "thread_configuration_changed",
      ).length,
      1,
    );

    const completed = deferred<void>();
    initiating.onNotification("turn/completed", () => {
      completed.resolve();
    });
    await initiating.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "switch back" }],
      model: "fake",
    });
    await within(completed.promise);
    const afterTurn = await appServer.readThread(thread.id);
    assert.equal(afterTurn.model, "fake");
    assert.equal(
      afterTurn.items.filter(
        (item) => item.type === "thread_configuration_changed",
      ).length,
      2,
    );

    const rapidModels: string[] = [];
    const rapidUpdates = deferred<void>();
    initiating.onNotification("thread/settings/updated", (params) => {
      if (
        isRecord(params) &&
        isRecord(params.threadSettings) &&
        typeof params.threadSettings.model === "string"
      ) {
        rapidModels.push(params.threadSettings.model);
        if (rapidModels.length === 2) {
          rapidUpdates.resolve();
        }
      }
    });
    await Promise.all([
      appServer.updateThreadSettings(String(thread.id), { model: "other" }),
      appServer.updateThreadSettings(String(thread.id), { model: "fake" }),
    ]);
    await within(rapidUpdates.promise);
    assert.deepEqual(rapidModels, [wireModel("other"), wireModel("fake")]);
  } finally {
    initiating.close();
    observing.close();
    await server.close();
  }
});

test("exposes manual context compaction only as the thread/compact Zen extension", async () => {
  const appServer = testHost();
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    await client.initialize({
      name: "compact",
      title: "Compact",
      version: "1",
    });
    const started = await client.request("thread/start", {});
    const thread = responseResult<Record<string, unknown>>(started, "thread");
    assert.equal(typeof thread.id, "string");
    const threadId = String(thread.id);
    const completed = deferred<void>();
    client.onNotification("turn/completed", () => completed.resolve());
    await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "history to compact" }],
    });
    await within(completed.promise);

    const result = await client.request("thread/compact", { threadId });
    assert(isRecord(result));
    assert.deepEqual(Object.keys(result), ["compactionItemId"]);
    assert.equal(typeof result.compactionItemId, "string");
    const snapshot = await appServer.readThread(threadId);
    assert.equal(snapshot.items.at(-1)?.id, result.compactionItemId);
    assert.equal(snapshot.items.at(-1)?.type, "context_compaction");

    const read = await client.request("thread/read", {
      threadId,
      includeTurns: true,
    });
    const projected = responseResult<Record<string, unknown>>(read, "thread");
    assert(Array.isArray(projected.turns));
    assert.equal(projected.turns.length, 1);
    assert.equal(
      JSON.stringify(projected.turns).includes("context_compaction"),
      false,
    );

    await assert.rejects(
      client.request("thread/compact", {
        threadId,
        coveredThroughItemId: "not-callable",
      }),
      (error: unknown) => {
        assert(error instanceof CodexClientError);
        assert.equal(error.code, -32602);
        return true;
      },
    );
  } finally {
    client.close();
    await server.close();
  }
});

test("resumes an active thread and applies an explicit model change next", async () => {
  const appServer = testHost("always", ["fake", "other"]);
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const running = await CodexClient.connect(server.url);
  const resuming = await CodexClient.connect(server.url);
  const approvalSeen = deferred<void>();
  const releaseApproval = deferred<{ decision: "decline" }>();
  try {
    await running.initialize({
      name: "imzen",
      title: "IMZen",
      version: "1",
    });
    await resuming.initialize({
      name: "t3code_desktop",
      title: "T3 Code Desktop",
      version: "0.0.31",
    });
    running.onServerRequest(
      "item/commandExecution/requestApproval",
      async () => {
        approvalSeen.resolve();
        return await releaseApproval.promise;
      },
    );
    const started = await running.request("thread/start", {
      cwd: process.cwd(),
      model: "fake",
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
    const thread = responseResult<Record<string, unknown>>(started, "thread");
    const turn = await running.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "!shell printf active" }],
      model: "fake",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "dangerFullAccess" },
      approvalsReviewer: "user",
    });
    await within(approvalSeen.promise);

    const resumed = await resuming.request("thread/resume", {
      threadId: thread.id,
      cwd: process.cwd(),
      model: "fake",
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
    assert.equal(
      responseResult<Record<string, unknown>>(resumed, "thread").id,
      thread.id,
    );
    assert.equal((await appServer.readThread(String(thread.id))).model, "fake");

    await resuming.request("thread/resume", {
      threadId: thread.id,
      model: "other",
    });
    assert.equal(
      (await appServer.readThread(String(thread.id))).model,
      "other",
    );

    const completed = deferred<void>();
    running.onNotification("turn/completed", () => {
      completed.resolve();
    });
    releaseApproval.resolve({ decision: "decline" });
    await within(completed.promise);
    assert(isRecord(turn) && isRecord(turn.turn));
  } finally {
    running.close();
    resuming.close();
    await server.close();
  }
});

test("dispatches Codex turn/steer to the same active Turn for every subscriber", async () => {
  const appServer = testHost("always");
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const initiating = await CodexClient.connect(server.url);
  const steering = await CodexClient.connect(server.url);
  const approvalSeen = deferred<void>();
  const releaseApproval = deferred<{ decision: "decline" }>();
  const turnCompleted = deferred<void>();
  try {
    await initiating.initialize({
      name: "initiating",
      title: "Initiating",
      version: "1",
    });
    await steering.initialize({
      name: "steering",
      title: "Steering",
      version: "1",
    });
    initiating.onServerRequest(
      "item/commandExecution/requestApproval",
      async () => {
        approvalSeen.resolve();
        return await releaseApproval.promise;
      },
    );
    initiating.onNotification("turn/completed", () => {
      turnCompleted.resolve();
    });
    const started = await initiating.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(started, "thread");
    await steering.request("thread/resume", { threadId: thread.id });
    const turnStart = await initiating.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "!shell printf active" }],
    });
    const turn = responseResult<Record<string, unknown>>(turnStart, "turn");
    await within(approvalSeen.promise);

    const observedByInitiator = deferred<Record<string, unknown>>();
    const observedBySteerer = deferred<Record<string, unknown>>();
    const observeSteer =
      (target: ReturnType<typeof deferred<Record<string, unknown>>>) =>
      (params: unknown): void => {
        if (
          isRecord(params) &&
          isRecord(params.item) &&
          params.item.type === "userMessage" &&
          params.item.clientId === "steer-protocol-id"
        ) {
          target.resolve(params);
        }
      };
    initiating.onNotification(
      "item/completed",
      observeSteer(observedByInitiator),
    );
    steering.onNotification("item/completed", observeSteer(observedBySteerer));

    assert.deepEqual(
      await steering.request("turn/steer", {
        threadId: thread.id,
        expectedTurnId: turn.id,
        input: [{ type: "text", text: "change direction" }],
        clientUserMessageId: "steer-protocol-id",
      }),
      { turnId: turn.id },
    );
    const observations = await within(
      Promise.all([observedByInitiator.promise, observedBySteerer.promise]),
    );
    for (const observation of observations) {
      assert.equal(observation.threadId, thread.id);
      assert.equal(observation.turnId, turn.id);
    }

    await assert.rejects(
      steering.request("turn/steer", {
        threadId: thread.id,
        expectedTurnId: "stale-turn",
        input: [{ type: "text", text: "must fail" }],
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32000,
    );
    releaseApproval.resolve({ decision: "decline" });
    await within(turnCompleted.promise);
  } finally {
    initiating.close();
    steering.close();
    await server.close();
  }
});

test("turn/replace atomically interrupts the fenced Turn before starting its successor", async () => {
  const appServer = testHost("always");
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const initiating = await CodexClient.connect(server.url);
  const replacing = await CodexClient.connect(server.url);
  const approvalSeen = deferred<void>();
  const releaseOldApproval = deferred<{ decision: "decline" }>();
  const approvalResolved = deferred<void>();
  const replacementCompleted = deferred<void>();
  const observed: Array<{ method: string; params: unknown }> = [];
  try {
    await initiating.initialize({
      name: "initiating",
      title: "Initiating",
      version: "1",
    });
    await replacing.initialize({
      name: "replacing",
      title: "Replacing",
      version: "1",
    });
    initiating.onServerRequest(
      "item/commandExecution/requestApproval",
      async () => {
        approvalSeen.resolve();
        return await releaseOldApproval.promise;
      },
    );
    initiating.onNotification("serverRequest/resolved", () => {
      approvalResolved.resolve();
    });
    for (const method of ["turn/completed", "turn/started", "item/completed"]) {
      replacing.onNotification(method, (params) => {
        observed.push({ method, params });
        if (
          method === "turn/completed" &&
          isRecord(params) &&
          isRecord(params.turn) &&
          params.turn.status === "completed"
        ) {
          replacementCompleted.resolve();
        }
      });
    }

    const started = await initiating.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(started, "thread");
    await replacing.request("thread/resume", { threadId: thread.id });
    const turnStart = await initiating.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "!shell printf old" }],
    });
    const oldTurn = responseResult<Record<string, unknown>>(turnStart, "turn");
    await within(approvalSeen.promise);

    const response = await replacing.request("turn/replace", {
      threadId: thread.id,
      expectedTurnId: oldTurn.id,
      input: [{ type: "text", text: "replacement request" }],
      clientUserMessageId: "replace-protocol-id",
    });
    assert(isRecord(response));
    assert.equal(response.interruptedTurnId, oldTurn.id);
    assert.equal(typeof response.turnId, "string");
    assert.notEqual(response.turnId, oldTurn.id);
    await within(approvalResolved.promise);
    await within(replacementCompleted.promise);
    releaseOldApproval.resolve({ decision: "decline" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const oldCompletedIndex = observed.findIndex(
      ({ method, params }) =>
        method === "turn/completed" &&
        isRecord(params) &&
        isRecord(params.turn) &&
        params.turn.id === oldTurn.id &&
        params.turn.status === "interrupted",
    );
    const newStartedIndex = observed.findIndex(
      ({ method, params }) =>
        method === "turn/started" &&
        isRecord(params) &&
        isRecord(params.turn) &&
        params.turn.id === response.turnId,
    );
    const replacementInputIndex = observed.findIndex(
      ({ method, params }) =>
        method === "item/completed" &&
        isRecord(params) &&
        isRecord(params.item) &&
        params.item.type === "userMessage" &&
        params.item.clientId === "replace-protocol-id",
    );
    assert(oldCompletedIndex >= 0);
    assert(newStartedIndex > oldCompletedIndex);
    assert(replacementInputIndex > newStartedIndex);
  } finally {
    releaseOldApproval.resolve({ decision: "decline" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    initiating.close();
    replacing.close();
    await server.close();
  }
});

test("synchronizes ZAS-owned thread names without adding Agent items", async () => {
  const appServer = testHost();
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const initiating = await CodexClient.connect(server.url);
  const observing = await CodexClient.connect(server.url);
  try {
    await initiating.initialize({
      name: "initiating",
      title: "Initiating",
      version: "1",
    });
    await observing.initialize({
      name: "observing",
      title: "Observing",
      version: "1",
    });
    const started = await initiating.request("thread/start", {});
    const thread = responseResult<Record<string, unknown>>(started, "thread");
    if (typeof thread.id !== "string") {
      throw new Error("thread/start omitted id");
    }
    await observing.request("thread/resume", { threadId: thread.id });

    const renamed = deferred<Record<string, unknown>>();
    observing.onNotification("thread/name/updated", (params) => {
      if (isRecord(params)) {
        renamed.resolve(params);
      }
    });
    await initiating.request("thread/name/set", {
      threadId: thread.id,
      name: "Shared title",
    });
    assert.deepEqual(await within(renamed.promise), {
      threadId: thread.id,
      threadName: "Shared title",
    });

    for (const [method, params] of [
      ["thread/read", { threadId: thread.id }],
      ["thread/resume", { threadId: thread.id }],
      ["thread/list", {}],
    ] as const) {
      const result = await observing.request(method, params);
      if (method === "thread/list") {
        assert(isRecord(result) && Array.isArray(result.data));
        const first = result.data[0];
        assert(isRecord(first));
        assert.equal(first.name, "Shared title");
      } else {
        assert.equal(
          responseResult<Record<string, unknown>>(result, "thread").name,
          "Shared title",
        );
      }
    }
    assert.equal(
      (await appServer.readThread(thread.id)).items.some(
        (item) => "name" in item,
      ),
      false,
    );
  } finally {
    initiating.close();
    observing.close();
    await server.close();
  }
});

test("archives Threads through the fixed Codex lifecycle and filters lists", async () => {
  const appServer = testHost();
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const initiating = await CodexClient.connect(server.url);
  const observing = await CodexClient.connect(server.url);
  try {
    await initiating.initialize({
      name: "initiating",
      title: "Initiating",
      version: "1",
    });
    await observing.initialize({
      name: "observing",
      title: "Observing",
      version: "1",
    });
    const started = await initiating.request("thread/start", {});
    const thread = responseResult<Record<string, unknown>>(started, "thread");
    assert.equal(typeof thread.id, "string");
    const threadId = thread.id as string;

    const archived = deferred<Record<string, unknown>>();
    const unarchived = deferred<Record<string, unknown>>();
    observing.onNotification("thread/archived", (params) => {
      if (isRecord(params)) archived.resolve(params);
    });
    observing.onNotification("thread/unarchived", (params) => {
      if (isRecord(params)) unarchived.resolve(params);
    });

    assert.deepEqual(
      await initiating.request("thread/archive", { threadId }),
      {},
    );
    assert.deepEqual(await within(archived.promise), { threadId });
    const activeList = await initiating.request("thread/list", {});
    assert(isRecord(activeList) && Array.isArray(activeList.data));
    assert.equal(activeList.data.length, 0);
    const archivedList = await initiating.request("thread/list", {
      archived: true,
    });
    assert(isRecord(archivedList) && Array.isArray(archivedList.data));
    assert.equal(archivedList.data.length, 1);
    await assert.rejects(
      initiating.request("thread/list", { archived: "yes" }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );
    assert.equal(
      responseResult<Record<string, unknown>>(
        await initiating.request("thread/read", { threadId }),
        "thread",
      ).id,
      threadId,
    );

    const restored = await initiating.request("thread/unarchive", {
      threadId,
    });
    assert.equal(
      responseResult<Record<string, unknown>>(restored, "thread").id,
      threadId,
    );
    assert.deepEqual(await within(unarchived.promise), { threadId });
    const restoredList = await initiating.request("thread/list", {});
    assert(isRecord(restoredList) && Array.isArray(restoredList.data));
    assert.equal(restoredList.data.length, 1);
    assert.equal(
      (await appServer.readThread(threadId)).items.some(
        (item) => "archived" in item,
      ),
      false,
    );

    await assert.rejects(
      initiating.request("thread/archive", { threadId: "missing" }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32000,
    );
  } finally {
    initiating.close();
    observing.close();
    await server.close();
  }
});

test("paginates active and archived Thread lists with filter-bound cursors", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost(),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    await client.initialize({
      name: "pagination",
      title: "Pagination",
      version: "1",
    });
    const threadIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const result = await client.request("thread/start", {});
      const thread = responseResult<Record<string, unknown>>(result, "thread");
      assert.equal(typeof thread.id, "string");
      threadIds.push(thread.id as string);
    }
    const archivedIds = [threadIds[1]!, threadIds[3]!].sort();
    const activeIds = [threadIds[0]!, threadIds[2]!].sort();
    for (const threadId of archivedIds) {
      await client.request("thread/archive", { threadId });
    }

    const firstActive = await threadListPage(client, { limit: 1 });
    assert.deepEqual(firstActive.ids, activeIds.slice(0, 1));
    assert.equal(typeof firstActive.nextCursor, "string");
    assert.equal(firstActive.backwardsCursor, null);
    const secondActive = await threadListPage(client, {
      cursor: firstActive.nextCursor,
    });
    assert.deepEqual(secondActive.ids, activeIds.slice(1));
    assert.equal(secondActive.nextCursor, null);
    assert.equal(secondActive.backwardsCursor, null);

    const firstArchived = await threadListPage(client, {
      archived: true,
      limit: 1,
    });
    assert.deepEqual(firstArchived.ids, archivedIds.slice(0, 1));
    assert.equal(typeof firstArchived.nextCursor, "string");
    const secondArchived = await threadListPage(client, {
      archived: true,
      limit: 10,
      cursor: firstArchived.nextCursor,
    });
    assert.deepEqual(secondArchived.ids, archivedIds.slice(1));
    assert.equal(secondArchived.nextCursor, null);

    await assert.rejects(
      client.request("thread/list", {
        archived: false,
        limit: 1,
        cursor: firstArchived.nextCursor,
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );
    await assert.rejects(
      client.request("thread/list", {
        archived: true,
        limit: 1,
        cursor: "not-a-valid-cursor",
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );
    await assert.rejects(
      client.request("thread/list", {
        limit: 1,
        sortDirection: "desc",
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );

    const archivedRead = await client.request("thread/read", {
      threadId: archivedIds[0],
    });
    assert.equal(
      responseResult<Record<string, unknown>>(archivedRead, "thread").id,
      archivedIds[0],
    );
    const archivedResume = await client.request("thread/resume", {
      threadId: archivedIds[0],
    });
    assert.equal(
      responseResult<Record<string, unknown>>(archivedResume, "thread").id,
      archivedIds[0],
    );

    const beforeSnapshotChange = await threadListPage(client, { limit: 1 });
    assert.equal(typeof beforeSnapshotChange.nextCursor, "string");
    await client.request("thread/start", {});
    await assert.rejects(
      client.request("thread/list", {
        cursor: beforeSnapshotChange.nextCursor,
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );
  } finally {
    client.close();
    await server.close();
  }
});

test("streams the minimal Codex Thread/Turn/Item lifecycle over WebSocket", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost(),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    const notifications: string[] = [];
    const completed = deferred<void>();
    for (const method of [
      "thread/started",
      "turn/started",
      "item/started",
      "item/agentMessage/delta",
      "item/completed",
      "thread/tokenUsage/updated",
      "turn/completed",
    ]) {
      client.onNotification(method, () => {
        notifications.push(method);
        if (method === "turn/completed") {
          completed.resolve();
        }
      });
    }

    await client.initialize({
      name: "test",
      title: "Test",
      version: "0.1.0",
    });
    const start = await client.request("thread/start", {
      cwd: process.cwd(),
      model: "fake",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");
    assert.equal(typeof thread.id, "string");

    const turnStart = await client.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "hello", text_elements: [] }],
    });
    const turn = responseResult<Record<string, unknown>>(turnStart, "turn");
    assert.equal(turn.status, "inProgress");
    await completed.promise;

    assert(notifications.includes("thread/started"));
    assert(notifications.includes("turn/started"));
    assert(notifications.includes("item/agentMessage/delta"));
    assert(!notifications.includes("thread/tokenUsage/updated"));
    assert.equal(notifications.at(-1), "turn/completed");

    const read = await client.request("thread/read", {
      threadId: thread.id,
      includeTurns: true,
    });
    const readThread = responseResult<Record<string, unknown>>(read, "thread");
    assert(Array.isArray(readThread.turns));
    const firstTurn = readThread.turns[0];
    assert(isRecord(firstTurn));
    assert.equal(firstTurn.status, "completed");
    assert(Array.isArray(firstTurn.items));
    const projectedUser = firstTurn.items.find(
      (item) => isRecord(item) && item.type === "userMessage",
    );
    assert(isRecord(projectedUser));
    assert.equal(projectedUser.clientId, null);
  } finally {
    client.close();
    await server.close();
  }
});

test("preserves client user message IDs across subscribed connections", async () => {
  const appServer = testHost();
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const initiating = await CodexClient.connect(server.url);
  const observing = await CodexClient.connect(server.url);
  try {
    const userStarted = deferred<Record<string, unknown>>();
    const userCompleted = deferred<Record<string, unknown>>();
    const turnCompleted = deferred<void>();

    observing.onNotification("item/started", (params) => {
      if (
        isRecord(params) &&
        isRecord(params.item) &&
        params.item.type === "userMessage"
      ) {
        userStarted.resolve(params.item);
      }
    });
    observing.onNotification("item/completed", (params) => {
      if (
        isRecord(params) &&
        isRecord(params.item) &&
        params.item.type === "userMessage"
      ) {
        userCompleted.resolve(params.item);
      }
    });
    observing.onNotification("turn/completed", () => {
      turnCompleted.resolve();
    });

    await initiating.initialize({
      name: "initiating",
      title: "Initiating Client",
      version: "0.1.0",
    });
    await observing.initialize({
      name: "observing",
      title: "Observing Client",
      version: "0.1.0",
    });
    const start = await initiating.request("thread/start", {
      cwd: process.cwd(),
      model: "fake",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");
    if (typeof thread.id !== "string") {
      throw new Error("thread/start returned no thread id");
    }
    const threadId = thread.id;
    await observing.request("thread/resume", { threadId });

    const clientUserMessageId = "t3-user-message-123";
    await initiating.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "cross-client hello" }],
      clientUserMessageId,
    });

    const [startedItem, completedItem] = await within(
      Promise.all([userStarted.promise, userCompleted.promise]),
    );
    await within(turnCompleted.promise);
    assert.equal(startedItem.clientId, clientUserMessageId);
    assert.equal(completedItem.clientId, clientUserMessageId);
    assert.equal(startedItem.id, completedItem.id);

    const snapshot = await appServer.readThread(threadId);
    const canonicalUser = snapshot.items.find(
      (item) => item.type === "user_message",
    );
    assert.equal(canonicalUser?.clientId, clientUserMessageId);

    const read = await observing.request("thread/read", {
      threadId,
      includeTurns: true,
    });
    const readThread = responseResult<Record<string, unknown>>(read, "thread");
    assert(Array.isArray(readThread.turns));
    const projectedTurn = readThread.turns[0];
    assert(isRecord(projectedTurn));
    assert(Array.isArray(projectedTurn.items));
    const projectedUser = projectedTurn.items.find(
      (item) => isRecord(item) && item.type === "userMessage",
    );
    assert(isRecord(projectedUser));
    assert.equal(projectedUser.clientId, clientUserMessageId);
  } finally {
    initiating.close();
    observing.close();
    await server.close();
  }
});

test("accepts matching T3 full-access resume and turn configuration", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost(),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    await client.initialize({
      name: "t3code_desktop",
      title: "T3 Code Desktop",
      version: "0.0.30",
    });
    const start = await client.request("thread/start", {
      cwd: process.cwd(),
      model: "fake",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");

    await assert.rejects(
      client.request("thread/resume", {
        threadId: thread.id,
        model: "",
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );
    await assert.rejects(
      client.request("thread/settings/update", {
        threadId: thread.id,
        model: "",
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );

    const resumed = await client.request("thread/resume", {
      threadId: thread.id,
      cwd: process.cwd(),
      model: "fake",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
      serviceTier: null,
    });
    assert.equal(
      responseResult<Record<string, unknown>>(resumed, "thread").id,
      thread.id,
    );

    const completed = deferred<void>();
    client.onNotification("turn/completed", () => {
      completed.resolve();
    });
    const turn = await client.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "hello from T3" }],
      model: "fake",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
      serviceTier: null,
      effort: null,
      collaborationMode: {
        mode: "default",
        settings: {
          model: "fake",
          reasoning_effort: "medium",
          developer_instructions: "T3 default-mode compatibility envelope",
        },
      },
    });
    assert.equal(
      responseResult<Record<string, unknown>>(turn, "turn").status,
      "inProgress",
    );
    await completed.promise;
  } finally {
    client.close();
    await server.close();
  }
});

test("rejects mismatched or unsupported T3 thread configuration", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost(),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    await client.initialize({
      name: "t3code_desktop",
      title: "T3 Code Desktop",
      version: "0.0.30",
    });
    const start = await client.request("thread/start", {
      cwd: process.cwd(),
      model: "fake",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");

    await assert.rejects(
      client.request("thread/resume", {
        threadId: thread.id,
        model: "a-different-model",
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32000,
    );

    for (const params of [
      { threadId: thread.id, approvalPolicy: "on-request" },
      { threadId: thread.id, sandbox: "workspace-write" },
      { threadId: thread.id, approvalsReviewer: "auto_review" },
      { threadId: thread.id, serviceTier: "fast" },
    ]) {
      await assert.rejects(
        client.request("thread/resume", params),
        (error: unknown) =>
          error instanceof CodexClientError && error.code === -32602,
      );
    }

    const input = [{ type: "text", text: "must not run" }];
    await assert.rejects(
      client.request("turn/start", {
        threadId: thread.id,
        input,
        model: "",
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );
    await assert.rejects(
      client.request("turn/start", {
        threadId: thread.id,
        input,
        model: "a-different-model",
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32000,
    );
    for (const overrides of [
      { approvalPolicy: "on-request" },
      { sandboxPolicy: { type: "workspaceWrite" } },
      { approvalsReviewer: "auto_review" },
      { serviceTier: "fast" },
      { collaborationMode: { mode: "plan", settings: {} } },
      {
        collaborationMode: {
          mode: "default",
          settings: {
            model: "a-different-model",
            reasoning_effort: "medium",
            developer_instructions: "ignored",
          },
        },
      },
    ]) {
      await assert.rejects(
        client.request("turn/start", {
          threadId: thread.id,
          input,
          ...overrides,
        }),
        (error: unknown) =>
          error instanceof CodexClientError && error.code === -32602,
      );
    }
    await assert.rejects(
      client.request("turn/start", {
        threadId: thread.id,
        input,
        effort: "high",
      }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32000,
    );
  } finally {
    client.close();
    await server.close();
  }
});

test("routes transient command approval and persists only command facts", async () => {
  const host = testHost("always");
  const server = await serveCodexWebSocket({
    appServer: host,
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    let approvalRequests = 0;
    const commandOrder: string[] = [];
    client.onNotification("item/started", (params) => {
      if (
        isRecord(params) &&
        isRecord(params.item) &&
        params.item.type === "commandExecution"
      ) {
        commandOrder.push("item/started");
      }
    });
    client.onServerRequest(
      "item/commandExecution/requestApproval",
      (params) => {
        approvalRequests += 1;
        commandOrder.push("approval");
        assert.equal(
          (params as { command: string }).command,
          "printf protocol-approved",
        );
        return { decision: "accept" };
      },
    );
    await client.initialize({
      name: "test",
      title: "Test",
      version: "0.1.0",
    });
    const start = await client.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");
    const completed = deferred<void>();
    client.onNotification("turn/completed", () => {
      completed.resolve();
    });
    await client.request("turn/start", {
      threadId: thread.id,
      input: [
        {
          type: "text",
          text: "!shell printf protocol-approved",
          text_elements: [],
        },
      ],
    });
    await completed.promise;
    assert.equal(approvalRequests, 1);
    assert.deepEqual(commandOrder, ["item/started", "approval"]);

    const snapshot = await host.readThread(String(thread.id));
    assert(!snapshot.items.some((item) => item.type.includes("approval")));
    assert(snapshot.items.some((item) => item.type === "tool_call"));
    assert(snapshot.items.some((item) => item.type === "tool_result"));
  } finally {
    client.close();
    await server.close();
  }
});

test("acceptForSession remains connection-local and suppresses later approval prompts", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost("always"),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    let approvalRequests = 0;
    client.onServerRequest("item/commandExecution/requestApproval", () => {
      approvalRequests += 1;
      return { decision: "acceptForSession" };
    });
    await client.initialize({
      name: "test",
      title: "Test",
      version: "0.1.0",
    });
    const start = await client.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");

    for (const command of ["printf first", "printf second"]) {
      const completed = deferred<void>();
      const dispose = client.onNotification("turn/completed", () => {
        completed.resolve();
      });
      await client.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: `!shell ${command}`, text_elements: [] }],
      });
      await completed.promise;
      dispose();
    }
    assert.equal(approvalRequests, 1);
  } finally {
    client.close();
    await server.close();
  }
});

test("acceptForSession applies only to the approved thread on one connection", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost("always"),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    const approvalThreadIds: string[] = [];
    client.onServerRequest(
      "item/commandExecution/requestApproval",
      (params) => {
        assert(isRecord(params));
        const threadId = params.threadId;
        assert(typeof threadId === "string");
        approvalThreadIds.push(threadId);
        return {
          decision:
            approvalThreadIds.length === 1 ? "acceptForSession" : "accept",
        };
      },
    );
    await client.initialize({
      name: "test",
      title: "Test",
      version: "0.1.0",
    });
    const firstStart = await client.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const firstThread = responseResult<Record<string, unknown>>(
      firstStart,
      "thread",
    );
    const secondStart = await client.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const secondThread = responseResult<Record<string, unknown>>(
      secondStart,
      "thread",
    );

    const runCommand = async (
      threadId: string,
      command: string,
    ): Promise<void> => {
      const completed = deferred<void>();
      const dispose = client.onNotification("turn/completed", (params) => {
        if (isRecord(params) && params.threadId === threadId) {
          completed.resolve();
        }
      });
      try {
        await client.request("turn/start", {
          threadId,
          input: [
            { type: "text", text: `!shell ${command}`, text_elements: [] },
          ],
        });
        await completed.promise;
      } finally {
        dispose();
      }
    };

    await runCommand(String(firstThread.id), "printf first");
    await runCommand(String(firstThread.id), "printf second");
    await runCommand(String(secondThread.id), "printf third");

    assert.deepEqual(approvalThreadIds, [
      String(firstThread.id),
      String(secondThread.id),
    ]);
  } finally {
    client.close();
    await server.close();
  }
});

test("matches the pinned thread/unsubscribe response and rejects thread/subscribe", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost(),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    await client.initialize({
      name: "test",
      title: "Test",
      version: "0.1.0",
    });
    const start = await client.request("thread/start", {});
    const thread = responseResult<Record<string, unknown>>(start, "thread");

    assert.deepEqual(
      await client.request("thread/unsubscribe", { threadId: thread.id }),
      { status: "unsubscribed" },
    );
    assert.deepEqual(
      await client.request("thread/unsubscribe", { threadId: thread.id }),
      { status: "notSubscribed" },
    );
    await assert.rejects(
      client.request("thread/subscribe", { threadId: thread.id }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32601,
    );
    await assert.rejects(
      client.request("thread/start", { approvalPolicy: "untrusted" }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );
    await assert.rejects(
      client.request("thread/start", { sandbox: "workspace-write" }),
      (error: unknown) =>
        error instanceof CodexClientError && error.code === -32602,
    );
  } finally {
    client.close();
    await server.close();
  }
});

test("interrupts a pending approval and resolves its server request", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost("always"),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await CodexClient.connect(server.url);
  try {
    const approvalSeen = deferred<void>();
    const unansweredApproval = deferred<unknown>();
    const requestResolved = deferred<Record<string, unknown>>();
    const commandCompleted = deferred<Record<string, unknown>>();
    const turnCompleted = deferred<Record<string, unknown>>();

    client.onServerRequest("item/commandExecution/requestApproval", () => {
      approvalSeen.resolve();
      return unansweredApproval.promise;
    });
    client.onNotification("serverRequest/resolved", (params) => {
      if (isRecord(params)) {
        requestResolved.resolve(params);
      }
    });
    client.onNotification("item/completed", (params) => {
      if (
        isRecord(params) &&
        isRecord(params.item) &&
        params.item.type === "commandExecution"
      ) {
        commandCompleted.resolve(params.item);
      }
    });
    client.onNotification("turn/completed", (params) => {
      if (isRecord(params) && isRecord(params.turn)) {
        turnCompleted.resolve(params.turn);
      }
    });

    await client.initialize({
      name: "test",
      title: "Test",
      version: "0.1.0",
    });
    const start = await client.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");
    const turnStart = await client.request("turn/start", {
      threadId: thread.id,
      input: [
        {
          type: "text",
          text: "!shell printf never-runs",
          text_elements: [],
        },
      ],
    });
    const turn = responseResult<Record<string, unknown>>(turnStart, "turn");
    await within(approvalSeen.promise);

    assert.deepEqual(
      await within(
        client.request("turn/interrupt", {
          threadId: thread.id,
          turnId: turn.id,
        }),
      ),
      {},
    );
    const [resolved, command, completedTurn] = await within(
      Promise.all([
        requestResolved.promise,
        commandCompleted.promise,
        turnCompleted.promise,
      ]),
    );
    assert.equal(resolved.threadId, thread.id);
    assert.equal(resolved.requestId, "approval_1");
    assert.equal(command.status, "declined");
    assert.equal(completedTurn.status, "interrupted");
  } finally {
    client.close();
    await server.close();
  }
});

test("resumed connections complete commands from canonical tool-call history", async () => {
  const server = await serveCodexWebSocket({
    appServer: testHost("always"),
    zenHome: path.join(os.tmpdir(), "zen-home"),
    listen: "ws://127.0.0.1:0",
  });
  const first = await CodexClient.connect(server.url);
  const resumed = await CodexClient.connect(server.url);
  try {
    const approvalSeen = deferred<void>();
    const approvalDecision = deferred<unknown>();
    const firstTurnCompleted = deferred<void>();
    const resumedCommand = deferred<Record<string, unknown>>();
    const resumedErrors: unknown[] = [];

    first.onServerRequest("item/commandExecution/requestApproval", () => {
      approvalSeen.resolve();
      return approvalDecision.promise;
    });
    first.onNotification("turn/completed", () => {
      firstTurnCompleted.resolve();
    });
    resumed.onNotification("item/completed", (params) => {
      if (
        isRecord(params) &&
        isRecord(params.item) &&
        params.item.type === "commandExecution"
      ) {
        resumedCommand.resolve(params.item);
      }
    });
    resumed.onNotification("error", (params) => {
      resumedErrors.push(params);
    });

    await first.initialize({
      name: "first",
      title: "First",
      version: "0.1.0",
    });
    await resumed.initialize({
      name: "resumed",
      title: "Resumed",
      version: "0.1.0",
    });
    const start = await first.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    const thread = responseResult<Record<string, unknown>>(start, "thread");
    await first.request("turn/start", {
      threadId: thread.id,
      input: [
        {
          type: "text",
          text: `!shell ${shellPrintCommand("resumed-command")}`,
          text_elements: [],
        },
      ],
    });
    await within(approvalSeen.promise);

    await resumed.request("thread/resume", { threadId: thread.id });
    approvalDecision.resolve({ decision: "accept" });

    const command = await within(resumedCommand.promise);
    await within(firstTurnCompleted.promise);
    assert.equal(command.status, "completed");
    assert.equal(command.aggregatedOutput, "resumed-command");
    assert.deepEqual(resumedErrors, []);
  } finally {
    first.close();
    resumed.close();
    await server.close();
  }
});

test("CLI executes one full local protocol turn", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zen-cli-test-"),
  );
  try {
    const echo = await executeCli([
      "run",
      "--data-dir",
      temporaryDirectory,
      "hello CLI",
    ]);
    assert.equal(echo.stderr, "");
    assert.match(echo.stdout, /Echo: hello CLI/);
    const [persistedThreadFile] = await readdir(
      path.join(temporaryDirectory, "threads"),
    );
    if (
      persistedThreadFile === undefined ||
      !persistedThreadFile.endsWith(".jsonl")
    ) {
      throw new Error("CLI did not persist the expected Thread journal");
    }
    const persistedThreadId = persistedThreadFile.slice(0, -".jsonl".length);

    for (const [options, expected] of [
      [["--approval", "always", "--approve"], /approvalPolicy does not match/u],
      [["--cwd", os.tmpdir()], /cwd does not match/u],
    ] as const) {
      await assert.rejects(
        executeCli([
          "run",
          "--data-dir",
          temporaryDirectory,
          "--thread",
          persistedThreadId,
          ...options,
          "resume must reject a mismatched explicit setting",
        ]),
        expected,
      );
    }

    const switchedModel = await executeCli([
      "run",
      "--data-dir",
      temporaryDirectory,
      "--thread",
      persistedThreadId,
      "--model",
      "different-model",
      "resume with a different model",
    ]);
    assert.match(switchedModel.stdout, /Echo: resume with a different model/u);

    const switchedFromCatalog = await executeCli([
      "run",
      "--data-dir",
      temporaryDirectory,
      "--thread",
      persistedThreadId,
      "--model",
      "fake",
      "--models",
      "fake,different-model",
      "resume with a host model catalog",
    ]);
    assert.match(
      switchedFromCatalog.stdout,
      /Echo: resume with a host model catalog/u,
    );

    const matchingResume = await executeCli([
      "run",
      "--data-dir",
      temporaryDirectory,
      "--thread",
      persistedThreadId,
      "--approval",
      "never",
      "resume with matching settings",
    ]);
    assert.match(matchingResume.stdout, /Echo: resume with matching settings/u);

    const fullAccessTool = await executeCli([
      "run",
      "--data-dir",
      temporaryDirectory,
      `!shell ${shellPrintCommand("cli-full-access")}`,
    ]);
    assert.equal(fullAccessTool.stderr, "");
    assert.match(fullAccessTool.stdout, /Command result:\s+cli-full-access/u);

    const approvedTool = await executeCli([
      "run",
      "--data-dir",
      temporaryDirectory,
      "--approve",
      `!shell ${shellPrintCommand("cli-approved")}`,
    ]);
    assert.equal(approvedTool.stderr, "");
    assert.match(approvedTool.stdout, /Command result:\s+cli-approved/u);

    const deniedTool = await executeCli([
      "run",
      "--data-dir",
      temporaryDirectory,
      "--deny",
      "!shell printf command-must-not-run",
    ]);
    assert.equal(deniedTool.stderr, "");
    assert.match(deniedTool.stdout, /User declined this tool call/u);
    assert.doesNotMatch(deniedTool.stdout, /command-must-not-run/u);

    await assert.rejects(
      executeCli([
        "run",
        "--data-dir",
        temporaryDirectory,
        "--approve",
        "--deny",
        "conflicting decisions",
      ]),
      /--approve and --deny cannot be used together/u,
    );
    await assert.rejects(
      executeCli([
        "run",
        "--data-dir",
        temporaryDirectory,
        "--approval",
        "never",
        "--approve",
        "contradictory approval mode",
      ]),
      /--approve\/--deny require approval mode/u,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
});

async function executeCli(
  arguments_: string[],
): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.resolve("dist/apps/cli/src/cli.js"), ...arguments_],
      { cwd: process.cwd() },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`${error.message}\n${stderr}`));
        }
      },
    );
  });
}

async function threadListPage(
  client: CodexClient,
  params: { archived?: boolean; limit?: number; cursor?: string | null },
): Promise<{
  ids: string[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}> {
  const result = await client.request("thread/list", params);
  assert(isRecord(result) && Array.isArray(result.data));
  assert(result.nextCursor === null || typeof result.nextCursor === "string");
  assert(
    result.backwardsCursor === null ||
      typeof result.backwardsCursor === "string",
  );
  return {
    ids: result.data.map((entry) => {
      assert(isRecord(entry) && typeof entry.id === "string");
      return entry.id;
    }),
    nextCursor: result.nextCursor,
    backwardsCursor: result.backwardsCursor,
  };
}

function wireModel(modelId: string): string {
  return encodeModelKey({ providerProfileId: "fake", modelId });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${String(timeoutMs)} ms`));
    }, timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
