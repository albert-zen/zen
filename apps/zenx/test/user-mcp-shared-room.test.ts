import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ApprovalRequestEvent } from "../src/main/app-server-manager.js";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { createLiveUserMcpHost } from "./fixtures/live-user-mcp-host.js";

const body = (title: string) => ({
  id: "same-authored-id",
  title,
  summary: "Room workspace body, separate from member-private Boards",
  blocks: [{ kind: "note", id: "body", text: title }],
  events: [],
});
function output(result: any): string {
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
  assert.notEqual(result.isError, true, output(result));
  return JSON.parse(output(result));
}
async function connect(
  host: Awaited<ReturnType<typeof createLiveUserMcpHost>>,
  threadId: string,
  roomId?: string,
) {
  const built = process.env.ZEN_MCP_TEST_USE_BUILT === "1";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      ...(built ? [] : ["--import", "tsx"]),
      fileURLToPath(
        new URL(
          built
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
    env: {
      PATH: process.env.PATH!,
      HOME: path.dirname(path.dirname(host.descriptorFile)),
      TMPDIR: path.dirname(path.dirname(host.descriptorFile)),
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({
    name: "shared-room-live-desktop-acceptance",
    version: "1",
  });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await transport.close();
    throw new Error(`Existing Desktop owner binding failed: ${stderr}`, {
      cause: error,
    });
  }
}

test(
  "current Room members share one workspace Board while private Boards and revoked execution remain isolated",
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zen-mcp-shared-room-"));
    const clients: Client[] = [];
    let cleanupHost:
      Awaited<ReturnType<typeof createLiveUserMcpHost>> | undefined;
    t.after(async () => {
      const closed = await Promise.allSettled(
        clients.map((client) => client.close()),
      );
      try {
        await cleanupHost?.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
      for (const result of closed)
        if (result.status === "rejected") throw result.reason;
    });
    const host = await createLiveUserMcpHost(root, {
      environment: { PATH: process.env.PATH!, HOME: root, TMPDIR: root },
    });
    cleanupHost = host;
    const a = host.threadId;
    const b = (
      await host.manager.request("thread/start", {
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
      })
    ).thread.id;
    const readOnly = (
      await host.manager.request("thread/start", {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      })
    ).thread.id;
    const outsider = (
      await host.manager.request("thread/start", {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      })
    ).thread.id;
    let bBoardDispatches = 0;
    const execute = ZenXCapabilityService.prototype.execute;
    t.mock.method(
      ZenXCapabilityService.prototype,
      "execute",
      function (
        this: ZenXCapabilityService,
        ...args: Parameters<ZenXCapabilityService["execute"]>
      ) {
        if (args[0].threadId === b && args[0].name === "zenx_board_put")
          bBoardDispatches++;
        return Reflect.apply(execute, this, args);
      },
    );
    const roomId = "workspace-room";
    const room = (members: string[]) => ({
      id: roomId,
      name: "Shared workspace",
      createdAt: 0,
      operationEpoch: "private-fixture-room",
      members: members.map((threadId) => ({
        threadId,
        name: threadId === a ? "A" : "B",
      })),
      messages: [],
    });
    let holdNextBWrite = false;
    let heldApproval: ((event: ApprovalRequestEvent) => void) | undefined;
    const stopApprovals = host.manager.onApprovalRequest((event) => {
      if (
        holdNextBWrite &&
        event.params.threadId === b &&
        event.params.toolName === "zenx_board_put"
      ) {
        holdNextBWrite = false;
        heldApproval?.(event);
        return;
      }
      host.manager.respondToApproval(event.requestId, "acceptForSession");
    });
    try {
      const pid = host.manager.processId;
      host.setRooms([room([a, b, readOnly])]);
      const aRoom = await connect(host, a, roomId);
      clients.push(aRoom);
      const bRoom = await connect(host, b, roomId);
      clients.push(bRoom);
      const aPrivate = await connect(host, a);
      clients.push(aPrivate);
      const bPrivate = await connect(host, b);
      clients.push(bPrivate);
      const aEmpty = await call(aRoom, "zenx_board_read", { view: "document" });
      assert.equal(aEmpty.exists, false);
      assert.equal(
        (
          await call(aRoom, "zenx_board_put", {
            snapshot: aEmpty.snapshot,
            document: body("Shared version 1 from A"),
          })
        ).applied,
        true,
      );
      const readOnlyRoom = await connect(host, readOnly, roomId);
      clients.push(readOnlyRoom);
      const readOnlyView = await call(readOnlyRoom, "zenx_board_read", {
        view: "document",
      });
      assert.equal(readOnlyView.document.title, "Shared version 1 from A");
      // The shared workspace does not preserve a member's revoked execution permissions.
      await host.manager.request("thread/permissions/update", {
        threadId: readOnly,
        sandbox: "read-only",
      });
      const denied = await readOnlyRoom.callTool({
        name: "zenx_board_put",
        arguments: {
          snapshot: readOnlyView.snapshot,
          document: body("Read-only member cannot write"),
        },
      });
      assert.equal(denied.isError, true);
      assert.match(
        output(denied),
        /read.only|permission|sandbox|changed|retired|revoked|aborted/i,
      );
      const aVersion1 = await call(aRoom, "zenx_board_read", {
        view: "document",
      });

      // RED on reviewed launcher469: the package rejects this current member as
      // "Board belongs to a different execution member" after A created the body.
      const bVersion1 = await call(bRoom, "zenx_board_read", {
        view: "document",
      });
      assert.equal(bVersion1.document.title, "Shared version 1 from A");
      assert.equal(
        (
          await call(bRoom, "zenx_board_put", {
            snapshot: bVersion1.snapshot,
            document: body("Shared version 2 from B"),
          })
        ).applied,
        true,
      );
      const staleA = await call(aRoom, "zenx_board_put", {
        snapshot: aVersion1.snapshot,
        document: body("Stale A must not overwrite B"),
      });
      assert.equal(staleA.applied, false);
      assert.equal(
        (await call(aRoom, "zenx_board_read", { view: "document" })).document
          .title,
        "Shared version 2 from B",
      );

      await assert.rejects(
        connect(host, outsider, roomId),
        /Room member|Room membership/i,
      );
      for (const [client, title] of [
        [aPrivate, "A private Board"],
        [bPrivate, "B private Board"],
      ] as const) {
        const empty = await call(client, "zenx_board_read", {
          view: "document",
        });
        assert.equal(
          empty.exists,
          false,
          "Room body does not become a Thread-private default",
        );
        assert.equal(
          (
            await call(client, "zenx_board_put", {
              snapshot: empty.snapshot,
              document: body(title),
            })
          ).applied,
          true,
        );
      }
      assert.equal(
        (await call(aPrivate, "zenx_board_read", { view: "document" })).document
          .title,
        "A private Board",
      );
      assert.equal(
        (await call(bPrivate, "zenx_board_read", { view: "document" })).document
          .title,
        "B private Board",
      );
      assert.equal(
        (await call(bRoom, "zenx_board_read", { view: "document" })).document
          .title,
        "Shared version 2 from B",
      );

      // Removing the first author cannot remove or transfer workspace body ownership.
      host.setRooms([room([b])]);
      const bWithoutA = await call(bRoom, "zenx_board_read", {
        view: "document",
      });
      assert.equal(bWithoutA.document.title, "Shared version 2 from B");
      assert.equal(
        (
          await call(bRoom, "zenx_board_put", {
            snapshot: bWithoutA.snapshot,
            document: body("Shared version 3 without original author"),
          })
        ).applied,
        true,
      );
      host.setRooms([room([a, b])]);
      assert.equal(
        (
          await aRoom.callTool({
            name: "zenx_board_read",
            arguments: { view: "document" },
          })
        ).isError,
        true,
        "Rejoining does not revive A's retired binding",
      );
      const freshA = await connect(host, a, roomId);
      clients.push(freshA);
      assert.equal(
        (await call(freshA, "zenx_board_read", { view: "document" })).document
          .title,
        "Shared version 3 without original author",
      );

      const bLatest = await call(bRoom, "zenx_board_read", {
        view: "document",
      });
      const dispatchesBeforeRevocation = bBoardDispatches;
      holdNextBWrite = true;
      const observed = new Promise<ApprovalRequestEvent>((resolve) => {
        heldApproval = resolve;
      });
      const pending = bRoom.callTool({
        name: "zenx_board_put",
        arguments: {
          snapshot: bLatest.snapshot,
          document: body("Revoked B write must not dispatch"),
        },
      });
      const approval = await observed;
      assert.equal(
        bBoardDispatches,
        dispatchesBeforeRevocation,
        "Pending approval has not dispatched a Board provider call",
      );
      assert(
        host.manager.pendingApprovalRequests.some(
          (event) => event.requestId === approval.requestId,
        ),
      );
      const resolved = new Promise<void>((resolve) => {
        const stop = host.manager.onApprovalResolved((event) => {
          if (event.requestId === approval.requestId) {
            stop();
            resolve();
          }
        });
      });
      host.setRooms([room([a])]);
      const cancelled = await pending;
      assert.equal(cancelled.isError, true);
      assert.match(output(cancelled), /Room member|retired|cancel|aborted/i);
      await resolved;
      assert.equal(
        bBoardDispatches,
        dispatchesBeforeRevocation,
        "Room loss cancelled the real Host invocation before provider dispatch",
      );
      assert.throws(
        () => host.manager.respondToApproval(approval.requestId, "accept"),
        /no longer pending/,
      );
      host.setRooms([room([a, b])]);
      assert.equal(
        (
          await bRoom.callTool({
            name: "zenx_board_read",
            arguments: { view: "document" },
          })
        ).isError,
        true,
        "Rejoining does not revive B's retired binding",
      );
      const freshB = await connect(host, b, roomId);
      clients.push(freshB);
      assert.equal(
        (await call(freshB, "zenx_board_read", { view: "document" })).document
          .title,
        "Shared version 3 without original author",
      );
      assert.equal(
        (await call(aPrivate, "zenx_board_read", { view: "document" })).document
          .title,
        "A private Board",
      );
      assert.equal(
        (await call(bPrivate, "zenx_board_read", { view: "document" })).document
          .title,
        "B private Board",
      );
      assert.equal(
        host.manager.processId,
        pid,
        "Every client used the already-running actual Desktop child",
      );
    } finally {
      stopApprovals();
    }
  },
);
