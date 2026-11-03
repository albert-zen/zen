import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ApprovalRequestEvent } from "../src/main/app-server-manager.js";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { createLiveUserMcpHost } from "./fixtures/live-user-mcp-host.js";

const read = "zenx_self_control_sidebar_read";
const update = "zenx_self_control_sidebar_update";
function text(result: any): string {
  return result.content
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
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
async function rejected(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  pattern: RegExp,
) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true);
  assert.match(text(result), pattern);
}
async function connect(
  host: Awaited<ReturnType<typeof createLiveUserMcpHost>>,
  thread: string,
  room?: string,
) {
  const built = process.env.ZEN_MCP_TEST_USE_BUILT === "1";
  const root = path.dirname(path.dirname(host.descriptorFile));
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
      thread,
      ...(room ? ["--room", room] : []),
    ],
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { PATH: process.env.PATH!, HOME: root, TMPDIR: root },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({
    name: "room-layout-sdk-acceptance",
    version: "1",
  });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await transport.close();
    throw new Error(`Existing Host connection failed: ${stderr}`, {
      cause: error,
    });
  }
}
async function information(client: Client, pageSize?: number) {
  const first = await call(client, read, {
    includeInformation: true,
    ...(pageSize ? { pageSize } : {}),
  });
  assert.equal(first.information.content, "not-read");
  assert.equal(first.information.availability, "not-observed");
  const widgets = [...first.information.widgets];
  let cursor = first.information.cursor;
  while (cursor) {
    const page = await call(client, read, {
      cursor,
      ...(pageSize ? { pageSize } : {}),
    });
    assert.equal(
      page.snapshot,
      first.snapshot,
      "All pages bind the same immutable revision and defaults basis",
    );
    assert.equal(page.information.offset, widgets.length);
    widgets.push(...page.information.widgets);
    cursor = page.information.cursor;
  }
  assert.equal(widgets.length, first.information.total);
  return { ...first, information: { ...first.information, widgets } };
}
const edit = (client: Client, snapshot: string, operations: unknown[]) =>
  call(client, update, { snapshot, patch: { information: { operations } } });
const shape = (value: any) =>
  value.information.widgets.map(
    ({ type, visible, collapsed, editable, config }: any) => ({
      type,
      visible,
      collapsed,
      editable,
      ...(config === undefined ? {} : { config }),
    }),
  );

test(
  "real SDK Room layout supports paged add/set/move/remove with CAS, fixed-owner isolation and revoked approval fencing",
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zen-mcp-room-layout-"));
    const clients: Client[] = [];
    let host: Awaited<ReturnType<typeof createLiveUserMcpHost>> | undefined;
    t.after(async () => {
      await Promise.allSettled(clients.map((client) => client.close()));
      try {
        await host?.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    host = await createLiveUserMcpHost(root, {
      environment: { PATH: process.env.PATH!, HOME: root, TMPDIR: root },
    });
    const existing = host;
    const a = host.threadId;
    const b = (
      await host.manager.request("thread/start", {
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
      })
    ).thread.id;
    const outsider = (
      await host.manager.request("thread/start", {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      })
    ).thread.id;
    const room = (id: string, members: string[]) => ({
      id,
      name: id,
      createdAt: 0,
      operationEpoch: "synthetic-layout-fixture",
      members: members.map((threadId) => ({
        threadId,
        name: threadId === a ? "A" : "B",
      })),
      messages: [],
    });
    let members = [a, b];
    const rooms = () => [room("room-one", members), room("room-two", [a])];
    host.setRooms(rooms());
    let hold = false;
    let held: ((event: ApprovalRequestEvent) => void) | undefined;
    const stopApprovals = host.manager.onApprovalRequest((event) => {
      if (
        hold &&
        event.params.threadId === b &&
        event.params.toolName === update
      ) {
        hold = false;
        held?.(event);
      } else
        existing.manager.respondToApproval(event.requestId, "acceptForSession");
    });
    t.after(stopApprovals);
    let dispatches = 0;
    let sidebarCalls = 0;
    const execute = ZenXCapabilityService.prototype.execute;
    t.mock.method(
      ZenXCapabilityService.prototype,
      "execute",
      function (
        this: ZenXCapabilityService,
        ...args: Parameters<ZenXCapabilityService["execute"]>
      ) {
        if ([read, update].includes(args[0].name)) sidebarCalls++;
        if (args[0].name === update) dispatches++;
        return Reflect.apply(execute, this, args);
      },
    );
    const pid = host.manager.processId;
    const history = await host.manager.request("zen/thread/read", {
      threadId: a,
    });
    const aRoom = await connect(host, a, "room-one");
    clients.push(aRoom);
    const bRoom = await connect(host, b, "room-one");
    clients.push(bRoom);
    const other = await connect(host, a, "room-two");
    clients.push(other);
    const privateA = await connect(host, a);
    clients.push(privateA);
    await assert.rejects(
      connect(host, outsider, "room-one"),
      /Room member|membership/i,
    );
    const schema = (await aRoom.listTools()).tools.find(
      (tool) => tool.name === read,
    )!.inputSchema;
    assert.deepEqual(Object.keys(schema.properties!).sort(), [
      "cursor",
      "includeInformation",
      "pageSize",
    ]);
    const first = await information(aRoom, 1);
    assert.deepEqual(
      first.information.widgets.map((w: any) => w.type),
      ["room-members", "board"],
    );
    assert.match(first.information.cursor, /^mcp:[^:]+:r[1-9][0-9]*$/);
    const plain = await call(aRoom, read);
    await rejected(
      aRoom,
      update,
      {
        snapshot: plain.snapshot,
        patch: {
          information: { operations: [{ op: "add", type: "triggers" }] },
        },
      },
      /includeInformation/,
    );
    const untouchedOther = shape(await information(other, 1));
    const untouchedPrivate = shape(await information(privateA));
    const add = await edit(aRoom, first.snapshot, [
      {
        op: "add",
        type: "triggers",
        config: { filter: "timer", showPaused: false },
      },
      { op: "add", type: "board", config: { instanceKey: "r7" } },
    ]);
    assert.equal(add.applied, true);
    await rejected(
      aRoom,
      read,
      { cursor: first.information.cursor },
      /layout changed|fresh read/,
    );
    let current = await information(aRoom, 1);
    assert.equal(current.information.total, 4);
    const trigger = current.information.widgets.find(
      (w: any) => w.type === "triggers",
    );
    const extra = current.information.widgets.find(
      (w: any) => w.type === "board" && w.config.instanceKey === "r7",
    );
    assert.equal(
      extra.config.instanceKey,
      "r7",
      "Authored rN-looking configuration is literal, not a reference",
    );
    assert.equal(
      (
        await edit(aRoom, current.snapshot, [
          {
            op: "set",
            id: trigger.ref,
            collapsed: true,
            config: { filter: "event", showPaused: true },
          },
          {
            op: "move",
            id: extra.ref,
            before: current.information.widgets[0].ref,
          },
        ])
      ).applied,
      true,
    );
    current = await information(aRoom, 1);
    assert.equal(current.information.widgets[0].config.instanceKey, "r7");
    assert.deepEqual(
      current.information.widgets.find((w: any) => w.type === "triggers")
        .config,
      { filter: "event", showPaused: true },
    );
    assert.equal(
      current.information.widgets.find((w: any) => w.type === "triggers")
        .collapsed,
      true,
    );

    // A current peer sees shared owner widgets, but no foreign Thread component configuration.
    let peer = await information(bRoom, 1);
    const foreign = peer.information.widgets.find(
      (w: any) => w.type === "triggers",
    );
    assert.equal(foreign.editable, false);
    assert.equal(Object.hasOwn(foreign, "config"), false);
    for (const operation of [
      { op: "set", id: foreign.ref, collapsed: false },
      { op: "remove", id: foreign.ref },
      { op: "reset" },
    ])
      await rejected(
        bRoom,
        update,
        {
          snapshot: peer.snapshot,
          patch: { information: { operations: [operation] } },
        },
        /another member/i,
      );
    assert.equal(
      (
        await edit(bRoom, peer.snapshot, [
          {
            op: "move",
            id: foreign.ref,
            before: peer.information.widgets[0].ref,
          },
        ])
      ).applied,
      true,
    );
    peer = await information(bRoom);
    assert.equal(peer.information.widgets[0].type, "triggers");

    // True concurrent CAS: both clients hold the same native revision; exactly one wins.
    const [baseA, baseB] = await Promise.all([
      information(aRoom),
      information(bRoom),
    ]);
    const [raceA, raceB] = await Promise.all([
      edit(aRoom, baseA.snapshot, [
        { op: "add", type: "board", config: { instanceKey: "race-a" } },
      ]),
      edit(bRoom, baseB.snapshot, [
        { op: "add", type: "board", config: { instanceKey: "race-b" } },
      ]),
    ]);
    assert.deepEqual([raceA.applied, raceB.applied].sort(), [false, true]);
    current = await information(aRoom, 1);
    assert.equal(
      current.information.total,
      5,
      "Conflict never overwrites or duplicates a competing edit",
    );
    assert.equal(
      current.information.widgets.filter((w: any) =>
        w.config?.instanceKey?.startsWith("race-"),
      ).length,
      1,
    );
    const remove = current.information.widgets.find(
      (w: any) => w.config?.instanceKey === "r7",
    );
    assert.equal(
      (await edit(aRoom, current.snapshot, [{ op: "remove", id: remove.ref }]))
        .applied,
      true,
    );
    const beforeAttacks = shape(await information(aRoom));

    // Both scopes are legitimately accessible to A. Transport refs still cannot alias across bindings.
    const otherPage = await call(other, read, {
      includeInformation: true,
      pageSize: 1,
    });
    const local = await information(aRoom, 1);
    const beforeDispatch = dispatches;
    const beforeSidebarCalls = sidebarCalls;
    await rejected(
      aRoom,
      read,
      { cursor: otherPage.information.cursor },
      /another or retired MCP connection/,
    );
    await rejected(
      other,
      update,
      { snapshot: local.snapshot, patch: { open: true } },
      /another or retired MCP connection/,
    );
    await rejected(
      aRoom,
      update,
      {
        snapshot: local.snapshot,
        patch: {
          information: {
            operations: [
              {
                op: "move",
                id: otherPage.information.widgets[0].ref,
                before: null,
              },
            ],
          },
        },
      },
      /another or retired MCP connection/,
    );
    await rejected(
      aRoom,
      update,
      {
        snapshot: local.snapshot,
        patch: {
          information: {
            operations: [
              {
                op: "remove",
                id: local.information.widgets[0].ref.split(":").at(-1),
              },
            ],
          },
        },
      },
      /another or retired MCP connection/,
    );
    await rejected(
      aRoom,
      read,
      { scope: "self", includeInformation: true },
      /Only bound tool arguments/,
    );
    await rejected(
      aRoom,
      read,
      { cursor: local.information.cursor, includeInformation: false },
      /cursor already binds/,
    );
    assert.equal(
      sidebarCalls,
      beforeSidebarCalls,
      "Invalid cursor/widget refs are rejected before any native read or write",
    );
    assert.equal(
      dispatches,
      beforeDispatch,
      "Rejected cross-connection refs never reach the existing native provider",
    );
    assert.deepEqual(shape(await information(aRoom)), beforeAttacks);
    assert.deepEqual(shape(await information(other)), untouchedOther);
    assert.deepEqual(shape(await information(privateA)), untouchedPrivate);

    const parallelRoom = await connect(host, a, "room-one");
    clients.push(parallelRoom);
    const parallelOther = await connect(host, a, "room-two");
    clients.push(parallelOther);
    const sameNumberLocal = await call(parallelRoom, read, {
      includeInformation: true,
      pageSize: 1,
    });
    const sameNumberForeign = await call(parallelOther, read, {
      includeInformation: true,
      pageSize: 1,
    });
    assert.equal(
      sameNumberLocal.information.widgets[0].ref.split(":").at(-1),
      sameNumberForeign.information.widgets[0].ref.split(":").at(-1),
      "Test must actually create same-number refs for different local widget identities",
    );
    assert.equal(
      sameNumberLocal.information.cursor.split(":").at(-1),
      sameNumberForeign.information.cursor.split(":").at(-1),
    );
    assert.notEqual(
      sameNumberLocal.information.widgets[0].type,
      sameNumberForeign.information.widgets[0].type,
    );
    const beforeCollision = dispatches;
    const beforeCollisionCalls = sidebarCalls;
    await rejected(
      parallelRoom,
      read,
      { cursor: sameNumberForeign.information.cursor },
      /another or retired MCP connection/,
    );
    await rejected(
      parallelRoom,
      update,
      {
        snapshot: sameNumberLocal.snapshot,
        patch: {
          information: {
            operations: [
              {
                op: "remove",
                id: sameNumberForeign.information.widgets[0].ref,
              },
            ],
          },
        },
      },
      /another or retired MCP connection/,
    );
    assert.equal(dispatches, beforeCollision);
    assert.equal(sidebarCalls, beforeCollisionCalls);
    assert.deepEqual(shape(await information(aRoom)), beforeAttacks);
    assert.deepEqual(shape(await information(other)), untouchedOther);

    const currentForRawRefs = await information(aRoom);
    for (const patch of [
      { selectedTab: "r1" },
      { tabs: [{ ref: "r1" }] },
      { tabs: [{ kind: "thread", thread: "r1" }] },
      { tabs: [{ kind: "browser", tab: "r1" }] },
    ])
      await rejected(
        aRoom,
        update,
        { snapshot: currentForRawRefs.snapshot, patch },
        /another or retired MCP connection/,
      );
    for (const field of ["cursor", "turn", "item", "through"])
      await rejected(
        aRoom,
        "zenx_threads_read",
        { [field]: "r1" },
        /another or retired MCP connection/,
      );
    const compactHistory = await call(aRoom, "zenx_threads_read", {
      maxTurns: 1,
      maxItemsPerTurn: 1,
    });
    assert.match(compactHistory.turns[0].turn, /^mcp:[^:]+:r[1-9][0-9]*$/);
    const exactItem = compactHistory.turns[0].items[0].ref;
    assert.match(exactItem, /^mcp:[^:]+:r[1-9][0-9]*$/);
    await call(aRoom, "zenx_threads_read", {
      item: exactItem,
      granularity: "item",
    });

    // Revocation while the existing normal Desktop approval is pending must prevent dispatch.
    peer = await information(bRoom);
    hold = true;
    const observed = new Promise<ApprovalRequestEvent>((resolve) => {
      held = resolve;
    });
    const pending = bRoom.callTool({
      name: update,
      arguments: {
        snapshot: peer.snapshot,
        patch: {
          information: {
            operations: [
              { op: "add", type: "board", config: { instanceKey: "revoked" } },
            ],
          },
        },
      },
    });
    const approval = await observed;
    const beforeRevocation = dispatches;
    const resolved = new Promise<void>((resolve) => {
      const stop = existing.manager.onApprovalResolved((event) => {
        if (event.requestId === approval.requestId) {
          stop();
          resolve();
        }
      });
    });
    members = [a];
    host.setRooms(rooms());
    assert.equal((await pending).isError, true);
    await resolved;
    assert.equal(dispatches, beforeRevocation);
    assert.throws(
      () => existing.manager.respondToApproval(approval.requestId, "accept"),
      /no longer pending/,
    );
    members = [a, b];
    host.setRooms(rooms());
    assert.deepEqual(
      (await bRoom.listTools()).tools,
      [],
      "Rejoining never revives the retired binding or its refs",
    );
    const newB = await connect(host, b, "room-one");
    clients.push(newB);
    await rejected(
      newB,
      read,
      { cursor: local.information.cursor },
      /another or retired MCP connection/,
    );
    assert.equal(
      (await information(newB)).information.total,
      beforeAttacks.length,
    );
    assert.equal(
      (await information(aRoom)).information.widgets.some(
        (w: any) => w.config?.instanceKey === "revoked",
      ),
      false,
    );
    const readOnly = (
      await host.manager.request("thread/start", {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      })
    ).thread.id;
    members = [a, b, readOnly];
    host.setRooms(rooms());
    const readOnlyClient = await connect(host, readOnly, "room-one");
    clients.push(readOnlyClient);
    const readOnlyView = await information(readOnlyClient);
    await host.manager.request("thread/permissions/update", {
      threadId: readOnly,
      sandbox: "read-only",
    });
    const beforeReadOnly = dispatches;
    await rejected(
      readOnlyClient,
      update,
      {
        snapshot: readOnlyView.snapshot,
        patch: {
          information: {
            operations: [
              {
                op: "add",
                type: "board",
                config: { instanceKey: "read-only-must-not-write" },
              },
            ],
          },
        },
      },
      /sandbox|read.only|permission|denied|changed|retired|aborted/i,
    );
    assert.equal(dispatches, beforeReadOnly);
    assert.deepEqual(shape(await information(aRoom)), beforeAttacks);
    assert.deepEqual(
      (await host.manager.request("zen/thread/read", { threadId: a })).thread
        .items,
      history.thread.items,
      "Layout edits create no synthetic Turn or canonical history",
    );
    assert.equal(
      host.manager.processId,
      pid,
      "All calls used the same already-running actual Host",
    );
  },
);
