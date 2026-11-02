import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ZenXBoardCapabilityPackage } from "../src/main/capabilities/board-package.js";
import { boardManifest } from "../../../packages/zenx-board-plugin/src/manifest.js";
import type { BoardDocument } from "../../../packages/zenx-board-plugin/src/board.js";
import { createFixturePluginHost } from "@zenx/plugin-sdk";
import { JsonPluginStorage } from "../src/main/plugin-host-sdk.js";

const document: BoardDocument = {
  id: "plan",
  title: "Release plan",
  summary: "Choose scope and ship",
  owner: { kind: "thread", threadId: "t1" },
  blocks: [{ id: "scope", kind: "field", label: "Scope", field: "scope" }],
  initialValues: { scope: "small" },
  events: [
    {
      id: "send",
      label: "Send selection",
      actions: [{ kind: "submit", text: "Ship {{scope}}" }],
    },
  ],
};
function invocation(name: string, args: Record<string, unknown>, ui = false) {
  return {
    name,
    callId: "c1",
    cwd: "/synthetic",
    arguments: ui ? { input: args } : args,
    signal: new AbortController().signal,
    threadId: "t1",
    ...(ui ? { trustedPluginUi: true as const } : {}),
  };
}
async function fixture() {
  const calls: unknown[] = [];
  const root = await mkdtemp(path.join(tmpdir(), "board-content-cas-"));
  after(() => rm(root, { recursive: true, force: true }));
  const storage = await JsonPluginStorage.open({
    root,
    pluginId: "zenx-board",
    version: 1,
    initialValue: {},
  });
  let writes = 0;
  const sdk = {
    ...createFixturePluginHost({ pluginId: "zenx-board" }).sdk,
    storage: {
      version: storage.version,
      get: () => storage.get(),
      set: async (value: Parameters<typeof storage.set>[0]) => {
        writes++;
        await storage.set(value);
      },
    },
  };
  const host = {
    readOwner: async (owner: any) => owner,
    deliver: async (...args: unknown[]) => {
      calls.push(args);
      return { status: "accepted" };
    },
    execute: async () => ({ exitCode: 0, output: "ok" }),
  };
  const service = new ZenXBoardCapabilityPackage(host);
  await service.start(sdk);
  return {
    service,
    sdk,
    calls,
    writes: () => writes,
    invoke: (name: string, args: Record<string, unknown>, ui = false) =>
      service.invoke(name, invocation(name, args, ui)),
  };
}
test("content read returns a pure immutable absent revision zero", async () => {
  const f = await fixture();
  const before = await f.sdk.storage.get();
  const read = (await f.invoke("zenx_board_read", {})) as any;
  assert.deepEqual(read, {
    exists: false,
    contentSnapshot: {
      owner: document.owner,
      revision: 0,
      completeDocument: true,
    },
  });
  assert.deepEqual(await f.sdk.storage.get(), before);
  assert.equal(
    await f.invoke(
      "zenx_board_ui",
      { operation: "read", owner: document.owner },
      true,
    ),
    null,
  );
});

test("content CAS admits exactly one concurrent create and one concurrent replacement", async () => {
  const f = await fixture();
  for (const revision of [0, 1]) {
    const results = (await Promise.all([
      f.invoke("zenx_board_put", {
        document: { ...document, title: `A-${revision}` },
        expectedRevision: revision,
      }),
      f.invoke("zenx_board_put", {
        document: { ...document, title: `B-${revision}` },
        expectedRevision: revision,
      }),
    ])) as any[];
    assert.equal(results.filter((result) => result.applied === true).length, 1);
    assert.equal(
      results.filter((result) => result.applied === false).length,
      1,
    );
    const read = (await f.invoke("zenx_board_read", {
      view: "document",
    })) as any;
    assert.equal(read.revision, revision + 1);
    assert.equal(read.document.title, `A-${revision}`);
    assert.deepEqual(read.contentSnapshot, {
      owner: document.owner,
      revision: revision + 1,
      completeDocument: true,
    });
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes(), 2);
});

test("content write revalidates live owner after waiting for its serial storage read", async () => {
  const f = await fixture();
  let removed = false;
  f.service.host.readOwner = async (owner) => {
    if (removed) throw new Error("Synthetic owner revoked");
    return owner;
  };
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.service.start({
    storage: {
      version: f.sdk.storage.version,
      get: async () => {
        entered();
        await blocked;
        return f.sdk.storage.get();
      },
      set: f.sdk.storage.set,
    },
  });
  const pending = f.invoke("zenx_board_put", { document, expectedRevision: 0 });
  await reached;
  removed = true;
  release();
  await assert.rejects(pending, /owner revoked/);
  assert.deepEqual(await f.sdk.storage.get(), {});
});

test("a content conflict neither writes nor cancels an existing human interaction", async () => {
  const f = await fixture();
  const scripted = {
    ...document,
    events: [
      {
        id: "run",
        label: "Run",
        actions: [{ kind: "script", command: "echo synthetic" }],
      },
    ],
  };
  await f.invoke("zenx_board_put", { document: scripted, expectedRevision: 0 });
  let entered!: () => void;
  let release!: () => void;
  let executionSignal: AbortSignal | undefined;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.service.host.execute = async (_owner, _action, signal) => {
    executionSignal = signal;
    entered();
    await blocked;
    signal.throwIfAborted();
    return { exitCode: 0, output: "synthetic" };
  };
  const pending = f.invoke(
    "zenx_board_ui",
    {
      operation: "event",
      owner: document.owner,
      eventId: "run",
      revision: 1,
      draftRevision: 0,
    },
    true,
  );
  await reached;
  const before = await f.sdk.storage.get();
  try {
    const conflict = (await f.invoke("zenx_board_put", {
      document,
      expectedRevision: 0,
    })) as any;
    assert.equal(conflict.applied, false);
    assert.equal(executionSignal!.aborted, false);
    assert.deepEqual(await f.sdk.storage.get(), before);
  } finally {
    release();
  }
  assert.equal(((await pending) as any).error, undefined);
});

test("agent updates preserve durable user drafts and compact reads omit HTML", async () => {
  const f = await fixture();
  await f.invoke("zenx_board_put", {
    document: { ...document, html: "<p>private html body</p>" },
    expectedRevision: 0,
  });
  await f.invoke(
    "zenx_board_ui",
    {
      operation: "draft",
      owner: document.owner,
      expectedDraftRevision: 0,
      values: { scope: "custom" },
    },
    true,
  );
  await f.invoke("zenx_board_put", {
    document: {
      ...document,
      title: "Revised",
      initialValues: { scope: "large" },
    },
    expectedRevision: 1,
  });
  const read = (await f.invoke("zenx_board_read", {
    owner: document.owner,
  })) as any;
  assert.equal(read.values.scope, "custom");
  assert.equal(JSON.stringify(read).includes("private html"), false);
  const restarted = new ZenXBoardCapabilityPackage({
    readOwner: async (owner: any) => owner,
    deliver: async () => null,
    execute: async () => null,
  });
  await restarted.start(f.sdk);
  const ui = (await restarted.invoke(
    "zenx_board_ui",
    invocation(
      "zenx_board_ui",
      { operation: "read", owner: document.owner },
      true,
    ),
  )) as any;
  assert.equal(ui.values.scope, "custom");
  assert.equal(ui.revision, 2);
});
test("only explicit UI events submit assembled text and stale drafts do not overwrite", async () => {
  const f = await fixture();
  await f.invoke("zenx_board_put", { document, expectedRevision: 0 });
  await assert.rejects(
    f.invoke("zenx_board_ui", {
      operation: "event",
      owner: document.owner,
      eventId: "send",
      revision: 1,
      draftRevision: 0,
      clientId: "event1",
    }),
    /human UI/,
  );
  await f.invoke(
    "zenx_board_ui",
    {
      operation: "draft",
      owner: document.owner,
      expectedDraftRevision: 0,
      values: { scope: "large" },
    },
    true,
  );
  await assert.rejects(
    f.invoke(
      "zenx_board_ui",
      {
        operation: "draft",
        owner: document.owner,
        expectedDraftRevision: 0,
        values: { scope: "lost" },
      },
      true,
    ),
    /draft changed/,
  );
  await f.invoke(
    "zenx_board_ui",
    {
      operation: "event",
      owner: document.owner,
      eventId: "send",
      revision: 1,
      draftRevision: 1,
      clientId: "event1",
    },
    true,
  );
  assert.equal(f.calls.length, 1);
  assert.equal((f.calls[0] as unknown[])[1], "Ship large");
});
test("script-only actions do not deliver; conditional submit uses the actual result", async () => {
  const f = await fixture();
  const doc = {
    ...document,
    events: [
      {
        id: "run",
        label: "Validate",
        actions: [
          { kind: "script", command: "printf '%s' '{{valuesBase64}}'" },
          {
            kind: "if",
            field: "result.exitCode",
            equals: 0,
            then: [{ kind: "submit", text: "Validated {{scope}}" }],
          },
        ],
      },
    ],
  };
  await f.invoke("zenx_board_put", { expectedRevision: 0, document: doc });
  const result = (await f.invoke(
    "zenx_board_ui",
    {
      operation: "event",
      owner: document.owner,
      eventId: "run",
      revision: 1,
      draftRevision: 0,
    },
    true,
  )) as any;
  assert.equal(result.error, undefined);
  assert.equal(f.calls.length, 1);
  await f.invoke("zenx_board_put", {
    expectedRevision: 1,
    document: {
      ...document,
      events: [
        {
          id: "run",
          label: "Run only",
          actions: [{ kind: "script", command: "echo ready" }],
        },
      ],
    },
  });
  await f.invoke(
    "zenx_board_ui",
    {
      operation: "event",
      owner: document.owner,
      eventId: "run",
      revision: 2,
      draftRevision: 0,
    },
    true,
  );
  assert.equal(f.calls.length, 1);
});
test("unknown execution never flows into conditional model delivery", async () => {
  const f = await fixture();
  f.service.host.execute = async () => ({
    exitCode: 0,
    output: "pending",
    contentType: "application/vnd.zen.tool-task+json",
  });
  await f.invoke("zenx_board_put", {
    expectedRevision: 0,
    document: {
      ...document,
      events: [
        {
          id: "run",
          label: "Run",
          actions: [
            { kind: "script", command: "echo later" },
            { kind: "submit", text: "Done" },
          ],
        },
      ],
    },
  });
  const result = (await f.invoke(
    "zenx_board_ui",
    {
      operation: "event",
      owner: document.owner,
      eventId: "run",
      revision: 1,
      draftRevision: 0,
    },
    true,
  )) as any;
  assert.match(result.error, /no confirmed terminal/);
  assert.equal(f.calls.length, 0);
});
test("ownership and document updates fence stale actions; text never becomes shell code", async () => {
  const f = await fixture();
  await assert.rejects(
    f.invoke("zenx_board_put", {
      expectedRevision: 0,
      document: { ...document, owner: { kind: "thread", threadId: "other" } },
    }),
    /calling Thread/,
  );
  await assert.rejects(
    f.invoke("zenx_board_put", {
      expectedRevision: 0,
      document: {
        ...document,
        events: [
          {
            id: "bad",
            label: "Bad",
            actions: [{ kind: "script", command: "echo {{scope}}" }],
          },
        ],
      },
    }),
    /valuesBase64/,
  );
  await f.invoke("zenx_board_put", { expectedRevision: 0, document });
  await f.invoke("zenx_board_put", {
    expectedRevision: 1,
    document: { ...document, title: "Updated" },
  });
  await assert.rejects(
    f.invoke(
      "zenx_board_ui",
      {
        operation: "event",
        owner: document.owner,
        eventId: "send",
        revision: 1,
        draftRevision: 0,
      },
      true,
    ),
    /Board changed/,
  );
  assert.equal(f.calls.length, 0);
});

test("custom event payload is not limited to template fields and never overwrites saved drafts", async () => {
  const f = await fixture();
  await f.invoke("zenx_board_put", {
    expectedRevision: 0,
    document: {
      ...document,
      events: [
        {
          id: "custom",
          label: "Custom",
          actions: [
            {
              kind: "if",
              field: "scope",
              equals: "never",
              then: [{ kind: "set", values: { answer: "unused" } }],
            },
            { kind: "submit", text: "Custom composition: {{answer}}" },
          ],
        },
      ],
    },
  });
  await f.invoke(
    "zenx_board_ui",
    {
      operation: "event",
      owner: document.owner,
      eventId: "custom",
      revision: 1,
      draftRevision: 0,
      values: { answer: "assembled by arbitrary custom JavaScript" },
    },
    true,
  );
  assert.equal(
    (f.calls[0] as unknown[])[1],
    "Custom composition: assembled by arbitrary custom JavaScript",
  );
  const read = (await f.invoke("zenx_board_read", {})) as {
    values: Record<string, unknown>;
  };
  assert.equal(read.values.answer, undefined);
});

test("body CAS preserves field drafts and pin committed after the author's read", async () => {
  const f = await fixture();
  await f.invoke("zenx_board_put", { document, expectedRevision: 0 });
  const baseline = (await f.invoke("zenx_board_read", {
    view: "document",
  })) as any;
  await f.invoke(
    "zenx_board_ui",
    {
      operation: "draft",
      owner: document.owner,
      expectedDraftRevision: 0,
      values: { scope: "human unsent draft", extra: true },
    },
    true,
  );
  await f.invoke(
    "zenx_board_ui",
    { operation: "pin", owner: document.owner, pinned: true },
    true,
  );
  const result = (await f.invoke("zenx_board_put", {
    document: {
      ...document,
      title: "Agent replacement",
      initialValues: { scope: "must not clobber", newField: "new" },
    },
    expectedRevision: baseline.contentSnapshot.revision,
  })) as any;
  assert.equal(result.applied, true);
  const read = (await f.invoke("zenx_board_read", { view: "document" })) as any;
  assert.deepEqual(read.values, {
    scope: "human unsent draft",
    extra: true,
    newField: "new",
  });
  assert.equal(read.draftRevision, 1);
  assert.equal(read.pinned, true);
  assert.equal(read.revision, 2);
  assert.equal(
    baseline.document.title,
    document.title,
    "earlier read remains immutable",
  );
  assert.equal(baseline.contentSnapshot.revision, 1);
  assert.deepEqual(baseline.values, { scope: "small" });
});

test("body revision rejects blind or malformed writes and strictly increases across A B A", async () => {
  const f = await fixture();
  for (const expectedRevision of [
    undefined,
    null,
    -1,
    0.5,
    "0",
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    await assert.rejects(
      f.invoke("zenx_board_put", { document, expectedRevision }),
      /safe integer/,
    );
  }
  await assert.rejects(
    f.invoke("zenx_board_put", {
      document,
      expectedRevision: 0,
      snapshot: "forged",
    }),
    /Unknown Board argument/,
  );
  assert.equal(f.writes(), 0);
  for (const [revision, title] of ["A", "B", "A"].entries()) {
    const result = (await f.invoke("zenx_board_put", {
      document: { ...document, title },
      expectedRevision: revision,
    })) as any;
    assert.equal(result.applied, true);
    assert.equal(result.contentSnapshot.revision, revision + 1);
  }
  const before = await f.sdk.storage.get();
  assert.equal(
    (
      (await f.invoke("zenx_board_put", {
        document,
        expectedRevision: 1,
      })) as any
    ).applied,
    false,
  );
  assert.deepEqual(await f.sdk.storage.get(), before);
  const restored = new ZenXBoardCapabilityPackage(f.service.host);
  restored.start(f.sdk);
  assert.equal(
    (
      (await restored.invoke(
        "zenx_board_read",
        invocation("zenx_board_read", {}),
      )) as any
    ).contentSnapshot.revision,
    3,
  );
  const state = (await f.sdk.storage.get()) as any;
  state.boards["thread:t1"].revision = Number.MAX_SAFE_INTEGER;
  await f.sdk.storage.set(state);
  const writes = f.writes();
  await assert.rejects(
    f.invoke("zenx_board_put", {
      document,
      expectedRevision: Number.MAX_SAFE_INTEGER,
    }),
    /safe integer/,
  );
  assert.equal(f.writes(), writes, "overflow rejects before commit");
  delete state.boards["thread:t1"].revision;
  await f.sdk.storage.set(state);
  await assert.rejects(f.invoke("zenx_board_read", {}), /safe integer/);
  await assert.rejects(
    f.invoke("zenx_board_put", { document, expectedRevision: 0 }),
    /safe integer/,
  );
});

for (const operation of ["read", "put"] as const) {
  for (const change of ["revoked", "aborted"] as const) {
    test(`body ${operation} rechecks ${change} after awaiting live Browser targets`, async () => {
      const f = await fixture();
      const owner = { kind: "room" as const, roomId: "room", threadId: "t1" };
      const doc = {
        ...document,
        owner,
        events: [
          {
            id: "open",
            label: "Open",
            actions: [
              { kind: "navigate", target: { kind: "browser", id: "target" } },
            ],
          },
        ],
      };
      const route = {
        ownerThreadId: "t1",
        sessionId: "session",
        sessionEpoch: "epoch",
        backend: "workspace",
        tabId: "tab",
        targetId: "target",
      };
      f.service.host.readNavigationTarget = async () => route;
      await f.invoke("zenx_board_put", { document: doc, expectedRevision: 0 });
      let removed = false;
      f.service.host.readOwner = async (value) => {
        if (removed) throw Error("Room membership revoked");
        return value;
      };
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.service.host.readNavigationTarget = async () => {
        entered();
        await blocked;
        return route;
      };
      const controller = new AbortController();
      const name = `zenx_board_${operation}`;
      const args =
        operation === "read"
          ? { owner, view: "document" }
          : { document: { ...doc, title: "Replacement" }, expectedRevision: 1 };
      const before = await f.sdk.storage.get();
      const pending = f.service.invoke(name, {
        ...invocation(name, args),
        signal: controller.signal,
      });
      await reached;
      if (change === "revoked") removed = true;
      else controller.abort(new Error("Synthetic cancellation"));
      release();
      await assert.rejects(
        pending,
        change === "revoked" ? /membership revoked/ : /Synthetic cancellation/,
      );
      assert.deepEqual(await f.sdk.storage.get(), before);
      assert.equal(f.writes(), 1);
    });
  }
}

test("absent body read revalidates membership after its queued storage await", async () => {
  const f = await fixture();
  let removed = false;
  f.service.host.readOwner = async (owner) => {
    if (removed) throw Error("Room membership revoked");
    return owner;
  };
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.service.start({
    storage: {
      version: 1,
      get: async () => {
        entered();
        await blocked;
        return f.sdk.storage.get();
      },
      set: f.sdk.storage.set,
    },
  });
  const pending = f.invoke("zenx_board_read", {
    owner: { kind: "room", roomId: "room", threadId: "t1" },
  });
  await reached;
  removed = true;
  release();
  await assert.rejects(pending, /membership revoked/);
  assert.equal(f.writes(), 0);
});

test("content save errors are not conflicts, are never retried, and propagate a supplied storage fence", async () => {
  const f = await fixture();
  await f.invoke("zenx_board_put", { document, expectedRevision: 0 });
  let attempts = 0;
  let fenced = false;
  const failure = new Error("Injected storage outcome unknown");
  f.service.start({
    storage: {
      version: 1,
      get: async () => {
        if (fenced) throw failure;
        return f.sdk.storage.get();
      },
      set: async () => {
        attempts++;
        fenced = true;
        throw failure;
      },
    },
  });
  await assert.rejects(
    f.invoke("zenx_board_put", {
      document: { ...document, title: "Unconfirmed" },
      expectedRevision: 1,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, failure);
      assert.match(error.message, /unconfirmed/);
      return true;
    },
  );
  await assert.rejects(
    f.invoke("zenx_board_read", { view: "document" }),
    (error: unknown) => error === failure,
  );
  assert.equal(attempts, 1);
  assert.equal(f.writes(), 1);
  // This exercises a supplied storage fence, not a claim that default Board
  // syncWrites:false storage creates one after every uncertain filesystem error.
});

test("native Board content CAS schemas and packaged manifest remain identical", async () => {
  const packaged = JSON.parse(
    await readFile(
      new URL(
        "../../../packages/zenx-board-plugin/zenx.plugin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(packaged.mainDocument, boardManifest.mainDocument);
  for (const name of ["zenx_board_read", "zenx_board_put"]) {
    assert.deepEqual(
      packaged.tools.find((tool: { name: string }) => tool.name === name),
      boardManifest.tools.find((tool) => tool.name === name),
    );
  }
  const put = boardManifest.tools.find(
    (tool) => tool.name === "zenx_board_put",
  )!;
  assert.deepEqual(put.inputSchema.required, ["document", "expectedRevision"]);
  assert.deepEqual(put.inputSchema.properties.expectedRevision, {
    type: "integer",
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  });
});
