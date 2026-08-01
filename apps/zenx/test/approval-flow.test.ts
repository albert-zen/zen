import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AppServerManager,
  type ApprovalRequestEvent,
  type ApprovalResolvedEvent,
} from "../src/main/app-server-manager.js";

test("broadcasts approval state to two renderer clients and completes both decisions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-approval-"));
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
    const firstRequests: ApprovalRequestEvent[] = [];
    const secondRequests: ApprovalRequestEvent[] = [];
    const firstResolved: ApprovalResolvedEvent[] = [];
    const secondResolved: ApprovalResolvedEvent[] = [];
    const approvalSeen = deferred<void>();
    const approvalResolved = deferred<void>();
    const turnCompleted = deferred<void>();
    const outputDeltas: string[] = [];
    manager.onApprovalRequest((event) => {
      firstRequests.push(event);
      approvalSeen.resolve();
    });
    manager.onApprovalRequest((event) => secondRequests.push(event));
    manager.onApprovalResolved((event) => {
      firstResolved.push(event);
      approvalResolved.resolve();
    });
    manager.onApprovalResolved((event) => secondResolved.push(event));
    manager.onNotification((method, params) => {
      if (method === "item/commandExecution/outputDelta") {
        outputDeltas.push((params as { delta: string }).delta);
      }
      if (method === "turn/completed") turnCompleted.resolve();
    });

    const started = await manager.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    await manager.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "!shell printf zenx-approved" }],
    });
    await within(approvalSeen.promise);
    assert.deepEqual(secondRequests, firstRequests);
    assert.deepEqual(manager.pendingApprovalRequests, firstRequests);

    const request = firstRequests[0];
    assert(request !== undefined);
    manager.respondToApproval(request.requestId, "accept");
    assert.throws(
      () => manager.respondToApproval(request.requestId, "decline"),
      /already has a response|no longer pending/u,
    );
    await within(
      Promise.all([approvalResolved.promise, turnCompleted.promise]),
    );

    assert.deepEqual(secondResolved, firstResolved);
    assert.equal(firstResolved[0]?.decision, "accept");
    assert.equal(outputDeltas.join(""), "zenx-approved");

    const declineSeen = deferred<void>();
    const declineResolved = deferred<void>();
    const declineCompleted = deferred<void>();
    const disposeRequest = manager.onApprovalRequest(() =>
      declineSeen.resolve(),
    );
    const disposeResolved = manager.onApprovalResolved((event) => {
      if (event.requestId !== request.requestId) declineResolved.resolve();
    });
    const disposeNotifications = manager.onNotification((method) => {
      if (method === "turn/completed") declineCompleted.resolve();
    });
    await manager.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "!shell printf must-not-run" }],
    });
    await within(declineSeen.promise);
    const decline = manager.pendingApprovalRequests[0];
    assert(decline !== undefined);
    manager.respondToApproval(decline.requestId, "decline");
    await within(
      Promise.all([declineResolved.promise, declineCompleted.promise]),
    );
    disposeRequest();
    disposeResolved();
    disposeNotifications();

    const read = await manager.request("thread/read", {
      threadId: started.thread.id,
      includeTurns: true,
    });
    const commands = read.thread.turns.flatMap((turn) =>
      turn.items.filter((item) => item.type === "commandExecution"),
    );
    assert.deepEqual(
      commands.map((command) => command.status),
      ["completed", "declined"],
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
          () => reject(new Error("Timed out waiting for approval flow")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
