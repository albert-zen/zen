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
        { id: "fake", isDefault: true, contextWindow: 100 },
        { id: "other", contextWindow: 1_000 },
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
    assert.equal(usage.context.contextWindow, 100);

    await manager.request("thread/settings/update", {
      threadId: projected.id,
      model: "other",
    });
    const switchedUsage = await manager.readThreadUsage(projected.id);
    assert.equal(switchedUsage.context.inputTokenSource, "estimated");
    assert.equal(switchedUsage.context.contextWindow, 1_000);
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
