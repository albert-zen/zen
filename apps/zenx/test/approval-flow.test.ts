import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { shellPrintCommand } from "./fixtures/shell-command.js";

import {
  AppServerManager,
  type ApprovalRequestEvent,
  type ApprovalResolvedEvent,
} from "../src/main/app-server-manager.js";

test("broadcasts approval state and reuses the persisted tool decision", async () => {
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
      input: [
        { type: "text", text: `!shell ${shellPrintCommand("zenx-approved")}` },
      ],
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

    const reusedCompleted = deferred<void>();
    const disposeNotifications = manager.onNotification((method) => {
      if (method === "turn/completed") reusedCompleted.resolve();
    });
    await manager.request("turn/start", {
      threadId: started.thread.id,
      input: [
        { type: "text", text: `!shell ${shellPrintCommand("zenx-reused")}` },
      ],
    });
    await within(reusedCompleted.promise);
    disposeNotifications();
    assert.equal(firstRequests.length, 1);
    assert.equal(secondRequests.length, 1);
    assert.deepEqual(manager.pendingApprovalRequests, []);

    const read = await manager.request("thread/read", {
      threadId: started.thread.id,
      includeTurns: true,
    });
    const commands = read.thread.turns.flatMap((turn) =>
      turn.items.filter((item) => item.type === "commandExecution"),
    );
    assert.deepEqual(
      commands.map((command) => command.status),
      ["completed", "completed"],
    );
    assert.equal(outputDeltas.join(""), "zenx-approvedzenx-reused");
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("scopes approval identity to one Host connection and resolves pending UI on stop", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-approval-generation-"),
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
  const requests: ApprovalRequestEvent[] = [];
  const resolved: ApprovalResolvedEvent[] = [];
  const seen = [deferred<void>(), deferred<void>()];
  manager.onApprovalRequest((event) => {
    requests.push(event);
    seen[requests.length - 1]?.resolve();
  });
  manager.onApprovalResolved((event) => resolved.push(event));
  try {
    await manager.start();
    const firstThread = (await manager.request("thread/start", {})).thread;
    await manager.request("turn/start", {
      threadId: firstThread.id,
      input: [{ type: "text", text: `!shell ${shellPrintCommand("first")}` }],
    });
    await within(seen[0]!.promise);
    const firstId = requests[0]!.requestId;

    await manager.stop();
    assert.deepEqual(resolved, [
      {
        requestId: firstId,
        threadId: firstThread.id,
        decision: "cancel",
      },
    ]);

    await manager.start();
    const secondThread = (await manager.request("thread/start", {})).thread;
    await manager.request("turn/start", {
      threadId: secondThread.id,
      input: [{ type: "text", text: `!shell ${shellPrintCommand("second")}` }],
    });
    await within(seen[1]!.promise);
    const secondId = requests[1]!.requestId;
    assert.notEqual(secondId, firstId);
    assert.throws(
      () => manager.respondToApproval(firstId, "accept"),
      /no longer pending/u,
    );
    manager.respondToApproval(secondId, "decline");
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
