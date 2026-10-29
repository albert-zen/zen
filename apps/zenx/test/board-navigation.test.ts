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
