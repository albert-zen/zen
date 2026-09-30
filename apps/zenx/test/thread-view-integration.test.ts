import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { shellPrintCommand } from "./fixtures/shell-command.js";
import { png1x1 } from "../../../test/fixtures.js";

import { AppServerManager } from "../src/main/app-server-manager.js";
import type { Thread } from "../src/protocol-client/index.js";
import { applyThreadViewNotification } from "../src/renderer/src/thread-view-state.js";

test("projects a streamed tool turn from the hosted App Server", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-view-"));
  const manager = new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "runtime", "app-server.token"),
    hostConfig: {
      cwd: process.cwd(),
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      modelCatalog: [
        { id: "fake", isDefault: true, contextWindow: 10_000 },
        { id: "other", contextWindow: 20_000 },
      ],
      approvalPolicy: "never",
      provider: { type: "fake" },
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
  try {
    await manager.start();
    const started = await manager.request("thread/start", {});
    let projected: Thread = started.thread;
    const complete = deferred<void>();
    const dispose = manager.onNotification((method, params) => {
      projected = applyThreadViewNotification(projected, method, params);
      if (method === "turn/completed") complete.resolve();
    });

    await manager.request("turn/start", {
      threadId: projected.id,
      input: [
        { type: "text", text: `!shell ${shellPrintCommand("zenx-stream")}` },
      ],
    });
    await within(complete.promise);
    dispose();

    const currentTurn = projected.turns.at(-1);
    assert.equal(currentTurn?.status, "completed");
    const command = currentTurn?.items.find(
      (item) => item.type === "commandExecution",
    );
    assert.equal(command?.status, "completed");
    assert.equal(command?.aggregatedOutput, "zenx-stream");
    assert(
      currentTurn?.items.some(
        (item) => item.type === "agentMessage" && item.text.length > 0,
      ),
    );
    const usageComplete = deferred<void>();
    const disposeUsage = manager.onNotification((method) => {
      if (method === "turn/completed") usageComplete.resolve();
    });
    const usageTurn = await manager.request("turn/start", {
      threadId: projected.id,
      input: [{ type: "text", text: "usage sample" }],
    });
    await within(usageComplete.promise);
    disposeUsage();
    const usage = await manager.readThreadUsage(projected.id);
    assert.equal(usage.thread.responseCount, 1);
    assert.equal(usage.thread.cachedInputTokens, undefined);
    assert.equal(usage.thread.cacheHitRate, undefined);
    assert.ok(usage.thread.inputTokens > 0);
    assert.deepEqual(usage.turns[usageTurn.turn.id], usage.thread);
    assert.equal(usage.context.inputTokenSource, "provider");
    assert.equal(usage.context.contextWindow, 10_000);

    await manager.request("thread/settings/update", {
      threadId: projected.id,
      model: "other",
    });
    const switchedUsage = await manager.readThreadUsage(projected.id);
    assert.equal(switchedUsage.context.inputTokenSource, "estimated");
    assert.equal(switchedUsage.context.contextWindow, 20_000);
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("drives soft steer and atomic Interrupt & send through the hosted App Server", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-steer-"));
  const manager = new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "runtime", "app-server.token"),
    hostConfig: {
      cwd: process.cwd(),
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "always",
      provider: { type: "fake" },
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
  try {
    await manager.start();
    const started = await manager.request("thread/start", {});
    const approval = deferred<void>();
    const approvalCancelled = deferred<void>();
    const disposeApproval = manager.onApprovalRequest(() => approval.resolve());
    const disposeResolved = manager.onApprovalResolved((event) => {
      if (event.decision === "cancel") approvalCancelled.resolve();
    });
    const old = await manager.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "!shell printf old" }],
      clientUserMessageId: "start-old",
    });
    await within(approval.promise);

    const steered = await manager.request("turn/steer", {
      threadId: started.thread.id,
      expectedTurnId: old.turn.id,
      input: [{ type: "text", text: "use this guidance" }],
      clientUserMessageId: "steer-one",
    });
    assert.equal(steered.turnId, old.turn.id);

    const replaced = await manager.request("turn/replace", {
      threadId: started.thread.id,
      expectedTurnId: old.turn.id,
      input: [{ type: "text", text: "replacement work" }],
      clientUserMessageId: "replace-one",
    });
    assert.equal(replaced.interruptedTurnId, old.turn.id);
    assert.notEqual(replaced.turnId, old.turn.id);
    await within(approvalCancelled.promise);
    assert.equal(manager.pendingApprovalRequests.length, 0);

    const read = await manager.request("thread/read", {
      threadId: started.thread.id,
      includeTurns: true,
    });
    assert.equal(read.thread.turns[0]?.status, "interrupted");
    assert.equal(read.thread.turns[1]?.id, replaced.turnId);
    assert(
      read.thread.turns[1]?.items.some(
        (item) =>
          item.type === "userMessage" &&
          item.clientId === "replace-one" &&
          item.content[0]?.text === "replacement work",
      ),
    );
    disposeApproval();
    disposeResolved();
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("imports image-only input and resumes canonical AttachmentRefs without journal payloads", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-image-view-"));
  const dataDirectory = path.join(directory, "data");
  const manager = new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "runtime", "app-server.token"),
    hostConfig: {
      cwd: process.cwd(),
      dataDirectory,
      model: "fake-image",
      modelCatalog: [
        {
          id: "fake-image",
          contextWindow: 32_768,
          isDefault: true,
          source: "manual",
          supportedReasoningEfforts: ["medium"],
          defaultReasoningEffort: "medium",
          inputModalities: ["text", "image"],
        },
      ],
      approvalPolicy: "never",
      provider: { type: "fake" },
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
  try {
    await manager.start();
    const started = await manager.request("thread/start", {});
    const complete = deferred<void>();
    const dispose = manager.onNotification((method) => {
      if (method === "turn/completed") complete.resolve();
    });
    await manager.request("turn/start", {
      threadId: started.thread.id,
      input: [
        {
          type: "image",
          url: `data:image/png;base64,${Buffer.from(png1x1()).toString("base64")}`,
        },
      ],
      clientUserMessageId: "image-only",
    });
    await within(complete.promise);
    dispose();
    const projection = await manager.readThreadAttachments(started.thread.id);
    const attachments = Object.values(projection).flat();
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]?.mediaType, "image/png");

    const journals = await readdir(path.join(dataDirectory, "threads"));
    const journal = await readFile(
      path.join(dataDirectory, "threads", journals[0]!),
      "utf8",
    );
    assert.equal(journal.includes("base64"), false);
    assert.equal(
      journal.includes(Buffer.from(png1x1()).toString("base64")),
      false,
    );
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, milliseconds = 10_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for turn/completed")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("hosted native cancel preserves CAS queue history and delivers only the uncanceled message", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-native-cancel-"),
  );
  const manager = new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "runtime", "app-server.token"),
    hostConfig: {
      cwd: process.cwd(),
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "always",
      provider: { type: "fake" },
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
  try {
    await manager.start();
    const thread = (await manager.request("thread/start", {})).thread;
    const approval = deferred<string>();
    const finished = deferred<void>();
    let completions = 0;
    manager.onApprovalRequest((event) => approval.resolve(event.requestId));
    manager.onNotification((method) => {
      if (method === "turn/completed" && ++completions === 2)
        finished.resolve();
    });
    await manager.request("turn/start", {
      threadId: thread.id,
      input: [
        { type: "text", text: '!tool run_code {"code":"console.log(1)"}' },
      ],
    });
    const approvalId = await within(approval.promise);
    await manager.request("turn/queue", {
      threadId: thread.id,
      clientUserMessageId: "legacy-cancel",
      input: [{ type: "text", text: "legacy pending" }],
    });
    await manager.request("zen/turn/send", {
      threadId: thread.id,
      mode: "batch-next",
      clientUserMessageId: "native-kept",
      input: [{ type: "text", text: "keep this next turn" }],
    });
    const before = (
      await manager.request("zen/thread/read", { threadId: thread.id })
    ).thread.items;
    const firstQueue = before.find(
      (item) =>
        item.type === "user_message_queued" &&
        item.clientId === "legacy-cancel",
    );
    assert.ok(firstQueue);
    const target = { queuedItemId: firstQueue.id, clientId: "legacy-cancel" };
    assert.deepEqual(
      (
        await manager.request("zen/thread/queue/cancel", {
          threadId: thread.id,
          items: [target],
        })
      ).results,
      [{ ...target, status: "cancelled" }],
    );
    assert.deepEqual(
      (
        await manager.request("zen/thread/queue/cancel", {
          threadId: thread.id,
          items: [target],
        })
      ).results,
      [{ ...target, status: "already_cancelled" }],
    );
    const whileActive = await manager.request("zen/thread/read", {
      threadId: thread.id,
    });
    assert.ok(
      whileActive.thread.items.some(
        (item) =>
          item.type === "user_message_queue_cancelled" &&
          item.queuedItemId === target.queuedItemId,
      ),
    );
    assert.deepEqual(
      whileActive.thread.items.filter(
        (item) => item.type === "user_message_queue_cancelled",
      ).length,
      1,
    );
    manager.respondToApproval(approvalId, "accept");
    await within(finished.promise);
    const after = (
      await manager.request("zen/thread/read", { threadId: thread.id })
    ).thread;
    assert.deepEqual(
      after.turns
        .at(-1)
        ?.items.filter((item) => item.type === "user_message")
        .map((item) => item.clientId),
      ["native-kept"],
    );
    assert.equal(
      after.items.some(
        (item) =>
          item.type === "user_message" && item.clientId === "legacy-cancel",
      ),
      false,
    );
    assert.deepEqual(
      (
        await manager.request("zen/thread/queue/cancel", {
          threadId: thread.id,
          items: [
            {
              queuedItemId: before.find(
                (item) =>
                  item.type === "user_message_queued" &&
                  item.clientId === "native-kept",
              )!.id,
              clientId: "native-kept",
            },
          ],
        })
      ).results.map((entry) => entry.status),
      ["already_started"],
    );
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("queued messages retain approval routing and drain through the hosted protocol", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-queue-"));
  const manager = new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "runtime", "app-server.token"),
    hostConfig: {
      cwd: process.cwd(),
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "always",
      provider: { type: "fake" },
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
  try {
    await manager.start();
    const started = await manager.request("thread/start", {});
    const firstApproval = deferred<string>();
    let approvals = 0;
    let completions = 0;
    const finished = deferred<void>();
    manager.onApprovalRequest((request) => {
      approvals += 1;
      if (approvals === 1) firstApproval.resolve(request.requestId);
      else manager.respondToApproval(request.requestId, "accept");
    });
    manager.onNotification((method) => {
      if (method === "turn/completed" && ++completions === 2)
        finished.resolve();
    });
    await manager.request("turn/start", {
      threadId: started.thread.id,
      input: [
        {
          type: "text",
          text: `!tool run_code ${JSON.stringify({ code: "console.log('first')" })}`,
        },
      ],
    });
    const approvalId = await within(firstApproval.promise);
    await manager.request("turn/queue", {
      threadId: started.thread.id,
      input: [{ type: "text", text: `!shell ${shellPrintCommand("queued")}` }],
      clientUserMessageId: "queued-approval",
    });
    const queued = await manager.request("thread/read", {
      threadId: started.thread.id,
      includeTurns: true,
    });
    assert.equal(queued.thread.queuedMessages?.length, 1);
    assert.equal(approvals, 1);
    manager.respondToApproval(approvalId, "accept");
    await within(finished.promise);
    const result = await manager.request("thread/read", {
      threadId: started.thread.id,
      includeTurns: true,
    });
    assert.equal(approvals, 2);
    assert.deepEqual(result.thread.queuedMessages, []);
    assert.equal(result.thread.turns.length, 2);
    assert.ok(
      result.thread.turns[1]?.items.some(
        (item) =>
          item.type === "commandExecution" &&
          item.aggregatedOutput === "queued",
      ),
    );
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("native batch choice crosses hosted protocol without changing legacy queue", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-native-batch-"));
  const manager = new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "runtime", "app-server.token"),
    hostConfig: {
      cwd: process.cwd(),
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "always",
      provider: { type: "fake" },
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
  try {
    await manager.start();
    const { thread } = await manager.request("thread/start", {});
    const waiting = deferred<string>();
    const finished = deferred<void>();
    let completed = 0;
    manager.onApprovalRequest((request) => waiting.resolve(request.requestId));
    manager.onNotification((method) => {
      if (method === "turn/completed" && ++completed === 2) finished.resolve();
    });
    await manager.request("turn/start", {
      threadId: thread.id,
      input: [
        { type: "text", text: '!tool run_code {"code":"console.log(1)"}' },
      ],
    });
    const approvalId = await within(waiting.promise);
    for (const [index, text] of ["same", "same", "third"].entries()) {
      await manager.request("zen/turn/send", {
        threadId: thread.id,
        mode: "batch-next",
        input: [{ type: "text", text }],
        clientUserMessageId: `manual-${index}`,
      });
    }
    const waitingQueue = await manager.request("zen/thread/read", {
      threadId: thread.id,
    });
    assert.deepEqual(
      waitingQueue.thread.items
        .filter((item) => item.type === "user_message_queued")
        .map((item) => item.deliveryMode),
      ["batch-next", "batch-next", "batch-next"],
    );
    manager.respondToApproval(approvalId, "accept");
    await within(finished.promise);
    const final = await manager.request("zen/thread/read", {
      threadId: thread.id,
    });
    assert.equal(final.thread.turns.length, 2);
    assert.deepEqual(
      final.thread.turns
        .at(-1)
        ?.items.filter((item) => item.type === "user_message")
        .map((item) => item.clientId),
      ["manual-0", "manual-1", "manual-2"],
    );
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
