import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createFixturePluginHost } from "../dist/index.js";

test("the public package ships a v2 manifest JSON schema beside its runtime validator", async () => {
  const schema = JSON.parse(
    await readFile(
      new URL("../dist/zenx.plugin.schema.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    schema.$id,
    "https://zenx.dev/schemas/zenx.plugin.v2.schema.json",
  );
  assert.equal(schema.properties.schemaVersion.const, 2);
  assert.ok(schema.required.includes("runtime"));
  assert.ok(schema.required.includes("tools"));
  assert.equal(schema.$defs.hostSdkVersion.const, 1);
});

test("fixture Host provides SDK v1 development behavior without Agent, Thread, or Turn authority", async () => {
  const commandCalls = [];
  const host = createFixturePluginHost({
    pluginId: "fixture-plugin",
    storageVersion: 2,
    initialStorage: { count: 1 },
    projects: [
      {
        key: "/workspace",
        workspace: "/workspace",
        configured: true,
        isDefault: true,
        threadIds: ["thread-existing"],
      },
    ],
    handles: { context: { selected: true } },
    executeCommand: async (commandId, input) => {
      commandCalls.push([commandId, input]);
      return { ok: true };
    },
  });

  assert.equal(host.sdk.version, 1);
  assert.equal(host.sdk.pluginId, "fixture-plugin");
  assert.deepEqual(await host.sdk.storage.get(), { count: 1 });
  await host.sdk.storage.set({ count: 2 });
  assert.deepEqual(await host.sdk.storage.get(), { count: 2 });
  assert.deepEqual(await host.sdk.query.projects.list(), [
    {
      key: "/workspace",
      workspace: "/workspace",
      configured: true,
      isDefault: true,
      threadIds: ["thread-existing"],
    },
  ]);
  assert.deepEqual(await host.sdk.ui.handles.read("context"), {
    selected: true,
  });
  assert.deepEqual(
    await host.sdk.ui.commands.execute("refresh", { now: true }),
    {
      ok: true,
    },
  );
  assert.deepEqual(commandCalls, [["refresh", { now: true }]]);
  await assert.rejects(
    host.sdk.actions.threads.startTurn({ threadId: "new", input: "run" }),
    /does not own Agent, Thread, or Turn authority/u,
  );
});
