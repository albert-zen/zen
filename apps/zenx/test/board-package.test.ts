import assert from "node:assert/strict";
import test from "node:test";
import { ZenXBoardCapabilityPackage } from "../src/main/capabilities/board-package.js";
import type { BoardDocument } from "../../../packages/zenx-board-plugin/src/board.js";
import { createFixturePluginHost } from "@zenx/plugin-sdk";

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
  const sdk = createFixturePluginHost({ pluginId: "zenx-board" }).sdk;
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
    invoke: (name: string, args: Record<string, unknown>, ui = false) =>
      service.invoke(name, invocation(name, args, ui)),
  };
}
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
  await f.invoke("zenx_board_put", { document: doc });
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
      document: { ...document, owner: { kind: "thread", threadId: "other" } },
    }),
    /calling Thread/,
  );
  await assert.rejects(
    f.invoke("zenx_board_put", {
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
  await f.invoke("zenx_board_put", { document });
  await f.invoke("zenx_board_put", {
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
