import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenAppServer } from "../../../src/app-server.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { StaticModelCatalog } from "../../../src/model-catalog.js";
import type { ModelAdapter } from "../../../src/model.js";
import { ProviderRegistry } from "../../../src/provider-registry.js";
import { AgentRuntime } from "../../../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../../../src/thread-metadata.js";
import { ToolEnvironment } from "../../../src/tool.js";
import {
  createZenXPluginHostSdk,
  JsonPluginStorage,
} from "../src/main/plugin-host-sdk.js";
import {
  BundledModulePluginRuntime,
  HttpPluginRuntime,
  PluginRuntimeSupervisor,
  ProcessPluginRuntime,
} from "../src/main/plugin-runtime.js";

test("fixture SDK queries Projects, isolates namespaces, migrates sequentially once, and starts a canonical Turn explicitly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-sdk-"));
  const journal = new InMemoryThreadJournal();
  const appServer = fixtureAppServer(journal);
  const thread = await appServer.startThread({ cwd: "/workspace" });
  const projects = async () => [
    {
      key: "project",
      workspace: "/workspace",
      configured: true,
      isDefault: true,
      threadIds: [thread.id],
    },
  ];

  try {
    const fixture = await createZenXPluginHostSdk({
      pluginId: "fixture",
      storageRoot: root,
      storageVersion: 3,
      migrations: [
        {
          fromVersion: 1,
          toVersion: 2,
          migrate: (value) => ({ ...value, second: 2 }),
        },
        {
          fromVersion: 2,
          toVersion: 3,
          migrate: (value) => ({ ...value, third: 3 }),
        },
      ],
      initialStorage: { first: 1 },
      queryProjects: projects,
      appServer,
    });
    const other = await createZenXPluginHostSdk({
      pluginId: "other",
      storageRoot: root,
      storageVersion: 1,
      initialStorage: {},
      queryProjects: projects,
      appServer,
    });

    assert.equal(fixture.version, 1);
    assert.deepEqual(await fixture.query.projects.list(), await projects());
    assert.deepEqual(await fixture.storage.get(), {
      first: 1,
      second: 2,
      third: 3,
    });
    await fixture.storage.set({ first: 10, second: 2, third: 3 });
    assert.deepEqual(await other.storage.get(), {});
    assert.equal((await appServer.readThread(thread.id)).items.length, 1);
    const turn = await fixture.actions.threads.startTurn({
      threadId: thread.id,
      input: "run fixture",
    });
    assert.equal(
      turn.items.filter((item) => item.type === "turn_started").length,
      1,
    );
    assert.equal(
      turn.items.filter((item) => item.type === "user_message").length,
      1,
    );
    assert.equal(
      turn.items.filter((item) => item.type === "turn_completed").length,
      1,
    );

    let reran = 0;
    const restarted = await createZenXPluginHostSdk({
      pluginId: "fixture",
      storageRoot: root,
      storageVersion: 3,
      migrations: [
        {
          fromVersion: 1,
          toVersion: 2,
          migrate: (value) => {
            reran += 1;
            return value;
          },
        },
        {
          fromVersion: 2,
          toVersion: 3,
          migrate: (value) => {
            reran += 1;
            return value;
          },
        },
      ],
      queryProjects: projects,
      appServer,
    });
    assert.equal(reran, 0);
    assert.deepEqual(await restarted.storage.get(), {
      first: 10,
      second: 2,
      third: 3,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fixtureAppServer(journal: InMemoryThreadJournal): ZenAppServer {
  const model: ModelAdapter = {
    provider: "sdk-fixture",
    async *stream() {
      yield { type: "text_delta", delta: "complete" };
    },
  };
  return new ZenAppServer({
    journal,
    runtime: new AgentRuntime({ toolEnvironment: new ToolEnvironment() }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          { id: "fixture", isDefault: true },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: model.provider,
      modelId: "fixture",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
}

test("storage write and migration failures publish no half-state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-sdk-failure-"));
  try {
    const store = await JsonPluginStorage.open({
      pluginId: "fixture",
      root,
      version: 1,
      initialValue: { stable: true },
    });
    await assert.rejects(
      store.set({ invalid: undefined } as never),
      /JSON-compatible/u,
    );
    assert.deepEqual(await store.get(), { stable: true });
    await store.set({ stable: true, literal: "undefined" });
    assert.deepEqual(await store.get(), { stable: true, literal: "undefined" });
    await store.set({ stable: true });

    const failingWrite = await JsonPluginStorage.open({
      pluginId: "fixture",
      root,
      version: 1,
      fileSystem: {
        readFile,
        mkdir,
        writeFile,
        rename: async () => {
          throw new Error("injected rename failure");
        },
        unlink,
      },
    });
    await assert.rejects(
      failingWrite.set({ stable: false }),
      /injected rename failure/u,
    );
    assert.deepEqual(await failingWrite.get(), { stable: true });
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(root, "fixture", "storage.json"), "utf8"),
      ),
      { version: 1, value: { stable: true } },
    );

    await assert.rejects(
      JsonPluginStorage.open({
        pluginId: "fixture",
        root,
        version: 2,
        migrations: [
          {
            fromVersion: 1,
            toVersion: 2,
            migrate: () => {
              throw new Error("migration failed explicitly");
            },
          },
        ],
      }),
      /migration failed explicitly/u,
    );
    const durable = JSON.parse(
      await readFile(path.join(root, "fixture", "storage.json"), "utf8"),
    ) as { version: number; value: unknown };
    assert.equal(durable.version, 1);
    assert.deepEqual(durable.value, { stable: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled, process, and HTTP adapters expose the same logical SDK operation without store authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-sdk-adapters-"));
  const sdk = await createZenXPluginHostSdk({
    pluginId: "fixture",
    storageRoot: root,
    storageVersion: 1,
    initialStorage: { shared: "value" },
    queryProjects: async () => [],
    appServer: {
      startTurn: async () => {
        throw new Error("unused");
      },
      readThread: async () => ({ items: [] }),
    },
  });
  const invocation = {
    invocationId: "sdk-call",
    tool: "fixture_read",
    arguments: {},
    context: { callId: "sdk-call", cwd: process.cwd() },
    signal: new AbortController().signal,
  };
  const bundled = new BundledModulePluginRuntime(
    { pluginId: "fixture", packageVersion: "1.0.0" },
    {
      invoke: async (_invocation, host) => ({
        output: JSON.stringify(await host.storage.get()),
        exitCode: 0,
      }),
    },
    sdk,
  );
  assert.equal((await bundled.invoke(invocation)).output, '{"shared":"value"}');

  const supervisor = new PluginRuntimeSupervisor(new ToolEnvironment(), {
    hostSdkFor: async () => sdk,
  });
  await supervisor.start({
    identity: { pluginId: "fixture", packageVersion: "1.0.0" },
    definitions: [
      {
        name: "fixture_read",
        description: "read fixture storage",
        inputSchema: { type: "object" },
      },
    ],
    start: async (injected) => {
      assert.equal(injected, sdk);
      return new BundledModulePluginRuntime(
        { pluginId: "fixture", packageVersion: "1.0.0" },
        {
          invoke: async (_invocation, host) => ({
            output: JSON.stringify(await host.storage.get()),
            exitCode: 0,
          }),
        },
        injected,
      );
    },
  });
  assert.equal(
    (await supervisor.invoke("fixture", invocation)).output,
    '{"shared":"value"}',
  );
  await supervisor.close();

  const processScript = String.raw`
    import readline from "node:readline";
    const rl = readline.createInterface({input:process.stdin});
    process.stdout.write(JSON.stringify({version:1,type:"ready",pluginId:"fixture",packageVersion:"1.0.0"})+"\n");
    rl.on("line", line => {
      const message=JSON.parse(line);
      if(message.type==="invoke") process.stdout.write(JSON.stringify({version:1,hostSdkVersion:1,type:"host_request",invocationId:message.id,id:"storage",request:{operation:"storage.get"}})+"\n");
      if(message.type==="host_result") process.stdout.write(JSON.stringify({version:1,type:"result",id:message.invocationId,result:{output:JSON.stringify(message.result),exitCode:0}})+"\n");
      if(message.type==="close") process.exit(0);
    });
  `;
  const processRuntime = await ProcessPluginRuntime.start(
    { pluginId: "fixture", packageVersion: "1.0.0" },
    {
      command: process.execPath,
      args: ["--input-type=module", "-e", processScript],
      hostSdk: sdk,
    },
  );
  assert.equal(
    (
      await processRuntime.invoke({
        ...invocation,
        invocationId: "process-sdk",
      })
    ).output,
    '{"shared":"value"}',
  );
  await processRuntime.close();

  let firstBody: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
    firstBody ??= body;
    response.setHeader("content-type", "application/json");
    if (body.hostResult === undefined)
      response.end(
        JSON.stringify({
          version: 1,
          hostSdkVersion: 1,
          id: body.id,
          hostRequest: { id: "storage", request: { operation: "storage.get" } },
        }),
      );
    else
      response.end(
        JSON.stringify({
          version: 1,
          id: body.id,
          result: {
            output: JSON.stringify(
              (body.hostResult as { result: unknown }).result,
            ),
            exitCode: 0,
          },
        }),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const http = new HttpPluginRuntime(
    { pluginId: "fixture", packageVersion: "1.0.0" },
    { url: `http://127.0.0.1:${String(address.port)}`, hostSdk: sdk },
  );
  try {
    assert.equal(
      (await http.invoke({ ...invocation, invocationId: "http-sdk" })).output,
      '{"shared":"value"}',
    );
    assert.equal(firstBody?.hostSdkVersion, 1);
    assert.equal(JSON.stringify(firstBody).includes(root), false);
  } finally {
    await http.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await bundled.close();
    await rm(root, { recursive: true, force: true });
  }
});
