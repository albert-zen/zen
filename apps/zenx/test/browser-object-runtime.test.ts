import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodeRuntime } from "../../../src/code-runtime.js";
import { buildCodeRuntimeWorkerFixture } from "./code-runtime-worker-fixture.js";
import { workspaceFixture } from "./model-browser-fixture.js";

// Real Host catalog/reference projection and fresh Worker; synthetic backend only.
// This verifies facade wiring, not Chromium execution or native acceptance.
test("actual Browser Host catalog drives fresh object programs and unchanged result shapes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-objects-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await workspaceFixture(1);
  t.after(() => fixture.bridge.close());
  const extensions: unknown[][] = [];
  Object.assign(fixture.backend, {
    extensionOperations: ["evaluate"],
    extension: async (...args: unknown[]) => {
      extensions.push(args);
      return { value: 42 };
    },
  });
  const workerUrl = await buildCodeRuntimeWorkerFixture(directory);
  const tools = fixture.bridge.bundle.tools.map((tool) => tool.specification);
  const execute = (code: string) =>
    new CodeRuntime({ workerUrl }).execute({
      code,
      tools,
      signal: new AbortController().signal,
      nested: {
        invoke: (name, args) => fixture.bridge.receipt(name, args),
      },
    });

  const first = await execute(`
    const browser = capabilities.browser('workspace');
    globalThis.savedBrowser = browser;
    const listed = await browser.list_tabs({});
    if (listed.exitCode !== 0) throw new Error(listed.output);
    const tab = JSON.parse(listed.output).tabs[0].tab;
    const inspected = await browser.tab(tab).inspect({});
    if (inspected.exitCode !== 0) throw new Error(inspected.output);
    text({providers:capabilities.list(), tab,
      observation:JSON.parse(inspected.output).observation,
      resultKeys:Object.keys(inspected)});
  `);
  const selected = JSON.parse(first.text) as {
    providers: Array<{ kind: string; provider: string }>;
    tab: string;
    observation: string;
    resultKeys: string[];
  };
  assert.deepEqual(selected.providers, [
    { kind: "browser", provider: "workspace" },
    { kind: "browser", provider: "connected" },
  ]);
  assert.match(selected.tab, /^r[1-9][0-9]*$/);
  assert.match(selected.observation, /^r[1-9][0-9]*$/);
  assert.ok(selected.resultKeys.includes("output"));
  assert.ok(selected.resultKeys.includes("exitCode"));
  assert.equal(selected.resultKeys.includes("structuredContent"), false);
  assert.equal(
    fixture.calls.filter((call) => call.name === "inspect").length,
    1,
  );

  const second = await execute(`
    text(typeof savedBrowser);
    const browser = capabilities.browser('workspace');
    const result = await browser.observation(${JSON.stringify(selected.observation)})
      .extensions.evaluate({expression:'21*2'});
    if (result.exitCode !== 0) throw new Error(result.output);
    text(JSON.parse(result.output).data.value);
  `);
  assert.equal(second.text, "undefined\n42");
  assert.equal(extensions.length, 1);
  assert.equal(extensions[0]?.[2], "evaluate");
  assert.equal(
    (extensions[0]?.[3] as Record<string, unknown>).expression,
    "21*2",
  );
  assert.ok(
    fixture.bridge.trace.some(
      (entry) =>
        (entry as { layer?: string }).layer ===
        "capability-result-before-model-projection",
    ),
    "Ordinary Host raw capture runs independently of selected Worker output",
  );
});

// A collection belongs to the provider session/tab, not to a guest JS facade or
// consumed action observation. No real network or Chromium is used in this test.
test("Browser tab collection survives three fresh programs and a consumed action observation", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-listener-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await workspaceFixture(1);
  t.after(() => fixture.bridge.close());
  let collecting = false;
  const events: unknown[] = [];
  const operations: string[] = [];
  Object.assign(fixture.backend, {
    extensionOperations: ["network_start", "evaluate", "network_read"],
    extension: async (_session: string, _tab: string, operation: string) => {
      operations.push(operation);
      if (operation === "network_start") {
        collecting = true;
        return { collecting: "network" };
      }
      if (operation === "evaluate") {
        assert.equal(collecting, true);
        events.push({
          sequence: 1,
          method: "Network.responseReceived",
          params: {
            requestId: "synthetic-request",
            response: { url: "https://synthetic.test/data", status: 200 },
          },
        });
        return { value: "synthetic mutation" };
      }
      assert.equal(operation, "network_read");
      assert.equal(collecting, true);
      return { events, eventCursor: "synthetic-cursor", hasMore: false };
    },
  });
  const workerUrl = await buildCodeRuntimeWorkerFixture(directory);
  const execute = (code: string) =>
    new CodeRuntime({ workerUrl }).execute({
      code,
      tools: fixture.bridge.bundle.tools.map((tool) => tool.specification),
      signal: new AbortController().signal,
      nested: { invoke: (name, args) => fixture.bridge.receipt(name, args) },
    });
  const first = await execute(`
    const browser = capabilities.browser('workspace');
    const listed = await browser.list_tabs({});
    if (listed.exitCode !== 0) throw new Error(listed.output);
    const tab = JSON.parse(listed.output).tabs[0].tab;
    const started = await browser.tab(tab).extensions.network_start({});
    if (started.exitCode !== 0) throw new Error(started.output);
    text(tab);
  `);
  const tab = first.text;
  assert.match(tab, /^r[1-9][0-9]*$/);
  const second = await execute(`
    const browser = capabilities.browser('workspace');
    const inspected = await browser.tab(${JSON.stringify(tab)}).inspect({});
    if (inspected.exitCode !== 0) throw new Error(inspected.output);
    const observation = JSON.parse(inspected.output).observation;
    const changed = await browser.observation(observation).extensions.evaluate({expression:'fixtureMutation()'});
    if (changed.exitCode !== 0) throw new Error(changed.output);
    text(observation);
  `);
  const third = await execute(`
    const browser = capabilities.browser('workspace');
    const read = await browser.tab(${JSON.stringify(tab)}).extensions.network_read({});
    if (read.exitCode !== 0) throw new Error(read.output);
    text(JSON.parse(read.output).data.events[0].params.response.status);
  `);
  assert.equal(third.text, "200");
  assert.deepEqual(operations, ["network_start", "evaluate", "network_read"]);
  assert.equal(
    fixture.calls.filter((call) => call.name === "inspect").length,
    1,
  );
  await assert.rejects(
    fixture.bridge.receipt("browser_workspace_evaluate", {
      observation: second.text,
      expression: "mustNotDispatch()",
    }),
    /observation|inspect|consumed|stale/i,
  );
  assert.equal(operations.length, 3);
});
