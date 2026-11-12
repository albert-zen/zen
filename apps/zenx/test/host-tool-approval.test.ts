import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AppServerManager,
  type ApprovalRequestEvent,
  type ApprovalResolvedEvent,
} from "../src/main/app-server-manager.js";

function fixture(directory: string) {
  return new AppServerManager({
    entryPath: fileURLToPath(
      new URL("../src/main/app-server-host.ts", import.meta.url),
    ),
    tokenFile: path.join(directory, "runtime", "token"),
    hostConfig: {
      cwd: directory,
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "always",
      provider: { type: "fake" },
      toolPresentation: "direct",
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10000,
  });
}
function request(
  threadId: string,
  cwd: string,
  signal: AbortSignal,
  callId = "external-tool",
) {
  return {
    threadId,
    cwd,
    signal,
    callId,
    turnId: callId,
    itemId: callId,
    command: "zenx_board_put",
    toolName: "zenx_board_put",
    toolArguments: { document: { title: "review me" } },
    scope: "once" as const,
  };
}

test(
  "Host-owned tool approvals use the existing renderer events and pending map without a synthetic Turn",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zen-host-tool-approval-"),
    );
    const manager = fixture(directory);
    const seen: ApprovalRequestEvent[] = [],
      resolved: ApprovalResolvedEvent[] = [];
    manager.onApprovalRequest((event) => seen.push(event));
    manager.onApprovalResolved((event) => resolved.push(event));
    try {
      await manager.start();
      const thread = (await manager.request("thread/start", {})).thread;
      const before = await manager.request("zen/thread/read", {
        threadId: thread.id,
      });
      const approve = manager.hostToolApprovalHandler();
      const pending = approve(
        request(thread.id, directory, new AbortController().signal),
      );
      assert.equal(seen.length, 1);
      assert.deepEqual(manager.pendingApprovalRequests, seen);
      assert.equal(seen[0]!.params.approvalScope, "once");
      assert.equal(seen[0]!.params.toolName, "zenx_board_put");
      manager.respondToApproval(seen[0]!.requestId, "accept");
      assert.equal(await pending, "accept");
      assert.equal(resolved[0]!.requestId, seen[0]!.requestId);
      assert.deepEqual(manager.pendingApprovalRequests, []);
      const after = await manager.request("zen/thread/read", {
        threadId: thread.id,
      });
      assert.equal(
        after.thread.items.length,
        before.thread.items.length,
        "Approval UI does not invent canonical tool Items or a Turn",
      );
      assert.throws(
        () => manager.respondToApproval(seen[0]!.requestId, "accept"),
        /no longer pending/,
      );
      const decline = approve(
        request(
          thread.id,
          directory,
          new AbortController().signal,
          "decline-tool",
        ),
      );
      manager.respondToApproval(seen[1]!.requestId, "decline");
      assert.equal(await decline, "decline");
    } finally {
      await manager.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Host approval abort and process replacement retire exact UI requests and old handlers",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zen-host-tool-epoch-"),
    );
    const manager = fixture(directory);
    const seen: ApprovalRequestEvent[] = [],
      resolved: ApprovalResolvedEvent[] = [];
    manager.onApprovalRequest((event) => seen.push(event));
    manager.onApprovalResolved((event) => resolved.push(event));
    try {
      await manager.start();
      const thread = (await manager.request("thread/start", {})).thread;
      const old = manager.hostToolApprovalHandler();
      const controller = new AbortController();
      const aborted = old(request(thread.id, directory, controller.signal));
      const oldId = seen[0]!.requestId;
      controller.abort(new Error("MCP connection revoked"));
      assert.equal(await aborted, "cancel");
      assert.throws(
        () => manager.respondToApproval(oldId, "accept"),
        /no longer pending/,
      );
      const stopped = old(
        request(
          thread.id,
          directory,
          new AbortController().signal,
          "stop-tool",
        ),
      );
      await manager.stop();
      assert.equal(await stopped, "cancel");
      await manager.start();
      assert.equal(
        await old(request(thread.id, directory, new AbortController().signal)),
        "cancel",
      );
      assert.equal(
        seen.length,
        2,
        "Old Host handlers cannot mint approvals in the new process",
      );
      assert.equal(
        resolved.filter((event) => event.decision === "cancel").length,
        2,
      );
    } finally {
      await manager.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
