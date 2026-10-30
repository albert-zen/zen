import { buildCodeRuntimeWorkerFixture } from "./code-runtime-worker-fixture.js";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import test from "node:test";
import { CodeRuntime } from "../../../src/code-runtime.js";
import { ModelReferenceRegistry } from "../../../src/model-references.js";
import { computerObjectBinding } from "../../../packages/zenx-computer-plugin/src/object-contract.js";
import {
  computerModelDefinition,
  decodeComputerArguments,
  projectComputerResult,
} from "../src/main/capabilities/model-computer-facade.js";
import { boundComputerCapabilityManifest } from "../src/main/capabilities/computer-provider.js";

const provider = boundComputerCapabilityManifest.provider.id;
const tools = boundComputerCapabilityManifest.tools.map((tool) => {
  const objectBinding = computerObjectBinding(
    tool.name,
    provider,
    tool.inputSchema,
  );
  return computerModelDefinition({
    ...tool,
    ...(objectBinding ? { objectBinding } : {}),
  });
});

test("fresh Computer object programs use the same owned native refs and explicit focus scope", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "computer-objects-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workerUrl = await buildCodeRuntimeWorkerFixture(directory);
  const registry = new ModelReferenceRegistry();
  const refs = registry.scope("owner");
  const target = { pid: 812, windowTitle: "Synthetic receiver" };
  const window = (
    projectComputerResult(
      { windows: [{ target, applicationName: "Fixture" }] },
      {},
      refs,
      "epoch",
    ).windows as Array<{ ref: string }>
  )[0]!.ref;
  const captured = projectComputerResult(
    { target, bindingId: "binding-native", captureId: "capture-native" },
    { target },
    refs,
    "epoch",
  );
  const calls: Array<[string, Record<string, unknown>]> = [];
  const execute = (code: string, owner = "owner", epoch = "epoch") =>
    new CodeRuntime({ workerUrl }).execute({
      code,
      tools,
      signal: new AbortController().signal,
      nested: {
        invoke: async (name, args) => {
          try {
            const decoded = decodeComputerArguments(
              name,
              args,
              registry.scope(owner),
              epoch,
            );
            calls.push([name, decoded]);
            return {
              output: "posted; application effect unverified",
              exitCode: 0,
            };
          } catch (error) {
            return { output: String(error), exitCode: 1 };
          }
        },
      },
    });
  const computer = `capabilities.computer(${JSON.stringify(provider)})`;
  await execute(
    `globalThis.lastWindow = ${computer}.window('${window}'); await lastWindow.inspect();`,
  );
  const fresh = await execute(
    `text(typeof lastWindow); await ${computer}.window('${window}').inspect({full:true});`,
  );
  assert.equal(fresh.text, "undefined");
  await execute(
    `await ${computer}.capture('${captured.capture}').foreground.click({x:10,y:20,button:'right'});`,
  );
  await execute(
    `await ${computer}.appCurrentFocus('${captured.binding}').type({text:'Synthetic text'});`,
  );
  await execute(
    `await ${computer}.capture('${captured.capture}').foreground.drag({x:10,y:20,toX:30,toY:40});`,
  );
  assert.deepEqual(calls, [
    ["computer_inspect", { target, full: true }],
    ["computer_inspect", { full: true, target }],
    [
      "computer_foreground_click",
      {
        x: 10,
        y: 20,
        button: "right",
        bindingId: "binding-native",
        captureId: "capture-native",
      },
    ],
    [
      "computer_background_type",
      { text: "Synthetic text", bindingId: "binding-native" },
    ],
    [
      "computer_foreground_drag",
      {
        x: 10,
        y: 20,
        toX: 30,
        toY: 40,
        bindingId: "binding-native",
        captureId: "capture-native",
      },
    ],
  ]);
  for (const [owner, epoch] of [
    ["other", "epoch"],
    ["owner", "replaced"],
  ]) {
    const result = await execute(
      `text(await ${computer}.window('${window}').inspect());`,
      owner,
      epoch,
    );
    assert.match(result.text, /"exitCode":1/);
    assert.match(result.text, /reference|retired/i);
  }
  assert.equal(
    calls.length,
    5,
    "stale/foreign refs never reach the native dispatch port",
  );
  const omitted = await execute(
    `text(typeof ${computer}.app); text(typeof ${computer}.window('${window}').paste);`,
  );
  assert.equal(omitted.text, "undefined\nundefined");
});
