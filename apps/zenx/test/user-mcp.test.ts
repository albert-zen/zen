import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBoundUserMcpServer } from "../src/main/user-mcp.js";
import { createRealUserMcpHost } from "./fixtures/real-user-mcp-host.js";

const document = {
  id: "release",
  title: "MCP release plan",
  summary: "A real Host write",
  blocks: [{ kind: "note", id: "scope", text: "Small vertical slice" }],
  events: [],
};
function text(result: any) {
  return result.content
    .filter((part: any) => part.type === "text")
    .map((part: any) => part.text)
    .join("\n");
}
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, text(result));
  return JSON.parse(text(result));
}

test(
  "official SDK subprocess reads actual canonical history and Board, then performs real Board/sidebar CAS",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zen-mcp-stdio-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        fileURLToPath(
          new URL("./fixtures/real-user-mcp-stdio.ts", import.meta.url),
        ),
      ],
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: { ...process.env, ZEN_MCP_FIXTURE_ROOT: root } as Record<
        string,
        string
      >,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (data) => (stderr += String(data)));
    const client = new Client({
      name: "official-sdk-integration",
      version: "1",
    });
    try {
      await client.connect(transport);
      assert.equal(client.getServerVersion()?.name, "zen-bound-user-tools");
      assert.deepEqual(
        (await client.listTools()).tools.map((t) => t.name).sort(),
        [
          "zenx_threads_read",
          "zenx_board_read",
          "zenx_board_put",
          "zenx_self_control_sidebar_read",
          "zenx_self_control_sidebar_update",
        ].sort(),
      );
      const history = await call(client, "zenx_threads_read");
      assert.match(
        JSON.stringify(history),
        /A real private MCP fixture history/,
      );
      const empty = await call(client, "zenx_board_read", { view: "document" });
      assert.equal(empty.exists, false);
      assert.equal(typeof empty.snapshot, "string");
      const put = await call(client, "zenx_board_put", {
        snapshot: empty.snapshot,
        document,
      });
      assert.equal(put.applied, true);
      const full = await call(client, "zenx_board_read", { view: "document" });
      assert.equal(full.document.title, document.title);
      const conflict = await call(client, "zenx_board_put", {
        snapshot: empty.snapshot,
        document: { ...document, title: "Stale" },
      });
      assert.equal(conflict.applied, false);
      assert.equal(
        (await call(client, "zenx_board_read", { view: "document" })).document
          .title,
        document.title,
      );
      const sidebar = await call(client, "zenx_self_control_sidebar_read");
      assert.equal(
        (
          await call(client, "zenx_self_control_sidebar_update", {
            snapshot: sidebar.snapshot,
            patch: { open: true },
          })
        ).applied,
        true,
      );
      assert.equal(
        (
          await call(client, "zenx_self_control_sidebar_update", {
            snapshot: sidebar.snapshot,
            patch: { open: false },
          })
        ).applied,
        false,
      );
      const forged = await client.callTool({
        name: "zenx_board_read",
        arguments: { owner: { kind: "thread", threadId: "another" } },
      });
      assert.equal(forged.isError, true);
      await assert.rejects(
        client.callTool({
          name: "zenx_board_ui",
          arguments: { input: { operation: "event" } },
        }),
        (error: unknown) =>
          error instanceof McpError && error.code === ErrorCode.InvalidParams,
      );
    } catch (error) {
      throw new Error(`Actual MCP subprocess failed. stderr=${stderr}`, {
        cause: error,
      });
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "owner, permission and connection revocation are one-way; rejoining needs a new binding",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zen-mcp-owner-"));
    const host = await createRealUserMcpHost(root);
    const links: Array<{
      client: Client;
      connection: Awaited<ReturnType<typeof createBoundUserMcpServer>>;
    }> = [];
    const connect = async (room = false) => {
      const connection = await createBoundUserMcpServer({
        ...host,
        owner: room
          ? { kind: "room", roomId: "mcp-room", threadId: host.threadId }
          : { kind: "thread", threadId: host.threadId },
      });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const client = new Client({
        name: "official-sdk-owner-check",
        version: "1",
      });
      await connection.server.connect(serverTransport);
      await client.connect(clientTransport);
      links.push({ client, connection });
      return client;
    };
    try {
      const roomClient = await connect(true);
      const baseline = await call(roomClient, "zenx_board_read", {
        view: "document",
      });
      await call(roomClient, "zenx_board_put", {
        snapshot: baseline.snapshot,
        document,
      });
      const rooms = host.rooms;
      host.setRooms([]);
      host.setRooms(rooms);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        (await roomClient.callTool({ name: "zenx_board_read", arguments: {} }))
          .isError,
        true,
      );
      const newRoomClient = await connect(true);
      assert.equal(
        (await call(newRoomClient, "zenx_board_read", { view: "document" }))
          .document.title,
        document.title,
      );
      assert.equal(
        (
          await newRoomClient.callTool({
            name: "zenx_board_put",
            arguments: { snapshot: baseline.snapshot, document },
          })
        ).isError,
        true,
      );
      const threadClient = await connect();
      await host.capabilities.setEnabled("zenx-board", false);
      await host.capabilities.setEnabled("zenx-board", true);
      assert.equal(
        (
          await threadClient.callTool({
            name: "zenx_threads_read",
            arguments: {},
          })
        ).isError,
        true,
      );
      const newThreadClient = await connect();
      await call(newThreadClient, "zenx_threads_read");
      await host.app.setThreadPermissions(host.threadId, "read-only");
      assert.equal(
        (
          await newThreadClient.callTool({
            name: "zenx_board_read",
            arguments: {},
          })
        ).isError,
        true,
      );
      const deniedClient = await connect();
      const denied = await deniedClient.callTool({
        name: "zenx_board_read",
        arguments: { view: "document" },
      });
      assert.equal(denied.isError, true);
      assert.match(text(denied), /approval.*unavailable|Approval is required/i);
      host.revoke();
      assert.equal((await deniedClient.listTools()).tools.length, 0);
      await assert.rejects(connect(), /generation retired/);
    } finally {
      for (const link of links) {
        await link.client.close();
        await link.connection.close();
      }
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "trusted existing Codex approval protocol waits for a real async decision, declines, and cancels on revocation",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zen-mcp-approval-"));
    const host = await createRealUserMcpHost(root);
    await host.app.setThreadPermissions(host.threadId, "read-only");
    const connection = await createBoundUserMcpServer({
      ...host,
      owner: { kind: "thread", threadId: host.threadId },
      requestApproval: host.existingApprovalHandler,
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "official-sdk-existing-approval",
      version: "1",
    });
    await connection.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      let settled = false;
      const firstPrompt = host.nextApproval();
      const first = client
        .callTool({ name: "zenx_board_read", arguments: { view: "document" } })
        .finally(() => {
          settled = true;
        });
      const prompt = await firstPrompt;
      assert.equal(prompt.params.threadId, host.threadId);
      assert.equal(prompt.params.toolName, "zenx_board_read");
      assert.equal(prompt.params.approvalScope, "once");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        settled,
        false,
        "No implicit approval while the existing UI/protocol decision is pending",
      );
      await host.respondApproval(prompt.id, "accept");
      const firstResult = await first;
      assert.notEqual(firstResult.isError, true, text(firstResult));
      const snapshot = JSON.parse(text(firstResult)).snapshot;

      const declinePrompt = host.nextApproval();
      const declined = client.callTool({
        name: "zenx_board_put",
        arguments: { snapshot, document },
      });
      const decline = await declinePrompt;
      assert.equal(decline.params.toolName, "zenx_board_put");
      await host.respondApproval(decline.id, "decline");
      assert.equal((await declined).isError, true);

      const verifyPrompt = host.nextApproval();
      const verify = client.callTool({
        name: "zenx_board_read",
        arguments: { view: "document" },
      });
      await host.respondApproval((await verifyPrompt).id, "accept");
      assert.equal(
        JSON.parse(text(await verify)).exists,
        false,
        "Declined write did not create a Board",
      );

      const revokePrompt = host.nextApproval();
      const cancelled = client.callTool({
        name: "zenx_board_put",
        arguments: { snapshot, document },
      });
      const revoked = await revokePrompt;
      host.revoke();
      assert.equal((await cancelled).isError, true);
      await host.respondApproval(revoked.id, "accept");
      assert.equal(
        (await client.listTools()).tools.length,
        0,
        "A late approval cannot revive retired authority",
      );
    } finally {
      await client.close();
      await connection.close();
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "MCP reuses the actual Agent Host ToolEnvironment remembered allow and deny",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "zen-mcp-shared-policy-"),
    );
    const host = await createRealUserMcpHost(root);
    const links: Array<{
      client: Client;
      connection: Awaited<ReturnType<typeof createBoundUserMcpServer>>;
    }> = [];
    const connect = async (threadId: string) => {
      const connection = await createBoundUserMcpServer({
        ...host,
        owner: { kind: "thread", threadId },
      });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const client = new Client({
        name: "shared-host-authority",
        version: "1",
      });
      await connection.server.connect(serverTransport);
      await client.connect(clientTransport);
      links.push({ client, connection });
      return client;
    };
    try {
      const thread = await host.app.startThread({
        cwd: root,
        approvalPolicy: "always",
        sandbox: "danger-full-access",
      });
      let asks = 0;
      await (
        await host.app.startTurn(
          thread.id,
          '!tool zenx_board_read {"view":"document"}',
          {
            requestApproval: async () => {
              asks++;
              return "accept";
            },
          },
        )
      ).done;
      const native = await host.app.readThread(thread.id);
      const result = native.items.findLast(
        (item) => item.type === "tool_result",
      );
      assert.equal(asks, 1);
      assert.equal(result?.type === "tool_result" && result.exitCode, 0);
      const allowedClient = await connect(thread.id);
      assert.equal(
        (await call(allowedClient, "zenx_board_read", { view: "document" }))
          .exists,
        false,
        "An ordinary Agent's remembered allow admits MCP without a new approval callback",
      );
      assert.equal(
        (await host.app.readThread(thread.id)).items.length,
        native.items.length,
        "MCP does not append a second semantic tool transcript",
      );

      const denied = host.tools.prepare({
        callId: "ordinary-host-denial",
        name: "zenx_board_put",
        arguments: {},
        cwd: root,
        threadId: host.threadId,
        sandbox: "danger-full-access",
        signal: host.signal,
      });
      assert.equal(
        await host.tools.admit(denied, {
          policy: "ask_unknown",
          requestApproval: async () => "decline",
          approvalRequest: {
            threadId: host.threadId,
            turnId: "ordinary-denial",
            itemId: "ordinary-denial",
            callId: "ordinary-denial",
            command: "zenx_board_put",
            toolName: "zenx_board_put",
            toolArguments: {},
            cwd: root,
            signal: host.signal,
          },
        }),
        "decline",
      );
      const fullClient = await connect(host.threadId);
      const empty = await call(fullClient, "zenx_board_read", {
        view: "document",
      });
      const attempt = await fullClient.callTool({
        name: "zenx_board_put",
        arguments: { snapshot: empty.snapshot, document },
      });
      assert.equal(attempt.isError, true);
      assert.match(text(attempt), /denied by current policy/);
      assert.equal(
        (await call(fullClient, "zenx_board_read", { view: "document" }))
          .exists,
        false,
        "A remembered Host denial still blocks an MCP write in never/full-access mode",
      );
    } finally {
      for (const link of links) {
        await link.client.close();
        await link.connection.close();
      }
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "same-name Host generation replacement during final dispatch cannot launch a retained old Board write",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "zen-mcp-final-generation-"),
    );
    const host = await createRealUserMcpHost(root);
    let hold = false;
    let entered!: () => void, release!: () => void;
    const dispatchEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = {
      readThread: host.app.readThread.bind(host.app),
      subscribe: host.app.subscribe.bind(host.app),
      beginHostOperation: host.app.beginHostOperation.bind(host.app),
      async dispatchHostTool<T>(
        expected: Parameters<typeof host.app.dispatchHostTool>[0],
        launch: () => Promise<T>,
      ) {
        if (hold) {
          entered();
          await gate;
        }
        return host.app.dispatchHostTool(expected, launch);
      },
    };
    const connection = await createBoundUserMcpServer({
      ...host,
      app,
      owner: { kind: "thread", threadId: host.threadId },
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "generation-dispatch-fence",
      version: "1",
    });
    await connection.server.connect(serverTransport);
    await client.connect(clientTransport);
    let fresh: Awaited<ReturnType<typeof createBoundUserMcpServer>> | undefined;
    let freshClient: Client | undefined;
    try {
      const baseline = await call(client, "zenx_board_read", {
        view: "document",
      });
      hold = true;
      const pending = client.callTool({
        name: "zenx_board_put",
        arguments: { snapshot: baseline.snapshot, document },
      });
      await dispatchEntered;
      host.replaceHostCapabilityGeneration();
      hold = false;
      release();
      const result = await pending;
      assert.equal(
        result.isError,
        true,
        "A retained old prepared bundle must not launch after Host generation replacement",
      );
      assert.match(text(result), /generation changed/);
      fresh = await createBoundUserMcpServer({
        ...host,
        owner: { kind: "thread", threadId: host.threadId },
      });
      const [newClientTransport, newServerTransport] =
        InMemoryTransport.createLinkedPair();
      freshClient = new Client({
        name: "current-generation-verification",
        version: "1",
      });
      await fresh.server.connect(newServerTransport);
      await freshClient.connect(newClientTransport);
      assert.equal(
        (await call(freshClient, "zenx_board_read", { view: "document" }))
          .exists,
        false,
      );
    } finally {
      release();
      await client.close();
      await connection.close();
      await freshClient?.close();
      await fresh?.close();
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
