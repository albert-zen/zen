import assert from "node:assert/strict";
import test from "node:test";
import type { ModelTool } from "../../../src/model.js";
import type { ToolExecutionResult, ToolInvocation } from "../../../src/tool.js";
import {
  ModelReferenceRegistry,
  trustedModelReferenceBindings,
} from "../../../src/model-references.js";
import {
  attachBrowserSidebarTargets,
  readBrowserSidebarTargets,
  type BrowserModelRoute,
} from "../src/main/capabilities/model-browser-metadata.js";
import {
  hasModelToolFacade,
  invokeModelToolFacade,
  isModelCallableTool,
  modelPluginDocument,
  modelToolDefinition,
} from "../src/main/capabilities/model-tool-facade.js";
import { asJson } from "../src/main/capabilities/model-facade-fields.js";

const caller = "RAW-owning-thread";
const epoch = "host-epoch";
const roomId = "RAW-room";
const route: BrowserModelRoute = {
  ownerThreadId: caller,
  sessionId: "RAW-session",
  sessionEpoch: "RAW-session-epoch",
  backend: "workspace",
  tabId: "RAW-backend-tab",
  targetId: "RAW-product-target",
};
const externalRoute: BrowserModelRoute = {
  ...route,
  backend: "connected/chrome",
  connectionId: "RAW-connection",
  generation: "RAW-generation",
  tabId: "RAW-connected-tab",
  targetId: "RAW-external-target",
};
function fixture() {
  const references = new ModelReferenceRegistry();
  const refs = references.scope(caller);
  const room = refs.bind("rooms", "room", { id: roomId });
  const tab = refs.bind("browser", "tab", { route: { ...route } }, epoch);
  const external = refs.bind(
    "browser",
    "tab",
    { route: { ...externalRoute } },
    epoch,
  );
  const native: ToolInvocation[] = [];
  const rawResults: ToolExecutionResult[] = [];
  return {
    references,
    refs,
    room,
    tab,
    external,
    native,
    rawResults,
    call(
      name: string,
      args: Record<string, unknown>,
      raw: ToolExecutionResult = { output: "{}", exitCode: 0 },
    ) {
      return invokeModelToolFacade({
        epoch,
        references,
        invocation: {
          name,
          arguments: args,
          threadId: caller,
          callId: "synthetic-call",
          cwd: "/synthetic",
          signal: new AbortController().signal,
          traceOutput: {
            async recordResult(result) {
              rawResults.push(result as ToolExecutionResult);
              return { durability: "degraded", error: "synthetic fixture" };
            },
            recordInvocation: async () => {},
            recordReferenceBindings: async () => {},
            recordAcceptedResult: async () => {},
            write: async () => {},
            end: async () => {},
            flush: async () => {},
            hasObservedResult: () => true,
            hasAcceptedResult: () => false,
          },
        },
        async dispatch(invocation) {
          native.push(invocation);
          return raw;
        },
      });
    },
  };
}
function document(owner: unknown = { kind: "thread" }) {
  return {
    id: "plan",
    title: "Exact authored title",
    summary: "Review fields before choosing an action",
    owner,
    blocks: [
      { kind: "field", id: "scope", field: "scope", label: "Scope" },
      { kind: "note", id: "note", text: "Literal {{scope}} and r999" },
    ],
    events: [
      {
        id: "choose",
        label: "Choose",
        actions: [
          { kind: "set", values: { selected: 'quoted "text"' } },
          {
            kind: "if",
            field: "selected",
            equals: true,
            then: [
              { kind: "submit", text: "Deliver {{scope}} only on action" },
            ],
            otherwise: [
              { kind: "script", command: "printf '%s' '{{valuesBase64}}'" },
            ],
          },
        ],
      },
    ],
    initialValues: { scope: "initial", approved: false },
    html: "<style>p{color:red}</style><p>Literal r999</p><script>void 0</script>",
  };
}
function nativeSnapshot() {
  const doc = document({ kind: "room", roomId, threadId: caller });
  const actions: Record<string, unknown>[] = [
    { kind: "navigate", target: { kind: "browser", id: route.targetId } },
    {
      kind: "navigate",
      target: { kind: "external-browser", id: externalRoute.targetId },
    },
    { kind: "navigate", target: { kind: "browser", id: "RAW-closed" } },
    {
      kind: "navigate",
      target: { kind: "url", url: "https://example.test/a?q={{scope}}" },
    },
  ];
  return {
    document: {
      ...doc,
      events: [...doc.events, { id: "navigate", label: "Open", actions }],
    },
    revision: 7,
    draftRevision: 12,
    values: { scope: "x".repeat(8192), approved: true },
    pinned: true,
  };
}
test("Board definitions expose scoped owners and explicit full document reads", () => {
  const source = (name: string): ModelTool => ({
    name,
    description: "Native document",
    inputSchema: { type: "object", properties: {} },
  });
  assert.equal(hasModelToolFacade("zenx_board_put"), true);
  assert.equal(hasModelToolFacade("zenx_board_read"), true);
  assert.equal(hasModelToolFacade("zenx_board_ui"), false);
  assert.equal(isModelCallableTool({ name: "zenx_board_ui" }), false);
  const read = modelToolDefinition(source("zenx_board_read"));
  assert.match(JSON.stringify(read.inputSchema), /document/);
  assert.match(JSON.stringify(read.inputSchema), /semantic/);
  assert.doesNotMatch(JSON.stringify(read.inputSchema), /threadId|roomId/);
  const put = modelToolDefinition(source("zenx_board_put"));
  assert.match(JSON.stringify(put.inputSchema), /external-browser/);
  assert.match(JSON.stringify(put.inputSchema), /\^r/);
  assert.match(modelPluginDocument("zenx-board", "native"), /document/);
});

test("Board owner defaults to the caller and resolves scoped Room refs only", async () => {
  const f = fixture();
  const doc = document();
  await f.call("zenx_board_put", { document: doc });
  assert.deepEqual(f.native.at(-1)!.arguments.document, {
    ...doc,
    owner: { kind: "thread", threadId: caller },
  });
  await f.call("zenx_board_read", {});
  assert.deepEqual(f.native.at(-1)!.arguments, {
    owner: { kind: "thread", threadId: caller },
  });
  await f.call("zenx_board_read", {
    owner: { kind: "room", room: f.room },
    view: "document",
  });
  assert.deepEqual(f.native.at(-1)!.arguments, {
    owner: { kind: "room", roomId, threadId: caller },
    view: "document",
  });
  assert.deepEqual(doc, document(), "decoding must not mutate authored input");
  for (const owner of [
    { kind: "thread", threadId: caller },
    { kind: "room", roomId },
    { kind: "room", room: "r99999" },
    { kind: "room", room: f.tab },
    { kind: "other" },
  ]) {
    const before = f.native.length;
    await assert.rejects(f.call("zenx_board_read", { owner }));
    assert.equal(f.native.length, before);
  }
  const foreign = new ModelReferenceRegistry().scope("foreign");
  const foreignRoom = foreign.bind("rooms", "room", { id: roomId });
  const fork = new ModelReferenceRegistry().scope(caller, foreign.newBindings);
  const { decodeBoardArguments } =
    await import("../src/main/capabilities/model-board-facade.js");
  assert.throws(() =>
    decodeBoardArguments(
      "zenx_board_read",
      {
        owner: { kind: "room", room: foreignRoom },
      },
      fork,
      epoch,
    ),
  );
});

test("Board navigation resolves exact Browser refs and retains private admission sideband", async () => {
  const f = fixture();
  const doc = {
    ...document(),
    events: [
      {
        id: "open",
        label: "Open",
        actions: [
          {
            kind: "if",
            field: "selected",
            equals: true,
            then: [
              { kind: "navigate", target: { kind: "browser", tab: f.tab } },
            ],
            otherwise: [
              {
                kind: "navigate",
                target: { kind: "external-browser", tab: f.external },
              },
            ],
          },
        ],
      },
    ],
  };
  await f.call("zenx_board_put", { document: doc });
  const native = f.native.at(-1)!;
  const actions = (native.arguments.document as typeof doc).events[0]!.actions;
  assert.deepEqual(actions[0]!.then[0], {
    kind: "navigate",
    target: { kind: "browser", id: route.targetId },
  });
  assert.deepEqual(actions[0]!.otherwise[0], {
    kind: "navigate",
    target: { kind: "external-browser", id: externalRoute.targetId },
  });
  assert.deepEqual(readBrowserSidebarTargets(native), [route, externalRoute]);
  for (const target of [
    { kind: "browser", id: route.targetId },
    { kind: "browser", tab: f.external },
    { kind: "browser", tab: f.room },
    { kind: "browser", tab: "r99999" },
  ]) {
    const before = f.native.length;
    await assert.rejects(
      f.call("zenx_board_put", {
        document: {
          ...doc,
          events: [
            {
              id: "open",
              label: "Open",
              actions: [{ kind: "navigate", target }],
            },
          ],
        },
      }),
    );
    assert.equal(f.native.length, before);
  }
});

test("explicit full Board read preserves every authored field while projecting exact live targets independently", async () => {
  const f = fixture();
  const snapshot = nativeSnapshot();
  const raw = attachBrowserSidebarTargets(
    {
      output: JSON.stringify(snapshot),
      exitCode: 0,
      contentType: "application/json",
      structuredContent: asJson(snapshot),
    },
    [route, externalRoute],
  );
  const result = await f.call("zenx_board_read", { view: "document" }, raw);
  const projected = JSON.parse(result.output);
  assert.deepEqual(projected.document.owner, { kind: "room", room: f.room });
  assert.deepEqual(projected.document.blocks, snapshot.document.blocks);
  assert.deepEqual(projected.document.events[0], snapshot.document.events[0]);
  assert.equal(projected.document.html, snapshot.document.html);
  assert.deepEqual(
    projected.document.initialValues,
    snapshot.document.initialValues,
  );
  assert.deepEqual(projected.values, snapshot.values);
  assert.equal(projected.revision, undefined);
  assert.equal(projected.draftRevision, undefined);
  assert.equal(projected.pinned, undefined);
  const actions = projected.document.events[1].actions;
  assert.deepEqual(actions[0].target, { kind: "browser", tab: f.tab });
  assert.deepEqual(actions[1].target, {
    kind: "external-browser",
    tab: f.external,
  });
  assert.equal(actions[2].target.status, "unavailable");
  assert.equal(actions[2].target.id, undefined);
  assert.equal(actions[2].target.tab, undefined);
  assert.deepEqual(actions[3], snapshot.document.events[1]!.actions[3]);
  assert.doesNotMatch(result.output, /RAW-/);
  assert.deepEqual(result.structuredContent, projected);
  assert.ok(
    trustedModelReferenceBindings(result)?.some(
      (binding) => binding.namespace === "browser",
    ),
  );
  assert.equal(f.rawResults[0], raw);
  assert.match(f.rawResults[0]!.output, /RAW-product-target/);
  assert.deepEqual(JSON.parse(raw.output), snapshot);
});

test("Board read never trusts JSON target routes, mismatched owners or ambiguous route metadata", async () => {
  const f = fixture();
  const snapshot = nativeSnapshot();
  for (const routes of [
    undefined,
    [{ ...route, ownerThreadId: "foreign" }],
    [{ ...route, backend: "connected/chrome" }],
    [route, { ...route, sessionEpoch: "different" }],
  ]) {
    const raw = {
      output: JSON.stringify({ ...snapshot, browserSidebarTargets: [route] }),
      exitCode: 0,
    };
    if (routes) attachBrowserSidebarTargets(raw, routes);
    const result = await f.call("zenx_board_read", { view: "document" }, raw);
    const projected = JSON.parse(result.output);
    assert.equal(
      projected.document.events[1].actions[0].target.status,
      "unavailable",
    );
    assert.equal(projected.document.html, snapshot.document.html);
    assert.doesNotMatch(result.output, /RAW-/);
  }
});
