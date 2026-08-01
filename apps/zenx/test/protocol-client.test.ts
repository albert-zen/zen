import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHostedAppServer } from "../../../apps/cli/src/host.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { serveCodexWebSocket } from "../../../src/protocol/codex/websocket.js";
import {
  readBearerTokenFile,
  ZenXProtocolClient,
  type ConnectionStatus,
  type ServerNotificationMethod,
} from "../src/protocol-client/index.js";

function testHost(models: readonly string[] = ["fake"]) {
  return createHostedAppServer({
    cwd: process.cwd(),
    dataDirectory: path.join(os.tmpdir(), "unused-zenx-test-data"),
    model: "fake",
    models,
    approvalPolicy: "never",
    provider: { type: "fake" },
    journal: new InMemoryThreadJournal(),
  });
}

function clientOptions(
  url: string,
  name: string,
  extra: Partial<Parameters<typeof ZenXProtocolClient.connect>[0]> = {},
) {
  return {
    url,
    clientInfo: { name, title: name, version: "0.1.0" },
    ...extra,
  };
}

test("reads bearer credentials only from a private regular file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-token-"));
  const tokenFile = path.join(directory, "app-server.token");
  try {
    await writeFile(tokenFile, "  private-token\n", { mode: 0o600 });
    assert.equal(await readBearerTokenFile(tokenFile), "private-token");
    if (process.platform !== "win32") {
      await chmod(tokenFile, 0o644);
      await assert.rejects(
        readBearerTokenFile(tokenFile),
        /readable by group or others/u,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runs a complete typed lifecycle against the real App Server", async () => {
  const appServer = testHost();
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zenx-home"),
    listen: "ws://127.0.0.1:0",
    bearerToken: "integration-token",
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-auth-"));
  const tokenFile = path.join(directory, "token");
  await writeFile(tokenFile, "integration-token\n", { mode: 0o600 });
  const client = await ZenXProtocolClient.connect(
    clientOptions(server.url, "zenx-integration", {
      bearerTokenFile: tokenFile,
    }),
  );
  try {
    assert.deepEqual(await client.request("account/read", {}), {
      account: null,
      requiresOpenaiAuth: false,
    });
    assert.equal(
      (await client.request("skills/list", { cwds: [process.cwd()] })).data[0]
        ?.cwd,
      process.cwd(),
    );
    assert.equal(
      (await client.request("model/list", {})).data[0]?.isDefault,
      true,
    );

    const notifications: ServerNotificationMethod[] = [];
    const completed = deferred<void>();
    for (const method of [
      "thread/started",
      "turn/started",
      "item/started",
      "item/agentMessage/delta",
      "item/completed",
      "turn/completed",
    ] as const) {
      client.onNotification(method, () => {
        notifications.push(method);
        if (method === "turn/completed") completed.resolve();
      });
    }

    const started = await client.request("thread/start", {
      cwd: process.cwd(),
      model: "fake",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    assert.equal(started.thread.status.type, "idle");
    assert.deepEqual(client.subscriptions, [started.thread.id]);

    const turn = await client.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "hello from ZenX" }],
      clientUserMessageId: "zenx-message-1",
    });
    assert.equal(turn.turn.status, "inProgress");
    await within(completed.promise);

    assert(notifications.includes("thread/started"));
    assert(notifications.includes("turn/started"));
    assert(notifications.includes("item/agentMessage/delta"));
    assert.equal(notifications.at(-1), "turn/completed");

    const read = await client.request("thread/read", {
      threadId: started.thread.id,
      includeTurns: true,
    });
    assert.equal(read.thread.turns[0]?.status, "completed");
    assert.equal(
      read.thread.turns[0]?.items.find((item) => item.type === "userMessage")
        ?.clientId,
      "zenx-message-1",
    );

    await assert.rejects(
      client.request("initialize", {
        clientInfo: { name: "again", title: "Again", version: "1" },
        capabilities: null,
      }),
      /cannot be repeated/u,
    );
  } finally {
    client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("projects the same turn events to two subscribed ZenX clients", async () => {
  const appServer = testHost();
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zenx-home"),
    listen: "ws://127.0.0.1:0",
  });
  const initiating = await ZenXProtocolClient.connect(
    clientOptions(server.url, "zenx-initiating"),
  );
  const observing = await ZenXProtocolClient.connect(
    clientOptions(server.url, "zenx-observing"),
  );
  try {
    const started = await initiating.request("thread/start", {
      cwd: process.cwd(),
      model: "fake",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    await observing.request("thread/resume", {
      threadId: started.thread.id,
    });

    const firstEvents: Array<{ method: string; params: unknown }> = [];
    const secondEvents: Array<{ method: string; params: unknown }> = [];
    const firstCompleted = deferred<void>();
    const secondCompleted = deferred<void>();
    const methods = [
      "turn/started",
      "item/started",
      "item/agentMessage/delta",
      "item/completed",
      "turn/completed",
    ] as const;
    for (const method of methods) {
      initiating.onNotification(method, (params) => {
        firstEvents.push({ method, params: normalizeEvent(params) });
        if (method === "turn/completed") firstCompleted.resolve();
      });
      observing.onNotification(method, (params) => {
        secondEvents.push({ method, params: normalizeEvent(params) });
        if (method === "turn/completed") secondCompleted.resolve();
      });
    }

    await initiating.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "same projection" }],
    });
    await within(
      Promise.all([firstCompleted.promise, secondCompleted.promise]),
    );
    assert.deepEqual(secondEvents, firstEvents);
  } finally {
    initiating.close();
    observing.close();
    await server.close();
  }
});

test("mirrors model updates to two clients and resumes ZAS authority", async () => {
  const appServer = testHost(["fake", "other"]);
  const server = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zenx-home"),
    listen: "ws://127.0.0.1:0",
  });
  const initiating = await ZenXProtocolClient.connect(
    clientOptions(server.url, "zenx-model-initiating"),
  );
  const observing = await ZenXProtocolClient.connect(
    clientOptions(server.url, "zenx-model-observing"),
  );
  try {
    const models = await initiating.request("model/list", {});
    assert.deepEqual(
      models.data.map((model) => [model.id, model.isDefault]),
      [
        ["fake", true],
        ["other", false],
      ],
    );
    const started = await initiating.request("thread/start", {});
    await observing.request("thread/resume", {
      threadId: started.thread.id,
    });
    const firstUpdated = deferred<string>();
    const secondUpdated = deferred<string>();
    initiating.onNotification("thread/settings/updated", (params) => {
      firstUpdated.resolve(params.threadSettings.model);
    });
    observing.onNotification("thread/settings/updated", (params) => {
      secondUpdated.resolve(params.threadSettings.model);
    });

    await initiating.request("thread/settings/update", {
      threadId: started.thread.id,
      model: "other",
    });
    assert.deepEqual(
      await within(Promise.all([firstUpdated.promise, secondUpdated.promise])),
      ["other", "other"],
    );

    const resumed = await observing.request("thread/resume", {
      threadId: started.thread.id,
    });
    assert.equal(resumed.model, "other");
    assert.equal(resumed.thread.modelProvider, "fake");
  } finally {
    initiating.close();
    observing.close();
    await server.close();
  }
});

test("reconnects and restores subscriptions with thread/resume", async () => {
  const appServer = testHost();
  const firstServer = await serveCodexWebSocket({
    appServer,
    zenHome: path.join(os.tmpdir(), "zenx-home"),
    listen: "ws://127.0.0.1:0",
  });
  const client = await ZenXProtocolClient.connect(
    clientOptions(firstServer.url, "zenx-reconnect", {
      reconnect: { maxAttempts: 20, minDelayMs: 20, maxDelayMs: 50 },
    }),
  );
  let secondServer: Awaited<ReturnType<typeof serveCodexWebSocket>> | undefined;
  try {
    const started = await client.request("thread/start", {
      cwd: process.cwd(),
      model: "fake",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const statuses: ConnectionStatus[] = [];
    const reconnected = deferred<void>();
    client.onStatus((status) => {
      statuses.push(status);
      if (status.type === "ready" && status.reconnected) {
        reconnected.resolve();
      }
    });

    const endpoint = new URL(firstServer.url);
    await firstServer.close();
    secondServer = await serveCodexWebSocket({
      appServer,
      zenHome: path.join(os.tmpdir(), "zenx-home"),
      listen: `ws://127.0.0.1:${endpoint.port}`,
    });
    await within(reconnected.promise);

    const restored = statuses.find(
      (status) =>
        status.type === "resubscribed" && status.threadId === started.thread.id,
    );
    assert(restored && restored.type === "resubscribed");
    assert.equal(restored.thread.id, started.thread.id);

    const turnCompleted = deferred<void>();
    client.onNotification("turn/completed", () => turnCompleted.resolve());
    await client.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "after reconnect" }],
    });
    await within(turnCompleted.promise);
  } finally {
    client.close();
    if (secondServer !== undefined) await secondServer.close();
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within<T>(
  promise: Promise<T>,
  milliseconds = 5_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for protocol event")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function normalizeEvent(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, nestedValue: unknown) =>
      key === "startedAtMs" || key === "completedAtMs"
        ? undefined
        : nestedValue,
    ),
  ) as unknown;
}
