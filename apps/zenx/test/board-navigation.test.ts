import assert from "node:assert/strict";
import test from "node:test";
import { BoardHostService } from "../src/main/board-host-service.js";
import {
  ZenXBoardCapabilityPackage,
  validateDocument,
} from "../src/main/capabilities/board-package.js";
import { createFixturePluginHost } from "@zenx/plugin-sdk";
import {
  emptySidebarState,
  applySidebarPatch,
  type ThreadSidebarState,
} from "../src/thread-sidebar-state.js";
import { readBrowserSidebarTargets } from "../src/main/capabilities/model-browser-metadata.js";
const owner = { kind: "thread" as const, threadId: "synthetic-thread" };
const route = {
  ownerThreadId: owner.threadId,
  sessionId: "s",
  sessionEpoch: "epoch",
  backend: "workspace",
  tabId: "native-tab",
  targetId: "workspace:exact-target",
};
const signal = () => new AbortController().signal;
function fixture() {
  let state = emptySidebarState({ kind: "thread", id: owner.threadId });
  let live = true;
  let closed = false;
  let conflict = false;
  let writes = 0;
  const host = new BoardHostService({
    appServer: {
      request: async () => assert.fail("No model admission or full read"),
    } as any,
    readThreadSummary: async (threadId) => ({ threadId, archived: false }),
    rooms: {
      roomsAvailable: () => false,
      snapshot: () => ({ rooms: [] }),
      postAddressedRoomMessage: async () => assert.fail("No message"),
    },
    executeTool: async () => assert.fail("No execution"),
    readBrowserModelTarget: async (threadId, id) =>
      live && threadId === owner.threadId && id === route.targetId
        ? route
        : undefined,
    isSidebarIntentClosed: () => closed,
    sidebar: {
      read: async (_owner, admit) => {
        admit?.();
        return structuredClone(state);
      },
      update: async (request, admit) => {
        admit?.();
        writes++;
        if (conflict) return { applied: false, state };
        state = applySidebarPatch(state, request.patch);
        return { applied: true, state };
      },
    },
  });
  return {
    host,
    state: () => state,
    writes: () => writes,
    close: () => {
      live = false;
      closed = true;
    },
    conflict: () => {
      conflict = true;
    },
  };
}
test("typed Board URLs use existing sidebar intent, and explicit URL may create a fresh closed intent", async () => {
  const f = fixture();
  const target = { kind: "url" as const, url: "https://example.test/docs" };
  await f.host.navigate(owner, target, signal());
  const first = f.state().tabs[0]!;
  assert.equal(first.kind, "webpage");
  assert.equal(first.resourceThreadId, owner.threadId);
  await f.host.navigate(owner, target, signal());
  assert.equal(f.state().tabs.length, 1);
  f.close();
  await f.host.navigate(owner, target, signal());
  assert.equal(f.state().tabs.length, 2);
  assert.notDeepEqual(f.state().tabs[0], f.state().tabs[1]);
});
test("existing Board Browser navigation is exact, never resurrects a closed target or substitutes another owner", async () => {
  const f = fixture();
  const target = { kind: "browser" as const, id: route.targetId };
  await f.host.navigate(owner, target, signal());
  assert.equal(f.state().tabs[0]?.kind, "browser");
  f.close();
  await assert.rejects(
    f.host.navigate(owner, target, signal()),
    /not reopened/,
  );
  await assert.rejects(
    f.host.navigate({ kind: "thread", threadId: "foreign" }, target, signal()),
    /not reopened/,
  );
  assert.equal(f.writes(), 1);
});
test("sidebar conflicts are not retried", async () => {
  const f = fixture();
  f.conflict();
  await assert.rejects(
    f.host.navigate(
      owner,
      { kind: "url", url: "https://example.test" },
      signal(),
    ),
    /not applied/,
  );
  assert.equal(f.writes(), 1);
});
const document = {
  id: "board",
  owner,
  title: "Authored",
  summary: "Synthetic",
  blocks: [{ kind: "note", id: "note", text: "Preserved note" }],
  html: "<style>p{color:red}</style><p>authored</p><script>const x=1</script>",
  events: [
    {
      id: "open",
      label: "Open",
      actions: [
        { kind: "navigate", target: { kind: "browser", id: route.targetId } },
      ],
    },
  ],
};
test("full authored read retains every part when an existing navigation target closes", async () => {
  const f = fixture();
  const board = new ZenXBoardCapabilityPackage(f.host);
  board.start(createFixturePluginHost({ pluginId: "zenx-board" }).sdk);
  const invoke = (name: string, args: Record<string, unknown>) =>
    board.invoke(name, {
      name,
      callId: "synthetic",
      cwd: "/synthetic",
      threadId: owner.threadId,
      arguments: args,
      signal: signal(),
    });
  await invoke("zenx_board_put", { document });
  const full = (await invoke("zenx_board_read", { view: "document" })) as any;
  assert.deepEqual(full.document, document);
  assert.deepEqual(readBrowserSidebarTargets(full), [route]);
  f.close();
  const closed = (await invoke("zenx_board_read", { view: "document" })) as any;
  assert.deepEqual(closed.document, document);
  assert.deepEqual(readBrowserSidebarTargets(closed), []);
  const compact = (await invoke("zenx_board_read", {})) as any;
  assert.equal(compact.html, undefined);
  assert.equal(compact.document, undefined);
  assert.match(compact.valuesMeaning, /not approval/);
});
test("untyped routes and unsafe URL schemes cannot enter authored Board navigation", () => {
  for (const action of [
    { kind: "navigate", route: "plugin:arbitrary" },
    { kind: "navigate", target: { kind: "url", url: "javascript:alert(1)" } },
    {
      kind: "navigate",
      target: { kind: "url", url: "https://user:password@example.test" },
    },
  ])
    assert.throws(() =>
      validateDocument({
        ...document,
        events: [{ id: "bad", label: "Bad", actions: [action] }],
      }),
    );
});

test("full document reads distinguish unknown native observation failures and retain local details", async () => {
  const f = fixture();
  const board = new ZenXBoardCapabilityPackage(f.host);
  board.start(createFixturePluginHost({ pluginId: "zenx-board" }).sdk);
  const invoke = (name: string, args: Record<string, unknown>) =>
    board.invoke(name, {
      name,
      callId: "synthetic",
      cwd: "/synthetic",
      threadId: owner.threadId,
      arguments: args,
      signal: signal(),
    });
  await invoke("zenx_board_put", { document });
  f.host.options.readBrowserModelTarget = async () => {
    throw new Error("Synthetic native listing disconnected", {
      cause: new Error("Synthetic local cause"),
    });
  };
  const full = (await invoke("zenx_board_read", { view: "document" })) as any;
  assert.deepEqual(full.document, document);
  assert.equal(full.navigationDiagnostics[0].status, "unknown");
  assert.equal(
    full.navigationDiagnostics[0].error,
    "Synthetic native listing disconnected",
  );
  assert.match(
    full.navigationDiagnostics[0].errorDetail,
    /Synthetic local cause/,
  );
  assert.deepEqual(readBrowserSidebarTargets(full), []);
});

test("legacy persisted route documents remain fully readable but cannot execute obsolete routes", async () => {
  const f = fixture();
  const sdk = createFixturePluginHost({ pluginId: "zenx-board" }).sdk;
  const legacy = {
    ...document,
    events: [
      {
        id: "old",
        label: "Old",
        actions: [{ kind: "navigate", route: "plugin:old-authored-route" }],
      },
    ],
  };
  await sdk.storage.set({
    boards: {
      [`thread:${owner.threadId}`]: {
        document: legacy,
        revision: 1,
        draftRevision: 0,
        values: {},
        pinned: false,
      },
    },
  });
  const board = new ZenXBoardCapabilityPackage(f.host);
  board.start(sdk);
  const full = (await board.invoke("zenx_board_read", {
    name: "zenx_board_read",
    callId: "read",
    cwd: "/synthetic",
    threadId: owner.threadId,
    arguments: { view: "document" },
    signal: signal(),
  })) as any;
  assert.deepEqual(full.document, legacy);
  const result = (await board.invoke("zenx_board_ui", {
    name: "zenx_board_ui",
    callId: "event",
    cwd: "/synthetic",
    threadId: owner.threadId,
    trustedPluginUi: true,
    arguments: {
      input: {
        operation: "event",
        owner,
        eventId: "old",
        revision: 1,
        draftRevision: 0,
      },
    },
    signal: signal(),
  })) as any;
  assert.match(result.error, /legacy route/);
  assert.equal(f.writes(), 0);
});

test("custom isolated navigation uses the exact UI owner and current document revision without model delivery", async () => {
  const f = fixture();
  const board = new ZenXBoardCapabilityPackage(f.host);
  board.start(createFixturePluginHost({ pluginId: "zenx-board" }).sdk);
  const invoke = (name: string, args: Record<string, unknown>, ui = false) =>
    board.invoke(name, {
      name,
      callId: "synthetic",
      cwd: "/synthetic",
      threadId: owner.threadId,
      arguments: ui ? { input: args } : args,
      signal: signal(),
      ...(ui ? { trustedPluginUi: true as const } : {}),
    });
  await invoke("zenx_board_put", { document });
  const input = {
    operation: "navigate",
    owner,
    revision: 1,
    target: { kind: "url", url: "https://example.test/custom" },
  };
  await assert.rejects(invoke("zenx_board_ui", input), /human UI/);
  await assert.rejects(
    invoke("zenx_board_ui", { ...input, revision: 0 }, true),
    /Board changed/,
  );
  assert.equal(f.writes(), 0);
  const result = (await invoke("zenx_board_ui", input, true)) as any;
  assert.equal(f.writes(), 1);
  assert.deepEqual(result.navigation, [input.target]);
  assert.deepEqual(result.outcomes, [{ kind: "navigate" }]);
  assert.deepEqual(result.snapshot.values, {});
  await assert.rejects(
    invoke(
      "zenx_board_ui",
      { ...input, owner: { kind: "thread", threadId: "foreign" } },
      true,
    ),
    /unavailable/,
  );
  await assert.rejects(
    invoke(
      "zenx_board_ui",
      { ...input, target: { kind: "url", url: "plugin:arbitrary" } },
      true,
    ),
    /HTTP/,
  );
  assert.equal(f.writes(), 1);
});

test("a committed Room availability publication cancels the same Board action", async () => {
  const roomOwner = {
    kind: "room" as const,
    roomId: "synthetic-room",
    threadId: owner.threadId,
  };
  let available = true;
  let notify: () => void = () => {};
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let executions = 0;
  let observed: AbortSignal | undefined;
  const host = new BoardHostService({
    appServer: {
      request: async () => assert.fail("No full read/model"),
    } as any,
    readThreadSummary: async (threadId) => ({ threadId, archived: false }),
    rooms: {
      roomsAvailable: () => available,
      snapshot: () => ({
        rooms: [
          {
            id: roomOwner.roomId,
            name: "Synthetic",
            members: [{ name: "Owner", threadId: owner.threadId }],
            messages: [],
            createdAt: 0,
          },
        ],
      }),
      onChange: (listener) => {
        notify = listener;
        return () => {
          notify = () => {};
        };
      },
      postAddressedRoomMessage: async () => assert.fail("No send"),
    },
    executeTool: async (_request, live) => {
      executions++;
      observed = live;
      entered();
      await new Promise<void>((resolve) =>
        live.addEventListener("abort", () => resolve(), { once: true }),
      );
      return {
        output: "Synthetic native cancellation observed",
        exitCode: 130,
      };
    },
  });
  const running = host.execute(
    roomOwner,
    { tool: "shell", arguments: { command: "synthetic" } },
    signal(),
  );
  await started;
  available = false;
  notify();
  assert.equal(observed?.aborted, true);
  assert.equal((await running).exitCode, 130);
  assert.equal(executions, 1);
});

test("custom navigation failure keeps local cause details without a successful navigation receipt", async () => {
  const f = fixture();
  const board = new ZenXBoardCapabilityPackage(f.host);
  board.start(createFixturePluginHost({ pluginId: "zenx-board" }).sdk);
  const invoke = (name: string, args: Record<string, unknown>, ui = false) =>
    board.invoke(name, {
      name,
      callId: "synthetic",
      cwd: "/synthetic",
      threadId: owner.threadId,
      arguments: ui ? { input: args } : args,
      signal: signal(),
      ...(ui ? { trustedPluginUi: true as const } : {}),
    });
  await invoke("zenx_board_put", { document });
  f.host.options.readBrowserModelTarget = async () => {
    throw new Error("Synthetic connection lost", {
      cause: new Error("Synthetic nested native cause"),
    });
  };
  const result = (await invoke(
    "zenx_board_ui",
    {
      operation: "navigate",
      owner,
      revision: 1,
      target: { kind: "browser", id: route.targetId },
    },
    true,
  )) as any;
  assert.equal(result.error, "Synthetic connection lost");
  assert.match(result.errorDetail, /Synthetic nested native cause/);
  assert.deepEqual(result.navigation, []);
  assert.deepEqual(result.outcomes, []);
  assert.equal(f.writes(), 0);
});

for (const custom of [true, false])
  test(`${custom ? "custom" : "declared"} navigation cannot commit after its document is replaced during native preparation`, async () => {
    let state = emptySidebarState({ kind: "thread", id: owner.threadId });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const f = fixture();
    f.host.options.sidebar = {
      read: async (_owner, admit) => {
        admit?.();
        return structuredClone(state);
      },
      update: async (request, admit) => {
        entered();
        await paused;
        admit?.(); // Existing final Host sidebar admission boundary.
        writes++;
        state = applySidebarPatch(state, request.patch);
        return { applied: true, state };
      },
    };
    const board = new ZenXBoardCapabilityPackage(f.host);
    board.start(createFixturePluginHost({ pluginId: "zenx-board" }).sdk);
    const invoke = (name: string, args: Record<string, unknown>, ui = false) =>
      board.invoke(name, {
        name,
        callId: "synthetic",
        cwd: "/synthetic",
        threadId: owner.threadId,
        arguments: ui ? { input: args } : args,
        signal: signal(),
        ...(ui ? { trustedPluginUi: true as const } : {}),
      });
    const target = { kind: "url", url: "https://example.test/old" };
    const authored = {
      ...document,
      events: [
        {
          id: "open",
          label: "Open old",
          actions: [{ kind: "navigate", target }],
        },
      ],
    };
    await invoke("zenx_board_put", { document: authored });
    const running = invoke(
      "zenx_board_ui",
      custom
        ? { operation: "navigate", owner, revision: 1, target }
        : {
            operation: "event",
            owner,
            revision: 1,
            draftRevision: 0,
            eventId: "open",
          },
      true,
    );
    await started;
    await invoke("zenx_board_put", {
      document: { ...authored, title: "Replacement" },
    });
    release();
    const result = (await running) as any;
    assert.match(result.error, /Board document changed/);
    assert.equal(
      writes,
      0,
      "replacement invalidates final admission, not just an earlier read",
    );
    assert.deepEqual(result.navigation, []);
  });

test("updating another owner's Board does not revoke an unrelated running interaction", async () => {
  const f = fixture();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed: AbortSignal | undefined;
  f.host.options.executeTool = async (_request, live) => {
    observed = live;
    entered();
    await paused;
    live.throwIfAborted();
    return { output: "Synthetic confirmed", exitCode: 0 };
  };
  const board = new ZenXBoardCapabilityPackage(f.host);
  board.start(createFixturePluginHost({ pluginId: "zenx-board" }).sdk);
  const invoke = (
    name: string,
    args: Record<string, unknown>,
    ui = false,
    threadId = owner.threadId,
  ) =>
    board.invoke(name, {
      name,
      callId: "synthetic",
      cwd: "/synthetic",
      threadId,
      arguments: ui ? { input: args } : args,
      signal: signal(),
      ...(ui ? { trustedPluginUi: true as const } : {}),
    });
  const authored = {
    ...document,
    events: [
      {
        id: "run",
        label: "Run",
        actions: [{ kind: "script", command: "synthetic" }],
      },
    ],
  };
  await invoke("zenx_board_put", { document: authored });
  const running = invoke(
    "zenx_board_ui",
    {
      operation: "event",
      owner,
      revision: 1,
      draftRevision: 0,
      eventId: "run",
    },
    true,
  );
  await started;
  const other = { kind: "thread", threadId: "other-owner" };
  await invoke(
    "zenx_board_put",
    { document: { ...authored, owner: other } },
    false,
    other.threadId,
  );
  assert.equal(observed?.aborted, false);
  release();
  const result = (await running) as any;
  assert.equal(result.error, undefined);
  assert.equal(result.outcomes[0].result.exitCode, 0);
});
