import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonPluginStorage } from "../src/main/plugin-host-sdk.js";
import { ZenXBoardCapabilityPackage } from "../src/main/capabilities/board-package.js";
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
import {
  asJson,
  object,
} from "../src/main/capabilities/model-facade-fields.js";

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
    snapshot(
      owner: Record<string, unknown> = { kind: "thread", threadId: caller },
      revision = 0,
      completeDocument = true,
    ) {
      return refs.bind(
        "board",
        "content-snapshot",
        asJson({ owner, address: "default", revision, completeDocument }),
        epoch,
      );
    },
    call(
      name: string,
      args: Record<string, unknown>,
      raw:
        | ToolExecutionResult
        | ((invocation: ToolInvocation) => Promise<ToolExecutionResult>) = {
        output: "{}",
        exitCode: 0,
      },
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
          return typeof raw === "function" ? await raw(invocation) : raw;
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
    contentSnapshot: { owner: doc.owner, revision: 7, completeDocument: true },
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
  assert.deepEqual(put.inputSchema.required, ["snapshot", "document"]);
  assert.equal(object(put.inputSchema.properties).expectedRevision, undefined);
  const schema = JSON.stringify(put.inputSchema);
  for (const key of [
    "values",
    "text",
    "command",
    "timeoutMs",
    "field",
    "equals",
    "then",
    "otherwise",
  ])
    assert.ok(
      schema.includes(`"${key}":`),
      `Action schema must declare ${key}`,
    );
  assert.ok(
    schema.length < 24000,
    "Action schema must remain bounded, not expand six levels exponentially",
  );
  assert.match(modelPluginDocument("zenx-board", "native"), /document/);
  assert.match(modelPluginDocument("zenx-board", "native"), /valuesBase64/);
});

test("Board model definitions teach every template and the actual isolated SDK", () => {
  const put = modelToolDefinition({
    name: "zenx_board_put",
    description: "Native document",
    inputSchema: { type: "object", properties: {} },
  });
  const documentSchema = object(object(put.inputSchema.properties).document);
  const blocks = object(object(documentSchema.properties).blocks);
  assert.equal(blocks.maxItems, 64);
  const branches = object(blocks.items).anyOf;
  assert.ok(Array.isArray(branches));
  const expected = {
    note: { fields: ["id", "text", "title"], required: ["id", "kind", "text"] },
    metric: {
      fields: ["id", "title", "value", "detail"],
      required: ["id", "kind", "title", "value"],
    },
    progress: {
      fields: ["id", "title", "value", "max"],
      required: ["id", "kind", "title", "value"],
    },
    field: {
      fields: ["id", "label", "field", "input", "options", "placeholder"],
      required: ["id", "kind", "label", "field"],
    },
    action: {
      fields: ["id", "label", "event", "emphasis"],
      required: ["id", "kind", "label", "event"],
    },
  };
  assert.equal(branches.length, Object.keys(expected).length);
  for (const [kind, shape] of Object.entries(expected)) {
    const branch = object(
      branches.find(
        (branch) =>
          object(object(object(branch).properties).kind).const === kind,
      ),
    );
    const properties = object(branch.properties);
    for (const field of shape.fields)
      assert.ok(field in properties, `${kind} declares ${field}`);
    assert.deepEqual(branch.required, shape.required);
    assert.equal(branch.additionalProperties, false);
    if (kind === "field") {
      assert.deepEqual(object(properties.input).enum, [
        "text",
        "textarea",
        "select",
        "checkbox",
      ]);
      assert.equal(object(properties.options).maxItems, 100);
    }
  }
  const guide = modelPluginDocument("zenx-board", "native");
  for (const snippet of [
    "kind: 'field'",
    "input: 'select'",
    "options:",
    "kind: 'action'",
    "event: 'answer'",
    "{{choice}}",
    "zenxPluginUi.context.values",
    "commands.execute('draft', { choice:",
    "commands.execute('event', { eventId:",
    "commands.execute('navigate', { target })",
    "interaction.run(async (sdk)",
    "sdk.navigation.navigate('https://example.test/result')",
    "five minutes",
    "document",
    "owner",
    "No automatic retry",
  ])
    assert.ok(guide.includes(snippet), `Board guide teaches ${snippet}`);
  assert.doesNotMatch(guide, /commands\.execute\('draft', \{\s*values/);
});

test("Board owner defaults to the caller and resolves scoped Room refs only", async () => {
  const f = fixture();
  const doc = document();
  await f.call("zenx_board_put", { snapshot: f.snapshot(), document: doc });
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
  await f.call("zenx_board_put", { snapshot: f.snapshot(), document: doc });
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
        snapshot: f.snapshot(),
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

test("compact Board receipts omit product bookkeeping without changing literal field values", async () => {
  const f = fixture();
  const semantic = {
    id: "plan",
    title: "Board",
    summary: "Semantic summary",
    fields: [{ id: "scope", field: "scope", label: "Scope" }],
    actions: [{ id: "submit", label: "Send" }],
    values: { scope: "Literal r999", approved: true },
    truncated: false,
    revision: 9,
    draftRevision: 12,
    notice: "Draft values are not approval",
  };
  for (const name of ["zenx_board_read", "zenx_board_put"]) {
    const result = await f.call(
      name,
      name === "zenx_board_put"
        ? { snapshot: f.snapshot(), document: document() }
        : {},
      { output: JSON.stringify(semantic), exitCode: 0 },
    );
    const {
      revision: _revision,
      draftRevision: _draftRevision,
      ...expected
    } = semantic;
    assert.deepEqual(JSON.parse(result.output), expected);
  }
});

test("stale epoch and cross-owner Browser provenance cannot reach Board dispatch", async () => {
  const f = fixture();
  const stale = f.refs.bind(
    "browser",
    "tab",
    { route: { ...route } },
    "old-epoch",
  );
  const foreign = f.refs.bind(
    "browser",
    "tab",
    {
      route: { ...route, ownerThreadId: "foreign" },
    },
    epoch,
  );
  for (const tab of [stale, foreign]) {
    await assert.rejects(
      f.call("zenx_board_put", {
        snapshot: f.snapshot(),
        document: {
          ...document(),
          events: [
            {
              id: "open",
              label: "Open",
              actions: [{ kind: "navigate", target: { kind: "browser", tab } }],
            },
          ],
        },
      }),
    );
  }
  assert.equal(f.native.length, 0);
});

test("full Board read preserves legacy route text inertly while new puts reject it", async () => {
  const f = fixture();
  const routeText = "plugin:legacy/view?selection={{scope}}#literal";
  const snapshot = nativeSnapshot();
  const legacyEvent = {
    id: "legacy",
    label: "Inspect old navigation",
    actions: [
      {
        kind: "if",
        field: "scope",
        equals: "old",
        then: [{ kind: "navigate", route: routeText }],
        otherwise: [{ kind: "set", values: { scope: "new" } }],
      },
    ],
  };
  const legacy = {
    ...snapshot,
    document: {
      ...snapshot.document,
      events: [...snapshot.document.events, legacyEvent],
    },
  };
  const result = await f.call(
    "zenx_board_read",
    { view: "document" },
    {
      output: JSON.stringify(legacy),
      exitCode: 0,
    },
  );
  const projected = JSON.parse(result.output);
  const action = projected.document.events[2].actions[0].then[0];
  assert.equal(action.route, routeText);
  assert.equal(action.status, "unavailable");
  assert.match(action.reason, /legacy|Legacy/);
  assert.equal(action.target, undefined);
  assert.deepEqual(
    projected.document.events[2].actions[0].otherwise,
    legacyEvent.actions[0]!.otherwise,
  );
  assert.deepEqual(projected.document.blocks, legacy.document.blocks);
  assert.equal(projected.document.html, legacy.document.html);
  const before = f.native.length;
  await assert.rejects(
    f.call("zenx_board_put", {
      snapshot: f.snapshot(),
      document: { ...document(), events: [legacyEvent] },
    }),
  );
  assert.equal(
    f.native.length,
    before,
    "Legacy routes must never reach native authoring dispatch",
  );
});

test("Board target diagnostics retain actual failure reasons without native routing IDs or local error details", async () => {
  const f = fixture();
  const snapshot = nativeSnapshot();
  const diagnostic = {
    kind: "browser",
    id: route.targetId,
    status: "unknown",
    error: `Backend liveness read failed for ${route.targetId} owned by ${caller}: connection reset`,
    errorDetail: "LOCAL-ONLY stack/cause diagnostic",
  };
  const raw = {
    output: JSON.stringify({
      ...snapshot,
      navigationDiagnostics: [diagnostic],
    }),
    exitCode: 0,
  };
  const result = await f.call("zenx_board_read", { view: "document" }, raw);
  const projected = JSON.parse(result.output);
  const target = projected.document.events[1].actions[0].target;
  assert.equal(target.status, "unknown");
  assert.match(target.reason, /Backend liveness read failed.*connection reset/);
  assert.equal(target.tab, undefined);
  assert.equal(target.id, undefined);
  assert.equal(projected.navigationDiagnostics, undefined);
  assert.doesNotMatch(result.output, /RAW-|LOCAL-ONLY/);
  assert.equal(projected.document.html, snapshot.document.html);
  assert.equal(f.rawResults[0], raw);
  assert.match(raw.output, /RAW-product-target|LOCAL-ONLY/);
});

async function realBoard() {
  const root = await mkdtemp(path.join(tmpdir(), "board-model-cas-"));
  after(() => rm(root, { recursive: true, force: true }));
  const storage = await JsonPluginStorage.open({
    root,
    pluginId: "zenx-board",
    version: 1,
    initialValue: {},
  });
  let writes = 0,
    effects = 0;
  const service = new ZenXBoardCapabilityPackage({
    readOwner: async (owner) => owner,
    deliver: async () => {
      effects++;
    },
    execute: async () => {
      effects++;
    },
  });
  service.start({
    storage: {
      version: storage.version,
      get: () => storage.get(),
      set: async (value) => {
        writes++;
        await storage.set(value);
      },
    },
  });
  return {
    service,
    storage,
    writes: () => writes,
    effects: () => effects,
    async dispatch(invocation: ToolInvocation): Promise<ToolExecutionResult> {
      const result = await service.invoke(invocation.name, invocation);
      return {
        output: JSON.stringify(result),
        structuredContent: asJson(result),
        exitCode: 0,
      };
    },
  };
}

test("real model/native content CAS requires complete same-owner snapshots and preserves UI field drafts", async () => {
  const f = fixture(),
    host = await realBoard();
  const absent = JSON.parse(
    (await f.call("zenx_board_read", {}, host.dispatch)).output,
  );
  assert.equal(absent.exists, false);
  assert.match(absent.snapshot, /^r\d+$/);
  assert.doesNotMatch(
    JSON.stringify(absent),
    /RAW-|revision|completeDocument|default/,
  );
  assert.equal(host.writes(), 0);
  const created = JSON.parse(
    (
      await f.call(
        "zenx_board_put",
        { snapshot: absent.snapshot, document: document() },
        host.dispatch,
      )
    ).output,
  );
  assert.equal(created.applied, true);
  await assert.rejects(
    f.call(
      "zenx_board_put",
      { snapshot: created.snapshot, document: document() },
      host.dispatch,
    ),
    /view:document/,
  );
  const semantic = JSON.parse(
    (await f.call("zenx_board_read", {}, host.dispatch)).output,
  );
  await assert.rejects(
    f.call(
      "zenx_board_put",
      { snapshot: semantic.snapshot, document: document() },
      host.dispatch,
    ),
    /view:document/,
  );
  const full = JSON.parse(
    (await f.call("zenx_board_read", { view: "document" }, host.dispatch))
      .output,
  );
  assert.equal(full.document.html, document().html);
  assert.deepEqual(full.document.events, document().events);
  await host.service.invoke("zenx_board_ui", {
    name: "zenx_board_ui",
    threadId: caller,
    callId: "human-draft",
    cwd: "/synthetic",
    signal: new AbortController().signal,
    trustedPluginUi: true,
    arguments: {
      input: {
        operation: "draft",
        owner: { kind: "thread", threadId: caller },
        expectedDraftRevision: 0,
        values: { scope: "latest human draft" },
      },
    },
  });
  const updates = await Promise.all(
    ["A", "B"].map((title) =>
      f.call(
        "zenx_board_put",
        { snapshot: full.snapshot, document: { ...full.document, title } },
        host.dispatch,
      ),
    ),
  );
  const results = updates.map((result) => JSON.parse(result.output));
  assert.equal(results.filter((result) => result.applied === true).length, 1);
  const conflict = results.find((result) => result.applied === false);
  assert.ok(conflict);
  assert.equal(conflict.values.scope, "latest human draft");
  const before = host.writes();
  await assert.rejects(
    f.call(
      "zenx_board_put",
      { snapshot: conflict.snapshot, document: document() },
      host.dispatch,
    ),
    /view:document/,
  );
  assert.equal(host.writes(), before);
  const saved = (await host.storage.get()) as any;
  assert.equal(saved.boards[`thread:${caller}`].revision, 2);
  assert.equal(saved.boards[`thread:${caller}`].draftRevision, 1);
  assert.equal(
    saved.boards[`thread:${caller}`].values.scope,
    "latest human draft",
  );
  assert.equal(host.effects(), 0);
});

test("model snapshot inputs cannot substitute owner, address, revision, incomplete view or retired epoch", async () => {
  const f = fixture();
  const own = f.snapshot();
  const roomSnapshot = f.snapshot({ kind: "room", roomId, threadId: caller });
  await f.call("zenx_board_put", {
    snapshot: roomSnapshot,
    document: { ...document(), owner: undefined },
  });
  assert.deepEqual((f.native.at(-1)!.arguments.document as any).owner, {
    kind: "room",
    roomId,
    threadId: caller,
  });
  assert.equal(f.native.at(-1)!.arguments.expectedRevision, 0);
  assert.equal(f.native.at(-1)!.arguments.snapshot, undefined);
  const stale = f.refs.bind(
    "board",
    "content-snapshot",
    {
      owner: { kind: "thread", threadId: caller },
      address: "default",
      revision: 0,
      completeDocument: true,
    },
    "retired-epoch",
  );
  const wrongAddress = f.refs.bind(
    "board",
    "content-snapshot",
    {
      owner: { kind: "thread", threadId: caller },
      address: "invalid/document/address",
      revision: 0,
      completeDocument: true,
    },
    epoch,
  );
  const cases = [
    { document: document() },
    { snapshot: own, document: document(), expectedRevision: 0 },
    { snapshot: own, document: document(), owner: { kind: "thread" } },
    { snapshot: own, document: document({ kind: "room", room: f.room }) },
    { snapshot: roomSnapshot, document: document() },
    { snapshot: own, document: document({ kind: "thread", threadId: caller }) },
    ...[
      "r999999",
      stale,
      wrongAddress,
      f.room,
      f.snapshot({ kind: "thread", threadId: "foreign" }),
      f.snapshot(undefined, 1, false),
      f.snapshot(undefined, Number.MAX_SAFE_INTEGER + 1),
    ].map((snapshot) => ({ snapshot, document: document() })),
  ];
  const before = f.native.length;
  for (const args of cases) {
    await assert.rejects(f.call("zenx_board_put", args));
    assert.equal(
      f.native.length,
      before,
      "rejected input never reaches native dispatch",
    );
  }
});

test("a lost model put reply is checked by read without replaying the committed write", async () => {
  const f = fixture(),
    host = await realBoard();
  const absent = JSON.parse(
    (await f.call("zenx_board_read", {}, host.dispatch)).output,
  );
  let dispatched = 0;
  await assert.rejects(
    f.call(
      "zenx_board_put",
      { snapshot: absent.snapshot, document: document() },
      async (invocation) => {
        dispatched++;
        await host.dispatch(invocation);
        throw new Error("Injected reply lost after storage accepted put");
      },
    ),
    /reply lost/,
  );
  assert.equal(dispatched, 1);
  assert.equal(host.writes(), 1);
  const checked = JSON.parse(
    (await f.call("zenx_board_read", { view: "document" }, host.dispatch))
      .output,
  );
  assert.equal(checked.document.title, document().title);
  assert.equal(host.writes(), 1);
  assert.equal(host.effects(), 0);
  assert.equal(
    ((await host.storage.get()) as any).boards[`thread:${caller}`].revision,
    1,
  );
  assert.notEqual(checked.snapshot, absent.snapshot);
});

test("real Thread and Room snapshots retain separate default addresses and Room live membership", async () => {
  const f = fixture(),
    host = await realBoard();
  const roomOwner = { kind: "room", room: f.room };
  const thread = JSON.parse(
    (await f.call("zenx_board_read", {}, host.dispatch)).output,
  );
  const room = JSON.parse(
    (await f.call("zenx_board_read", { owner: roomOwner }, host.dispatch))
      .output,
  );
  assert.notEqual(thread.snapshot, room.snapshot);
  await f.call(
    "zenx_board_put",
    { snapshot: thread.snapshot, document: document() },
    host.dispatch,
  );
  await f.call(
    "zenx_board_put",
    { snapshot: room.snapshot, document: document(roomOwner) },
    host.dispatch,
  );
  const state = (await host.storage.get()) as any;
  assert.deepEqual(
    Object.keys(state.boards).sort(),
    [`room:${roomId}`, `thread:${caller}`].sort(),
  );
  assert.equal(state.boards[`thread:${caller}`].revision, 1);
  assert.equal(state.boards[`room:${roomId}`].revision, 1);
  assert.deepEqual(state.boards[`room:${roomId}`].document.owner, {
    kind: "room",
    roomId,
  });
  const full = JSON.parse(
    (
      await f.call(
        "zenx_board_read",
        { owner: roomOwner, view: "document" },
        host.dispatch,
      )
    ).output,
  );
  host.service.host.readOwner = async (owner) => {
    if (owner.kind === "room") throw Error("Room membership revoked");
    return owner;
  };
  await assert.rejects(
    f.call(
      "zenx_board_put",
      { snapshot: full.snapshot, document: full.document },
      host.dispatch,
    ),
    /membership revoked/,
  );
  await assert.rejects(
    f.call(
      "zenx_board_read",
      { owner: roomOwner, view: "document" },
      host.dispatch,
    ),
    /membership revoked/,
  );
  assert.deepEqual(await host.storage.get(), state);
  assert.equal(host.writes(), 2);
});

test("real Board disable delete-data re-enable and Host replacement retire old content snapshots", async () => {
  const { readFile } = await import("node:fs/promises");
  const { ZenXCapabilityService } =
    await import("../src/main/capability-service.js");
  const { ZenXPluginCatalog } =
    await import("../src/main/capabilities/plugin-catalog.js");
  const { createZenXHostToolEnvironment } =
    await import("../src/main/capability-tool-executor.js");
  const { ToolOutputSpool } = await import("../../../src/tool-output-spool.js");
  const root = await mkdtemp(path.join(tmpdir(), "board-lifecycle-cas-"));
  const capabilities = new ZenXCapabilityService({
    userDataDirectory: root,
    bundledProvidersOnly: true,
    providerCatalogOptions: { platform: "darwin", environment: {} },
  });
  const spool = new ToolOutputSpool();
  let composition: ReturnType<typeof createZenXHostToolEnvironment> | undefined;
  let catalog: InstanceType<typeof ZenXPluginCatalog> | undefined;
  const initialize = ZenXPluginCatalog.prototype.initialize;
  // Observe the service's real Catalog; no lifecycle/storage/epoch is replaced.
  ZenXPluginCatalog.prototype.initialize = async function () {
    catalog = this;
    await initialize.call(this);
  };
  try {
    try {
      await capabilities.initialize();
    } finally {
      ZenXPluginCatalog.prototype.initialize = initialize;
    }
    assert.ok(catalog);
    await catalog.install(
      new ZenXBoardCapabilityPackage({
        readOwner: async (owner) => owner,
        deliver: async () => {
          throw Error("No action expected");
        },
        execute: async () => {
          throw Error("No action expected");
        },
      }),
      "bundled",
    );
    const firstGeneration = capabilities.captureHostSnapshot();
    let dispatches = 0;
    composition = createZenXHostToolEnvironment({
      capabilities: firstGeneration,
      toolOutputSpool: spool,
      send: (event) => {
        if (event.type === "capabilities/released") {
          capabilities.releaseHostGeneration(event.generationToken);
          return;
        }
        if (event.type !== "capability/invoke") return;
        dispatches++;
        void capabilities
          .execute(
            {
              ...event.invocation,
              signal: new AbortController().signal,
            },
            event.generationToken,
          )
          .then(
            (result) => {
              composition!.capabilityBundle.handleResult({
                type: "capability/result",
                invocationId: event.invocationId,
                generationToken: event.generationToken,
                ...result,
              });
            },
            (error: unknown) => {
              composition!.capabilityBundle.handleResult({
                type: "capability/result",
                invocationId: event.invocationId,
                generationToken: event.generationToken,
                error: error instanceof Error ? error.message : String(error),
              });
            },
          );
      },
    });
    let call = 0;
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const result = await composition!.toolEnvironment.execute(
        composition!.toolEnvironment.prepare({
          name,
          arguments: args,
          threadId: caller,
          callId: `lifecycle-${++call}`,
          cwd: root,
          signal: new AbortController().signal,
        }),
      );
      assert.equal(result.exitCode, 0, result.output);
      return JSON.parse(result.output);
    };
    const storagePath = path.join(
      root,
      "plugin-data",
      "zenx-board",
      "storage.json",
    );
    const absent = await invoke("zenx_board_read", {});
    assert.equal(absent.exists, false);
    await invoke("zenx_board_put", {
      snapshot: absent.snapshot,
      document: document(),
    });
    const old = await invoke("zenx_board_read", { view: "document" });
    assert.equal(
      JSON.parse(await readFile(storagePath, "utf8")).value.boards[
        `thread:${caller}`
      ].revision,
      1,
    );
    await assert.rejects(
      capabilities.deletePluginData("zenx-board"),
      /Disable or uninstall/,
    );

    // Keep the actual old Host generation leased across disable/delete/re-enable.
    // It must not silently route to the new runtime's empty storage authority.
    await capabilities.setEnabled("zenx-board", false);
    await capabilities.deletePluginData("zenx-board");
    await assert.rejects(readFile(storagePath, "utf8"), { code: "ENOENT" });
    await capabilities.setEnabled("zenx-board", true);
    await assert.rejects(
      capabilities.execute(
        {
          name: "zenx_board_read",
          arguments: {},
          threadId: caller,
          callId: "old-native-generation",
          cwd: root,
          signal: new AbortController().signal,
        },
        firstGeneration.generationToken,
      ),
      /generation was replaced/,
    );
    const nextGeneration = capabilities.captureHostSnapshot();
    assert.notEqual(
      nextGeneration.generationToken,
      firstGeneration.generationToken,
    );
    composition.replaceCapabilities(nextGeneration); // actual new Host bundle/epoch
    const fresh = await invoke("zenx_board_read", {});
    assert.equal(fresh.exists, false);
    const rejected = async (snapshot: string) => {
      const before = dispatches;
      await assert.rejects(
        invoke("zenx_board_put", { snapshot, document: document() }),
        /Reference unavailable or retired/,
      );
      assert.equal(
        dispatches,
        before,
        "old snapshot is rejected before native dispatch",
      );
    };
    await rejected(absent.snapshot); // old rev0 cannot recreate into new absence
    await invoke("zenx_board_put", {
      snapshot: fresh.snapshot,
      document: { ...document(), title: "New generation body" },
    });
    const before = await readFile(storagePath, "utf8");
    assert.equal(
      JSON.parse(before).value.boards[`thread:${caller}`].revision,
      1,
    );
    await rejected(old.snapshot); // same numeric rev1 cannot pass across epochs
    assert.equal(await readFile(storagePath, "utf8"), before);
    assert.equal(
      (await invoke("zenx_board_read", { view: "document" })).document.title,
      "New generation body",
    );
  } finally {
    ZenXPluginCatalog.prototype.initialize = initialize;
    await composition?.close();
    await capabilities.close();
    await spool.close();
    await rm(root, { recursive: true, force: true });
  }
});
