import assert from "node:assert/strict";
import test from "node:test";
import { CodeRuntime, type CodeExecutionOptions } from "../src/code-runtime.js";
import {
  buildToolPresentation,
  createRunCodeModelTool,
} from "../src/tool-presentation.js";
import type { ModelTool } from "../src/model.js";

const definitions: ModelTool[] = [
  {
    name: "browser_tabs",
    description: "List tabs",
    inputSchema: { type: "object" },
    objectBinding: { kind: "browser", provider: "workspace", path: ["list"] },
  },
  {
    name: "browser_inspect",
    description: "Inspect a tab",
    inputSchema: { type: "object", required: ["tab"] },
    objectBinding: {
      kind: "browser",
      provider: "workspace",
      path: ["inspect"],
      reference: { kind: "tab", argument: "tab" },
    },
  },
  {
    name: "browser_evaluate",
    description: "Explicit provider extension",
    inputSchema: { type: "object" },
    objectBinding: {
      kind: "browser",
      provider: "workspace",
      path: ["extensions", "evaluate"],
      reference: { kind: "observation", argument: "observation" },
    },
  },
  {
    name: "computer_inspect",
    description: "Inspect native window",
    inputSchema: { type: "object" },
    objectBinding: {
      kind: "computer",
      provider: "native",
      path: ["inspect"],
      reference: { kind: "window", argument: "target" },
    },
  },
];
function execute(
  code: string,
  nested: CodeExecutionOptions["nested"],
  tools = definitions,
) {
  return new CodeRuntime().execute({
    code,
    nested,
    tools,
    signal: new AbortController().signal,
  });
}

test("objects invoke exact operations and arguments without publishing unselected results", async () => {
  const calls: unknown[] = [];
  const result = await execute(
    `
    const browser = capabilities.browser('workspace');
    await browser.list();
    const value = await browser.tab('b1').inspect({query:'Save'});
    await browser.observation('o1').extensions.evaluate({expression:'document.title'});
    await capabilities.computer('native').window('r1').inspect();
    text(value.structuredContent.title);
  `,
    {
      invoke: async (name, args) => {
        calls.push([name, args]);
        return {
          output: "raw-private-to-program",
          exitCode: 0,
          structuredContent: { title: "selected" },
        };
      },
    },
  );
  assert.deepEqual(calls, [
    ["browser_tabs", {}],
    ["browser_inspect", { query: "Save", tab: "b1" }],
    ["browser_evaluate", { expression: "document.title", observation: "o1" }],
    ["computer_inspect", { target: "r1" }],
  ]);
  assert.equal(result.text, "selected");
});

test("fresh programs reacquire refs while provider state remains outside JS", async () => {
  let state = 0;
  const nested = {
    invoke: async () => ({ output: String(++state), exitCode: 0 }),
  };
  assert.equal(
    (
      await execute(
        `globalThis.saved = capabilities.browser('workspace').tab('b1'); text((await saved.inspect()).output);`,
        nested,
      )
    ).text,
    "1",
  );
  assert.equal(
    (
      await execute(
        `text(typeof saved); text((await capabilities.browser('workspace').tab('b1').inspect()).output);`,
        nested,
      )
    ).text,
    "undefined\n2",
  );
});

test("failures are unchanged, bindings cannot redirect, absent methods never appear", async () => {
  let calls = 0;
  const nested = {
    invoke: async () => {
      calls++;
      return { output: "stale reference", exitCode: 1 };
    },
  };
  const result = await execute(
    `
    const tab = capabilities.browser('workspace').tab('b1');
    text(await tab.inspect());
    text(typeof tab.click);
    try { tab.inspect({tab:'b2'}); } catch (e) { text(e.message); }
    try { capabilities.browser('missing'); } catch (e) { text(e.message); }
  `,
    nested,
  );
  assert.equal(calls, 1);
  assert.match(result.text, /stale reference/);
  assert.match(result.text, /"exitCode":1/);
  assert.match(result.text, /undefined\nConflicting bound reference: tab/);
  assert.match(result.text, /Unavailable capability provider/);
});

test("facades preserve unawaited call diagnostics", async () => {
  await assert.rejects(
    execute(`capabilities.browser('workspace').tab('b1').inspect();`, {
      invoke: async () => ({ output: "", exitCode: 0 }),
    }),
    { code: "UNAWAITED_TOOL_CALL" },
  );
});

test("catalog keeps lazy descriptor/schema discovery and stable run_code prefix", async () => {
  const snapshot = buildToolPresentation(
    [...definitions, createRunCodeModelTool()],
    "code",
  );
  assert.deepEqual(
    snapshot.codeTools[1]?.objectBinding,
    definitions[1]?.objectBinding,
  );
  assert.equal(
    createRunCodeModelTool(definitions).description,
    createRunCodeModelTool([]).description,
  );
  const result = await execute(
    `
    text(capabilities.list());
    text(ALL_TOOLS.filter(t => t.objectBinding?.reference?.kind === 'tab'));
    text(Object.isFrozen(capabilities.browser('workspace').tab('b1')));
  `,
    {
      invoke: async () => {
        throw new Error("Discovery must not dispatch");
      },
    },
    snapshot.codeTools.map((t) => ({ ...t })),
  );
  assert.match(result.text, /"provider":"native"/);
  assert.match(result.text, /"required":\["tab"\]/);
  assert.match(result.text, /true$/);
});

test("object metadata survives committed tools cold decode and compiler without another disclosure", async () => {
  const { prepareSampleContext } =
    await import("../src/context-preparation.js");
  const { compileItemList, decodeContextItem } =
    await import("../src/item-list.js");
  let id = 0;
  const options = {
    threadId: "thread",
    sampleId: "sample",
    items: [],
    itemList: [],
    sandbox: "danger-full-access" as const,
    tools: definitions,
    inputModalities: null,
    id: () => `context-${++id}`,
    now: () => "2026-10-30T00:00:00Z",
  };
  const items = prepareSampleContext(options);
  const reloaded = items.map((item) =>
    decodeContextItem(JSON.parse(JSON.stringify(item))),
  );
  assert.deepEqual(compileItemList(reloaded).tools, definitions);
  assert.deepEqual(
    prepareSampleContext({ ...options, sampleId: "next", itemList: reloaded }),
    [],
  );
  const toolItem = items.find((item) => item.kind === "tools")!;
  const invalid = JSON.parse(JSON.stringify(toolItem));
  invalid.content.tools[0].objectBinding.path = ["__proto__"];
  assert.throws(() => decodeContextItem(invalid), /Invalid objectBinding/);
});
