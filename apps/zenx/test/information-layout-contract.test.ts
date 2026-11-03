import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelReferenceRegistry } from "../../../src/model-references.js";
import { FileTraceStore } from "../../../src/trace.js";
import type { ToolInvocation } from "../../../src/tool.js";
import {
  applyInformationOperations,
  bindInformationEdits,
  defaultInformationLayout,
  informationPage,
  parseInformationLayout,
} from "../src/information-layout.js";
import {
  applySidebarPatch,
  emptySidebarState,
  type ThreadSidebarPort,
} from "../src/thread-sidebar-state.js";
import {
  ThreadSidebarStore,
  sidebarOwnerFile,
  sidebarTracePartition,
} from "../src/main/thread-sidebar-store.js";
import type { SidebarRoom } from "../src/main/sidebar-tool-scope.js";
import {
  ZenXSelfControlCapabilityPackage,
  type AppServerRequestPort,
} from "../src/main/capabilities/self-control-package.js";
import { ZenXProjectProjection } from "../src/main/project-projection.js";
import { invokeModelToolFacade } from "../src/main/capabilities/model-tool-facade.js";
import { sidebarModelDefinition } from "../src/main/capabilities/model-sidebar-facade.js";

const caller = "RAW-caller";
const other = "RAW-other";
const roomId = "RAW-room";
const threadOwner = { kind: "thread" as const, id: caller };
const roomOwner = { kind: "room" as const, id: roomId };
const room = (): SidebarRoom => ({
  id: roomId,
  name: "Synthetic PAW",
  assistant: { threadId: caller },
  members: [{ threadId: caller }, { threadId: other }],
});
type Reply = {
  snapshot: string;
  applied?: boolean;
  status?: string;
  scope: { kind: string; ref: string };
  authorizedScopes: Array<{ kind: string; ref: string }>;
  information: {
    availability: string;
    content: string;
    hasMore: boolean;
    total: number;
    cursor: string | null;
    widgets: Array<{
      ref: string;
      type: string;
      editable: boolean;
      visible: boolean;
      collapsed: boolean;
      config?: Record<string, unknown>;
    }>;
  };
};
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "information-contract-"));
  const store = new ThreadSidebarStore(directory);
  let rooms: SidebarRoom[] = [];
  let beforeUpdate: (() => void) | undefined;
  const requests: Array<{ method: string; params: unknown }> = [];
  const port: ThreadSidebarPort = {
    read: store.read.bind(store),
    update(request, admit, source) {
      beforeUpdate?.();
      return store.update(request, admit, source);
    },
  };
  const capability = new ZenXSelfControlCapabilityPackage({
    sidebar: port,
    sidebarRooms: () => rooms,
    appServer: {
      projectProjection: new ZenXProjectProjection(),
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        assert.equal(
          method,
          "thread/read",
          "Layout access must not execute a provider or start a Turn",
        );
        assert.deepEqual(params, { threadId: caller, includeTurns: false });
        return {};
      },
    } as AppServerRequestPort,
  });
  const references = new ModelReferenceRegistry();
  let callId = 0;
  async function call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Reply> {
    const result = await invokeModelToolFacade({
      epoch: "contract-epoch",
      references,
      invocation: {
        name,
        arguments: args,
        threadId: caller,
        callId: `test-${++callId}`,
        cwd: directory,
        signal: new AbortController().signal,
      },
      dispatch: async (invocation) => ({
        output: JSON.stringify(await capability.invoke(name, invocation)),
        exitCode: 0,
      }),
    });
    return JSON.parse(result.output) as Reply;
  }
  return {
    directory,
    store,
    capability,
    references,
    requests,
    setRooms(value: SidebarRoom[]) {
      rooms = value;
    },
    onUpdate(action: () => void) {
      beforeUpdate = action;
    },
    read: (args: Record<string, unknown> = {}) =>
      call("zenx_self_control_sidebar_read", {
        includeInformation: true,
        ...args,
      }),
    edit: (snapshot: string, operations: unknown[]) =>
      call("zenx_self_control_sidebar_update", {
        snapshot,
        patch: { information: { operations } },
      }),
    call,
    async close() {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("defaults are pure, owner-typed, and do not materialize legacy state", async () => {
  const f = await fixture();
  try {
    const first = await f.read();
    assert.equal(first.scope.kind, "thread");
    assert.equal(first.information.content, "not-read");
    assert.equal(first.information.availability, "not-observed");
    assert.equal(first.information.widgets.length, 6);
    assert.equal((await f.store.read(threadOwner)).revision, 0);
    assert.equal(
      Object.hasOwn(await f.store.read(threadOwner), "informationLayout"),
      false,
    );
    assert.deepEqual(await readdir(f.directory), []);
    assert.deepEqual(await f.read(), first);
    assert.equal(defaultInformationLayout(roomOwner).widgets.length, 2);
    const paw = defaultInformationLayout(roomOwner, caller);
    assert.equal(paw.widgets.length, 7);
    const lineage = paw.widgets.find((widget) => widget.type === "lineage")!;
    assert.deepEqual(lineage.binding, {
      kind: "member",
      resourceThreadId: caller,
    });
    assert.throws(
      () =>
        applySidebarPatch(emptySidebarState(threadOwner), {
          informationLayout: paw,
        }),
      /binding|Room information/,
    );
  } finally {
    await f.close();
  }
});

test("actual facade and native tool edit the same store with CAS; unseen instances survive", async () => {
  const f = await fixture();
  try {
    const first = await f.read({ pageSize: 1 });
    assert.equal(first.information.hasMore, true);
    const ref = first.information.widgets[0]!.ref;
    const [a, b] = await Promise.all([
      f.edit(first.snapshot, [{ op: "set", id: ref, visible: false }]),
      f.edit(first.snapshot, [{ op: "set", id: ref, collapsed: true }]),
    ]);
    assert.equal([a, b].filter((reply) => reply.applied).length, 1);
    const saved = await f.store.read(threadOwner);
    assert.equal(saved.revision, 1);
    assert.equal(saved.informationLayout?.widgets.length, 6);
    assert.deepEqual(saved.tabs, []);
    assert.equal(saved.open, false);
    assert.equal(saved.fullscreen, false);
    assert.equal(saved.resourceThreadId, null);
    assert.equal(saved.informationLayout?.widgets[1]?.visible, true);
    assert.equal(JSON.stringify(b).includes("informationLayout"), false);
    assert.ok(f.requests.every(({ method }) => method === "thread/read"));
  } finally {
    await f.close();
  }
});

test("add mints identity/binding, typed configuration and local moves preserve other cards", async () => {
  const f = await fixture();
  try {
    f.setRooms([room()]);
    const first = await f.read();
    assert.equal(first.scope.kind, "room");
    let result = await f.edit(first.snapshot, [
      {
        op: "add",
        type: "triggers",
        config: { filter: "timer", showPaused: false },
      },
    ]);
    const stored = await f.store.read(roomOwner);
    const added = stored.informationLayout!.widgets.at(-1)!;
    assert.match(added.id, /^[\da-f-]{36}$/u);
    assert.deepEqual(added.binding, {
      kind: "member",
      resourceThreadId: caller,
    });
    assert.deepEqual(added.config, { filter: "timer", showPaused: false });
    const card = result.information.widgets.at(-1)!;
    result = await f.edit(result.snapshot, [
      { op: "move", id: card.ref, before: result.information.widgets[0]!.ref },
    ]);
    assert.equal(
      (await f.store.read(roomOwner)).informationLayout!.widgets[0]!.id,
      added.id,
    );
    const moved = result.information.widgets[0]!;
    result = await f.edit(result.snapshot, [
      { op: "set", id: moved.ref, config: { showPaused: true } },
    ]);
    assert.deepEqual(result.information.widgets[0]!.config, {
      filter: "timer",
      showPaused: true,
    });
    const beforeBadConfig = (await f.store.read(roomOwner)).revision;
    await assert.rejects(
      f.edit(result.snapshot, [
        {
          op: "set",
          id: result.information.widgets[0]!.ref,
          config: { resourceThreadId: other },
        },
      ]),
      /Unknown information field/,
    );
    assert.equal((await f.store.read(roomOwner)).revision, beforeBadConfig);
    await assert.rejects(
      f.edit(result.snapshot, [
        {
          op: "add",
          type: "triggers",
          binding: { kind: "member", resourceThreadId: other },
        },
      ]),
      /Unsupported model facade field/,
    );
    await assert.rejects(
      f.edit(result.snapshot, [{ op: "add", type: "attention" }]),
      /Unknown information component/,
    );
    const independent = await f.edit(result.snapshot, [
      {
        op: "add",
        type: "board",
        config: { instanceKey: "independent-document" },
      },
    ]);
    const generated = await f.edit(independent.snapshot, [
      { op: "add", type: "board" },
    ]);
    assert.equal(generated.applied, true);
    const placed = (
      await f.store.read(roomOwner)
    ).informationLayout!.widgets.filter((widget) => widget.type === "board");
    assert.equal(placed.length, 3);
    assert.equal(
      new Set(placed.map((widget) => widget.config.instanceKey)).size,
      3,
    );
  } finally {
    await f.close();
  }
});

test("foreign member cards are opaque and only movable, including conflict receipts", async () => {
  const f = await fixture();
  try {
    const r = room();
    r.assistant = { threadId: other };
    f.setRooms([r]);
    const roomRef = f.references
      .scope(caller)
      .bind("rooms", "room", { id: roomId });
    const first = await f.read({ scope: roomRef });
    const foreign = first.information.widgets.find(
      (widget) => !widget.editable,
    )!;
    assert.equal(Object.hasOwn(foreign, "config"), false);
    for (const op of [
      { op: "set", id: foreign.ref, visible: false },
      { op: "remove", id: foreign.ref },
      { op: "reset" },
    ])
      await assert.rejects(
        f.edit(first.snapshot, [op]),
        /another member|Another member/,
      );
    const moved = await f.edit(first.snapshot, [
      { op: "move", id: foreign.ref, before: null },
    ]);
    assert.equal(moved.applied, true);
    const stale = await f.edit(first.snapshot, [
      { op: "move", id: foreign.ref, before: null },
    ]);
    assert.equal(stale.applied, false);
    assert.ok(
      stale.information.widgets
        .filter((widget) => !widget.editable)
        .every((widget) => !Object.hasOwn(widget, "config")),
    );
    assert.equal(JSON.stringify(stale).includes(other), false);
    assert.equal(JSON.stringify(moved).includes(roomId), false);
  } finally {
    await f.close();
  }
});

test("private/PAW/ordinary Room scopes remain distinct and ambiguous PAWs do not guess", async () => {
  const f = await fixture();
  try {
    f.setRooms([room()]);
    const paw = await f.read();
    const privateThread = await f.read({ scope: "self" });
    assert.equal(paw.scope.kind, "room");
    assert.equal(privateThread.scope.kind, "thread");
    await assert.rejects(
      f.edit(paw.snapshot, [
        {
          op: "move",
          id: privateThread.information.widgets[0]!.ref,
          before: null,
        },
      ]),
      /another scope/,
    );
    f.setRooms([{ ...room(), assistant: undefined }]);
    assert.equal((await f.read()).scope.kind, "thread");
    f.setRooms([room(), { ...room(), id: "other-room" }]);
    assert.equal((await f.read()).status, "ambiguous");
    const scope = f.references
      .scope(caller)
      .bind("rooms", "room", { id: "not-a-member" });
    await assert.rejects(f.read({ scope }), /currently belong/);
  } finally {
    await f.close();
  }
});

test("membership and default binding revalidate at actual store admission", async () => {
  const f = await fixture();
  try {
    f.setRooms([room()]);
    const first = await f.read();
    f.onUpdate(() => f.setRooms([]));
    await assert.rejects(
      f.edit(first.snapshot, [{ op: "add", type: "triggers" }]),
      /currently belong/,
    );
    assert.equal((await f.store.read(roomOwner)).revision, 0);
    f.setRooms([room()]);
    f.onUpdate(() =>
      f.setRooms([{ ...room(), assistant: { threadId: other } }]),
    );
    await assert.rejects(
      f.edit(first.snapshot, [{ op: "add", type: "triggers" }]),
      /default binding changed/,
    );
    assert.equal((await f.store.read(roomOwner)).revision, 0);
  } finally {
    await f.close();
  }
});

test("read cursors reject changed revisions and changed unpersisted PAW bindings", async () => {
  const f = await fixture();
  try {
    f.setRooms([room()]);
    let first = await f.read({ pageSize: 1 });
    assert.ok(first.information.cursor);
    f.setRooms([{ ...room(), assistant: { threadId: other } }]);
    await assert.rejects(
      f.read({ cursor: first.information.cursor }),
      /layout changed/,
    );
    f.setRooms([room()]);
    first = await f.read({ pageSize: 1 });
    await f.edit(first.snapshot, [{ op: "add", type: "triggers" }]);
    await assert.rejects(
      f.read({ cursor: first.information.cursor }),
      /layout changed/,
    );
    await assert.rejects(
      f.read({ cursor: first.information.cursor, scope: "self" }),
      /already binds/,
    );
  } finally {
    await f.close();
  }
});

test("more than 256 widgets remain reachable across pages; partial reads cannot replace a layout", async () => {
  const f = await fixture();
  try {
    const first = await f.read();
    const result = await f.edit(
      first.snapshot,
      Array.from({ length: 300 }, () => ({ op: "add", type: "triggers" })),
    );
    assert.equal(result.applied, true);
    assert.equal(result.information.total, 306);
    let page = await f.read({ pageSize: 17 });
    const snapshot = page.snapshot;
    const target = page.information.widgets[0]!.ref;
    const refs = new Set<string>();
    for (;;) {
      for (const widget of page.information.widgets) refs.add(widget.ref);
      if (!page.information.cursor) break;
      page = await f.read({ cursor: page.information.cursor, pageSize: 17 });
    }
    assert.equal(refs.size, 306);
    await f.edit(snapshot, [{ op: "set", id: target, collapsed: true }]);
    assert.equal(
      (await f.store.read(threadOwner)).informationLayout!.widgets.length,
      306,
    );
    await assert.rejects(
      f.call("zenx_self_control_sidebar_update", {
        snapshot,
        patch: { informationLayout: { version: 1, widgets: [] } },
      }),
      /Unsupported model facade field/,
    );
    await assert.rejects(
      f.call("zenx_self_control_sidebar_update", {
        snapshot,
        patch: { information: { widgets: [] } },
      }),
      /Unsupported model facade field/,
    );
    const native = f.capability.manifest.tools.find(
      (tool) => tool.name === "zenx_self_control_sidebar_update",
    )!;
    const schema = sidebarModelDefinition(native).inputSchema as {
      properties: { patch: { properties: { information: unknown } } };
    };
    assert.equal(
      JSON.stringify(schema.properties.patch.properties.information).includes(
        "maxItems",
      ),
      false,
    );
  } finally {
    await f.close();
  }
});

test("reset restores placements without deleting custom content references or rebinding", () => {
  const defaults = defaultInformationLayout(threadOwner);
  const initial = bindInformationEdits(
    {
      operations: [
        { op: "add", type: "triggers", config: { filter: "timer" } },
      ],
    },
    {
      owner: threadOwner,
      callerThreadId: caller,
      current: defaults,
      defaults,
      newId: () => "authored-instance",
    },
  );
  const added = applyInformationOperations(defaults, { operations: initial });
  const configured = applyInformationOperations(added, {
    operations: [
      {
        op: "set",
        id: "default:triggers",
        config: { filter: "event", showPaused: false },
        visible: false,
      },
      { op: "move", id: "authored-instance", before: "default:pull-requests" },
    ],
  });
  const restored = applyInformationOperations(configured, {
    operations: [{ op: "reset", defaults }],
  });
  assert.equal(restored.widgets.at(-1)!.id, "authored-instance");
  assert.equal(restored.widgets.at(-1)!.visible, false);
  assert.deepEqual(
    restored.widgets.find((widget) => widget.id === "default:triggers")!.config,
    { filter: "event", showPaused: false },
  );
  assert.throws(
    () =>
      parseInformationLayout({
        version: 1,
        widgets: [defaults.widgets[0], defaults.widgets[0]],
      }),
    /Duplicate/,
  );
  assert.throws(
    () =>
      applyInformationOperations(defaults, {
        operations: [{ op: "add", widget: defaults.widgets[0]!, before: null }],
      }),
    /already exists/,
  );
  assert.throws(
    () =>
      applyInformationOperations(defaults, {
        operations: [
          {
            op: "set",
            id: "default:triggers",
            config: { filter: "all", showPaused: true, owner: other },
          },
        ],
      }),
    /Unknown information field/,
  );
});

test("reset reuses a re-added legacy Board placement instead of duplicating its document", () => {
  const defaults = defaultInformationLayout(threadOwner);
  const edit = (current: typeof defaults, operations: unknown[]) =>
    applyInformationOperations(current, {
      operations: bindInformationEdits(
        { operations },
        {
          owner: threadOwner,
          callerThreadId: caller,
          current,
          defaults,
          newId: () => "host-board-instance",
        },
      ),
    });
  const readded = edit(defaults, [
    { op: "remove", id: "default:board" },
    { op: "add", type: "board" },
    { op: "set", id: "host-board-instance", visible: false },
  ]);
  const restored = edit(readded, [{ op: "reset" }]);
  const boards = restored.widgets.filter((widget) => widget.type === "board");
  assert.equal(boards.length, 1);
  assert.equal(boards[0]!.id, "host-board-instance");
  assert.equal(boards[0]!.visible, true);
  assert.deepEqual(boards[0]!.binding, { kind: "owner" });
  assert.deepEqual(boards[0]!.config, { instanceKey: "default" });
  assert.deepEqual(parseInformationLayout(restored), restored);
  assert.equal(
    edit(restored, [
      { op: "set", id: "host-board-instance", visible: true },
    ]).widgets.filter((widget) => widget.type === "board").length,
    1,
  );
  const duplicate = {
    version: 1 as const,
    widgets: [...defaults.widgets, boards[0]!],
  };
  assert.throws(
    () => parseInformationLayout(duplicate),
    /Duplicate Board document placement/,
  );
  assert.throws(
    () =>
      applyInformationOperations(undefined, {
        initial: duplicate,
        operations: [{ op: "reset", defaults }],
      }),
    /Duplicate Board document placement/,
  );
  assert.throws(
    () =>
      applyInformationOperations(defaults, {
        operations: [{ op: "reset", defaults: duplicate }],
      }),
    /Duplicate Board document placement/,
  );
  assert.throws(
    () =>
      applyInformationOperations(defaults, {
        operations: [{ op: "add", widget: boards[0]!, before: null }],
      }),
    /Duplicate Board document placement/,
  );
});

test("old Trace absent fields replay unchanged, then exact information ops survive restart", async () => {
  const f = await fixture();
  try {
    await f.store.update({
      owner: threadOwner,
      expectedRevision: 0,
      patch: { open: true },
    });
    let restarted = new ThreadSidebarStore(f.directory);
    const old = await restarted.read(threadOwner);
    assert.equal(old.revision, 1);
    assert.equal(Object.hasOwn(old, "informationLayout"), false);
    await restarted.close();
    const first = await f.read();
    await f.edit(first.snapshot, [
      { op: "set", id: first.information.widgets[0]!.ref, visible: false },
    ]);
    const saved = await f.store.read(threadOwner);
    restarted = new ThreadSidebarStore(f.directory);
    assert.deepEqual(await restarted.read(threadOwner), saved);
    await restarted.close();
  } finally {
    await f.close();
  }
});

test("Room first-edit defaults replay from Trace without rebinding to today's assistant", async () => {
  const f = await fixture();
  try {
    f.setRooms([room()]);
    const first = await f.read();
    const lineage = first.information.widgets.find(
      (widget) => widget.type === "lineage",
    )!;
    await f.edit(first.snapshot, [
      { op: "set", id: lineage.ref, collapsed: true },
    ]);
    const saved = await f.store.read(roomOwner);
    const trace = new FileTraceStore(path.join(f.directory, "trace"));
    const history = await trace.read(sidebarTracePartition(roomOwner));
    assert.equal(history.records.length, 1);
    const fact = history.records[0]!.data as {
      patch: { informationLayout: { initial: unknown } };
    };
    assert.deepEqual(
      fact.patch.informationLayout.initial,
      defaultInformationLayout(roomOwner, caller),
    );
    f.setRooms([{ ...room(), assistant: { threadId: other } }]);
    const afterChange = await f.read({ scope: first.scope.ref });
    assert.equal(
      afterChange.information.widgets.find(
        (widget) => widget.type === "lineage",
      )!.editable,
      true,
    );
    await f.store.close();
    await rm(sidebarOwnerFile(f.directory, roomOwner));
    const restarted = new ThreadSidebarStore(f.directory);
    try {
      const restored = await restarted.read(roomOwner);
      assert.deepEqual(restored, saved);
      assert.deepEqual(
        restored.informationLayout!.widgets.find(
          (widget) => widget.type === "lineage",
        )!.binding,
        {
          kind: "member",
          resourceThreadId: caller,
        },
      );
      assert.equal(
        (await trace.read(sidebarTracePartition(roomOwner))).records.length,
        1,
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await f.close();
  }
});

test("bundled and installed schemas remain exact mechanical mirrors", async () => {
  const f = await fixture();
  try {
    const ordinary = JSON.parse(
      await readFile(
        new URL(
          "../../../packages/zenx-self-control-plugin/zenx.plugin.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    for (const native of f.capability.manifest.tools)
      assert.deepEqual(
        ordinary.tools.find(
          (tool: { name: string }) => tool.name === native.name,
        )?.inputSchema,
        native.inputSchema,
      );
    const originalPermissions = f.capability.manifest.tools
      .filter((tool) => tool.name.startsWith("zenx_self_control_sidebar_"))
      .map((tool) => tool.permissions);
    assert.deepEqual(originalPermissions, [
      ["zenx-self-control.workspace-read"],
      ["zenx-self-control.local-device-control"],
    ]);
  } finally {
    await f.close();
  }
});

test("native tool rejects raw full replacement and forged bindings, without provider calls", async () => {
  const f = await fixture();
  const invoke = (args: Record<string, unknown>) =>
    f.capability.invoke("zenx_self_control_sidebar_update", {
      name: "zenx_self_control_sidebar_update",
      arguments: args,
      threadId: caller,
      cwd: f.directory,
      callId: "native-contract",
      signal: new AbortController().signal,
    } satisfies ToolInvocation);
  try {
    await assert.rejects(
      invoke({
        expectedRevision: 0,
        patch: { informationLayout: defaultInformationLayout(threadOwner) },
      }),
      /never full layout replacement/,
    );
    const rawRead = (await f.capability.invoke(
      "zenx_self_control_sidebar_read",
      {
        name: "zenx_self_control_sidebar_read",
        arguments: { includeInformation: true },
        threadId: caller,
        cwd: f.directory,
        callId: "native-read",
        signal: new AbortController().signal,
      } satisfies ToolInvocation,
    )) as { information: { basis: string } };
    const modelRead = await f.read();
    for (const information of [
      { operations: [{ op: "add", type: "lineage", id: "forged" }] },
      {
        operations: [
          {
            op: "add",
            type: "lineage",
            binding: { kind: "member", resourceThreadId: other },
          },
        ],
      },
      {
        operations: [{ op: "add", type: "lineage" }],
        initial: defaultInformationLayout(threadOwner),
      },
    ]) {
      await assert.rejects(
        invoke({
          expectedRevision: 0,
          informationBase: rawRead.information.basis,
          patch: { information },
        }),
        /Unknown information field/,
      );
      await assert.rejects(
        f.call("zenx_self_control_sidebar_update", {
          snapshot: modelRead.snapshot,
          patch: { information },
        }),
        /Unsupported model facade field/,
      );
      assert.equal((await f.store.read(threadOwner)).revision, 0);
    }
    await assert.rejects(
      f.call("zenx_self_control_sidebar_update", {
        snapshot: modelRead.snapshot,
        patch: { informationLayout: defaultInformationLayout(threadOwner) },
      }),
      /Unsupported model facade field/,
    );
    assert.equal((await f.store.read(threadOwner)).revision, 0);
    assert.equal(
      informationPage(defaultInformationLayout(threadOwner), 0, caller, {
        pageSize: 1000,
      }).widgets.length,
      6,
    );
    assert.ok(f.requests.every(({ method }) => method === "thread/read"));
  } finally {
    await f.close();
  }
});
