import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createLiveUserMcpHost } from "./fixtures/live-user-mcp-host.js";
const document = {
  id: "live",
  title: "Existing Desktop Board",
  summary: "Real process split",
  blocks: [{ kind: "note", id: "scope", text: "Same Host" }],
  events: [],
};
function output(result: any) {
  return result.content
    .filter((part: any) => part.type === "text")
    .map((part: any) => part.text)
    .join("\n");
}
async function call(client: Client, name: string, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, output(result));
  return JSON.parse(output(result));
}
async function connect(
  host: Awaited<ReturnType<typeof createLiveUserMcpHost>>,
  threadId = host.threadId,
  roomId?: string,
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      ...(process.env.ZEN_MCP_TEST_USE_BUILT === "1"
        ? []
        : ["--import", "tsx"]),
      fileURLToPath(
        new URL(
          process.env.ZEN_MCP_TEST_USE_BUILT === "1"
            ? "../out/main/user-mcp-stdio-cli.js"
            : "../src/main/user-mcp-stdio-cli.ts",
          import.meta.url,
        ),
      ),
      "--descriptor",
      host.descriptorFile,
      "--thread",
      threadId,
      ...(roomId ? ["--room", roomId] : []),
    ],
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: process.env as Record<string, string>,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (data) => {
    stderr += String(data);
  });
  const client = new Client({
    name: "already-running-desktop-acceptance",
    version: "1",
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    throw new Error(`Live launcher failed: ${stderr}`, { cause: error });
  }
  return client;
}

test(
  "official SDK subprocess connects to previously booted actual Desktop child, preserves history and Board CAS",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zen-mcp-live-desktop-"));
    const host = await createLiveUserMcpHost(root);
    const pid = host.manager.processId;
    let client: Client | undefined;
    try {
      const before = await host.manager.request("zen/thread/read", {
        threadId: host.threadId,
      });
      client = await connect(host);
      assert.equal(host.manager.processId, pid);
      assert.equal(client.getServerVersion()?.name, "zen-bound-user-tools");
      assert.match(
        JSON.stringify(await call(client, "zenx_threads_read")),
        /Actual already-running Desktop child history/,
      );
      const empty = await call(client, "zenx_board_read", { view: "document" });
      assert.equal(empty.exists, false);
      assert.equal(
        (
          await call(client, "zenx_board_put", {
            snapshot: empty.snapshot,
            document,
          })
        ).applied,
        true,
      );
      assert.equal(
        (
          await call(client, "zenx_board_put", {
            snapshot: empty.snapshot,
            document: { ...document, title: "stale" },
          })
        ).applied,
        false,
      );
      assert.equal(
        (await call(client, "zenx_board_read", { view: "document" })).document
          .title,
        document.title,
      );
      const after = await host.manager.request("zen/thread/read", {
        threadId: host.threadId,
      });
      assert.equal(
        after.thread.items.length,
        before.thread.items.length,
        "MCP creates no synthetic Turn or second transcript",
      );
      assert.equal(
        host.manager.processId,
        pid,
        "Launcher never boots or replaces the Desktop child",
      );
    } finally {
      await client?.close();
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

function nextApproval(host: Awaited<ReturnType<typeof createLiveUserMcpHost>>) {
  return new Promise<
    import("../src/main/app-server-manager.js").ApprovalRequestEvent
  >((resolve) => {
    const stop = host.manager.onApprovalRequest((event) => {
      stop();
      resolve(event);
    });
  });
}
async function resultFromApproval(
  host: Awaited<ReturnType<typeof createLiveUserMcpHost>>,
  client: Client,
  name: string,
  args: Record<string, unknown>,
  decision: "acceptForSession" | "decline",
) {
  const observed = nextApproval(host);
  const pending = client.callTool({ name, arguments: args });
  const event = await observed;
  assert.equal(event.params.toolName, name);
  assert(
    host.manager.pendingApprovalRequests.some(
      (request) => request.requestId === event.requestId,
    ),
    "The normal Desktop pending approval map owns this request",
  );
  host.manager.respondToApproval(event.requestId, decision);
  return await pending;
}

test(
  "live tunnel reaches normal asynchronous Desktop approval, and decline, generation and Room loss cannot execute",
  { timeout: 90000 },
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "zen-mcp-live-approval-"),
    );
    const host = await createLiveUserMcpHost(root);
    const clients: Client[] = [];
    try {
      const threadId = (
        await host.manager.request("thread/start", {
          approvalPolicy: "on-request",
          sandbox: "danger-full-access",
        })
      ).thread.id;
      const client = await connect(host, threadId);
      clients.push(client);
      const read = await resultFromApproval(
        host,
        client,
        "zenx_board_read",
        { view: "document" },
        "acceptForSession",
      );
      assert.notEqual(read.isError, true, output(read));
      const empty = JSON.parse(output(read));
      const put = await resultFromApproval(
        host,
        client,
        "zenx_board_put",
        { snapshot: empty.snapshot, document },
        "acceptForSession",
      );
      assert.notEqual(put.isError, true, output(put));
      assert.equal(JSON.parse(output(put)).applied, true);
      const fullRead = await resultFromApproval(
        host,
        client,
        "zenx_board_read",
        { view: "document" },
        "acceptForSession",
      );
      const full = JSON.parse(output(fullRead));
      assert.equal(full.document.title, document.title);

      const staleApproval = nextApproval(host);
      const staleWrite = client.callTool({
        name: "zenx_board_put",
        arguments: {
          snapshot: full.snapshot,
          document: {
            ...document,
            title: "must not execute after generation change",
          },
        },
      });
      const staleEvent = await staleApproval;
      assert.equal((await host.replaceGeneration()).status, "refreshed");
      const staleResult = await staleWrite;
      assert.equal(staleResult.isError, true);
      assert.match(
        output(staleResult),
        /publication changed|generation|cancel|aborted/i,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.throws(
        () => host.manager.respondToApproval(staleEvent.requestId, "accept"),
        /no longer pending/,
      );

      const fresh = await connect(host, threadId);
      clients.push(fresh);
      const freshRead = await resultFromApproval(
        host,
        fresh,
        "zenx_board_read",
        { view: "document" },
        "acceptForSession",
      );
      const freshFull = JSON.parse(output(freshRead));
      assert.equal(freshFull.document.title, document.title);
      const declined = await resultFromApproval(
        host,
        fresh,
        "zenx_board_put",
        {
          snapshot: freshFull.snapshot,
          document: { ...document, title: "declined" },
        },
        "decline",
      );
      assert.equal(declined.isError, true);
      assert.match(output(declined), /not approved/);
      const unchanged = await resultFromApproval(
        host,
        fresh,
        "zenx_board_read",
        { view: "document" },
        "acceptForSession",
      );
      assert.equal(
        JSON.parse(output(unchanged)).document.title,
        document.title,
      );

      // Use sidebar update (not the now-denied Board tool) to observe live Room loss.
      const roomId = "live-room";
      const room = {
        id: roomId,
        name: "Private live Room",
        createdAt: 0,
        operationEpoch: "fixture",
        members: [{ threadId, name: "Worker" }],
        messages: [],
      };
      host.setRooms([room]);
      const roomClient = await connect(host, threadId, roomId);
      clients.push(roomClient);
      const sidebar = await resultFromApproval(
        host,
        roomClient,
        "zenx_self_control_sidebar_read",
        {},
        "acceptForSession",
      );
      const baseline = JSON.parse(output(sidebar));
      const roomApproval = nextApproval(host);
      const roomWrite = roomClient.callTool({
        name: "zenx_self_control_sidebar_update",
        arguments: { snapshot: baseline.snapshot, patch: { open: true } },
      });
      const roomEvent = await roomApproval;
      host.setRooms([]);
      // No MCP read triggers this cancellation. The existing Room source observes loss.
      const retired = await roomWrite;
      assert.equal(retired.isError, true);
      assert.match(output(retired), /Room member|retired|cancel|aborted/i);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.throws(
        () => host.manager.respondToApproval(roomEvent.requestId, "accept"),
        /no longer pending/,
      );
      host.setRooms([room]);
      const cannotRevive = await roomClient.callTool({
        name: "zenx_self_control_sidebar_read",
      });
      assert.equal(cannotRevive.isError, true);
      const newRoomClient = await connect(host, threadId, roomId);
      clients.push(newRoomClient);
      const roomUnchanged = await resultFromApproval(
        host,
        newRoomClient,
        "zenx_self_control_sidebar_read",
        {},
        "acceptForSession",
      );
      assert.equal(
        JSON.parse(output(roomUnchanged)).state.open,
        baseline.state.open,
      );
    } finally {
      for (const client of clients) await client.close();
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
