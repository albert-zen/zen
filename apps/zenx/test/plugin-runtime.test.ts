import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import test from "node:test";
import os from "node:os";
import path from "node:path";

import { ZenAppServer } from "../../../src/app-server.js";
import { InMemoryThreadJournal } from "../../../src/journal.js";
import { StaticModelCatalog } from "../../../src/model-catalog.js";
import type { ModelAdapter, ModelEvent } from "../../../src/model.js";
import { ProviderRegistry } from "../../../src/provider-registry.js";
import { AgentRuntime } from "../../../src/runtime.js";
import { InMemoryThreadMetadataStore } from "../../../src/thread-metadata.js";
import { ToolEnvironment } from "../../../src/tool.js";
import { ZenXCapabilityRegistry } from "../src/main/capabilities/registry.js";
import type {
  RegisteredZenXCapability,
  ZenXCapabilityConfiguration,
  ZenXCapabilityPackage,
  ZenXCapabilitySnapshot,
  ZenXPluginManifestV2,
} from "../src/main/capabilities/types.js";
import {
  BundledModulePluginRuntime,
  CatalogPluginRuntimeLifecycle,
  HttpPluginRuntime,
  PluginRuntimeSupervisor,
  ProcessPluginRuntime,
  bundledPackageRegistration,
  type PluginRuntimeRegistration,
} from "../src/main/plugin-runtime.js";

const exactTrace =
  'model/runtime bytes: sk-fixture\n<raw-json>{"x":1}</raw-json>';

test("bundled runtime routes through Tool Environment verbatim while human invocation creates no Turn", async () => {
  const environment = new ToolEnvironment();
  const supervisor = new PluginRuntimeSupervisor(environment);
  let closes = 0;
  await supervisor.start(
    bundledRegistration(
      "fixture",
      async () => ({ output: exactTrace, exitCode: 7 }),
      () => {
        closes += 1;
      },
    ),
  );
  const journal = new InMemoryThreadJournal();

  assert.deepEqual(
    await supervisor.invoke("fixture", {
      tool: "fixture_echo",
      arguments: { raw: exactTrace },
      context: { callId: "human-call", cwd: process.cwd() },
      signal: new AbortController().signal,
    }),
    { output: exactTrace, exitCode: 7 },
  );
  assert.deepEqual(await journal.listThreadIds(), []);
  await assert.rejects(
    supervisor.invoke("fixture", {
      tool: "other_tool",
      arguments: {},
      context: { callId: "human-forged", cwd: process.cwd() },
      signal: new AbortController().signal,
    }),
    /does not own tool/u,
  );

  const appServer = appServerCalling("fixture_echo", environment, journal);
  const thread = await appServer.startThread();
  await (
    await appServer.startTurn(thread.id, "call plugin")
  ).done;
  const snapshot = await appServer.readThread(thread.id);
  const result = snapshot.items.find((item) => item.type === "tool_result");
  assert(result?.type === "tool_result");
  assert.equal(result.output, exactTrace);
  assert.equal(result.exitCode, 7);
  assert.equal(
    snapshot.items.filter((item) => item.type === "tool_call").length,
    1,
  );
  assert.equal(
    snapshot.items.filter((item) => item.type === "tool_result").length,
    1,
  );

  await supervisor.close();
  assert.equal(closes, 1);
});

test("runtime ownership is unique and disable drains an admitted call before revoking new admission", async () => {
  const environment = new ToolEnvironment();
  const supervisor = new PluginRuntimeSupervisor(environment);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closed = false;
  await supervisor.start(
    bundledRegistration(
      "fixture",
      async () => {
        await gate;
        return { output: "settled", exitCode: 0 };
      },
      () => {
        closed = true;
      },
    ),
  );
  await assert.rejects(
    supervisor.start(
      bundledRegistration("fixture", async () => ({
        output: "duplicate",
        exitCode: 0,
      })),
    ),
    /already registered/u,
  );
  await assert.rejects(
    supervisor.start(
      bundledRegistration("fixture", async () => ({
        output: "duplicate tool",
        exitCode: 0,
      })),
    ),
    /already registered/u,
  );
  const collisionEnvironment = new ToolEnvironment({
    providers: [
      {
        identity: { kind: "external", id: "collision" },
        definitions: [
          {
            name: "other_echo",
            description: "Owned",
            inputSchema: { type: "object" },
          },
        ],
        execute: async () => ({ output: "owned", exitCode: 0 }),
      },
    ],
  });
  const collisionSupervisor = new PluginRuntimeSupervisor(collisionEnvironment);
  await assert.rejects(
    collisionSupervisor.start(
      bundledRegistration("other", async () => ({
        output: "duplicate tool",
        exitCode: 0,
      })),
    ),
    /Tool is already registered/u,
  );

  const prepared = environment.prepare(invocation("fixture_echo", "prepared"));
  const stopping = supervisor.stop("fixture");
  await Promise.resolve();
  assert.throws(
    () => environment.prepare(invocation("fixture_echo", "new")),
    /Unsupported tool/u,
  );
  const executing = environment.execute(prepared);
  assert.equal(closed, false);
  release();
  assert.deepEqual(await executing, { output: "settled", exitCode: 0 });
  await stopping;
  assert.equal(closed, true);
});

test("local process runtime executes, cancels, closes, and never retries failures", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-plugin-runtime-"),
  );
  const lifecyclePath = path.join(temporaryDirectory, "lifecycle.txt");
  const script = String.raw`
    import readline from "node:readline";
    import { appendFileSync } from "node:fs";
    const rl = readline.createInterface({ input: process.stdin });
    process.stdout.write(JSON.stringify({version:1,type:"ready",pluginId:"process-fixture",packageVersion:"1.0.0"})+"\n");
    rl.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "invoke" && message.tool === "process_fixture_echo") {
        process.stdout.write(JSON.stringify({version:1,type:"result",id:message.id,result:{output:message.arguments.value,exitCode:0}})+"\n");
      }
      if (message.type === "cancel") appendFileSync(process.argv[1], "cancel:"+message.id+"\n");
      if (message.type === "close") { appendFileSync(process.argv[1], "close\n"); process.exit(0); }
    });
  `;
  const runtime = await ProcessPluginRuntime.start(
    { pluginId: "process-fixture", packageVersion: "1.0.0" },
    {
      command: process.execPath,
      args: ["--input-type=module", "-e", script, lifecyclePath],
    },
  );
  assert.deepEqual(
    await runtime.invoke(
      runtimeInvocation("process_fixture_echo", "process-ok", {
        value: exactTrace,
      }),
    ),
    { output: exactTrace, exitCode: 0 },
  );
  const controller = new AbortController();
  const waiting = runtime.invoke(
    runtimeInvocation(
      "process_fixture_wait",
      "process-cancel",
      {},
      controller.signal,
    ),
  );
  controller.abort(new DOMException("cancel requested", "AbortError"));
  await assert.rejects(waiting, /cancel requested/u);
  await waitUntil(async () =>
    (await readFile(lifecyclePath, "utf8").catch(() => "")).includes(
      "cancel:process-cancel",
    ),
  );
  await runtime.close();
  assert.match(await readFile(lifecyclePath, "utf8"), /close/u);
  await assert.rejects(
    runtime.invoke(runtimeInvocation("process_fixture_echo", "after-close")),
    /closed/u,
  );

  for (const [body, pattern] of [
    ['process.stdout.write("not-json\\n")', /malformed protocol/u],
    ['process.stdout.write("x".repeat(2048))', /message limit/u],
    ["process.exit(23)", /exited unexpectedly/u],
  ] as const) {
    const failing = await ProcessPluginRuntime.start(
      { pluginId: "process-fixture", packageVersion: "1.0.0" },
      {
        command: process.execPath,
        args: [
          "--input-type=module",
          "-e",
          `process.stdout.write(JSON.stringify({version:1,type:"ready",pluginId:"process-fixture",packageVersion:"1.0.0"})+"\\n"); process.stdin.once("data",()=>{${body}});`,
        ],
        maxMessageBytes: 1024,
      },
    );
    await assert.rejects(
      failing.invoke(runtimeInvocation("process_fixture_echo", "failure-1")),
      pattern,
    );
    await assert.rejects(
      failing.invoke(runtimeInvocation("process_fixture_echo", "failure-2")),
      pattern,
    );
    await failing.close();
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("HTTP runtime executes, propagates abort, detaches on close, and makes one failed request", async () => {
  let requests = 0;
  let aborted = false;
  const server = createServer(async (request, response) => {
    requests += 1;
    const body = await readRequest(request);
    if (body.tool === "http_fixture_wait") {
      request.once("close", () => {
        aborted = true;
      });
      response.once("close", () => {
        aborted = true;
      });
      return;
    }
    if (body.tool === "http_fixture_fail") {
      response.writeHead(503).end("unavailable");
      return;
    }
    sendJson(response, {
      version: 1,
      id: body.id,
      result: { output: body.arguments.value, exitCode: 0 },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const runtime = new HttpPluginRuntime(
    { pluginId: "http-fixture", packageVersion: "1.0.0" },
    { url: `http://127.0.0.1:${String(address.port)}/invoke` },
  );
  try {
    assert.deepEqual(
      await runtime.invoke(
        runtimeInvocation("http_fixture_echo", "http-ok", {
          value: exactTrace,
        }),
      ),
      { output: exactTrace, exitCode: 0 },
    );
    const controller = new AbortController();
    const pending = runtime.invoke(
      runtimeInvocation(
        "http_fixture_wait",
        "http-cancel",
        {},
        controller.signal,
      ),
    );
    await waitUntil(() => requests === 2);
    controller.abort(new DOMException("http cancelled", "AbortError"));
    await assert.rejects(pending, /http cancelled|aborted/u);
    await waitUntil(() => aborted);
    await assert.rejects(
      runtime.invoke(runtimeInvocation("http_fixture_fail", "http-fail")),
      /HTTP 503/u,
    );
    assert.equal(requests, 3);
    await runtime.close();
    await assert.rejects(
      runtime.invoke(runtimeInvocation("http_fixture_echo", "after-close")),
      /closed/u,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Catalog lifecycle transactionally registers and revokes the runtime provider", async () => {
  const environment = new ToolEnvironment();
  const supervisor = new PluginRuntimeSupervisor(environment);
  const lifecycle = new CatalogPluginRuntimeLifecycle({
    supervisor,
    registrationFor: bundledPackageRegistration,
  });
  let failSave = false;
  const registry = new ZenXCapabilityRegistry(
    {
      load: async () => ({
        grants: {},
        disabled: [],
        uninstalled: [],
        packages: {},
      }),
      save: async () => {
        if (failSave) throw new Error("catalog persistence failed");
      },
    },
    { pluginRuntimeLifecycle: lifecycle },
  );
  await registry.initialize();
  const runtimePackage = pluginPackage();
  await registry.install(runtimePackage, "bundled");
  assert.deepEqual(
    environment.definitions.map((definition) => definition.name),
    ["fixture_echo"],
  );

  await registry.setEnabled("fixture", false);
  assert.deepEqual(environment.definitions, []);
  await assert.rejects(
    supervisor.invoke("fixture", runtimeInvocation("fixture_echo", "disabled")),
    /not enabled/u,
  );
  await registry.setEnabled("fixture", true);
  assert.equal(
    (
      await supervisor.invoke(
        "fixture",
        runtimeInvocation("fixture_echo", "enabled"),
      )
    ).output,
    exactTrace,
  );
  await registry.uninstall("fixture");
  assert.deepEqual(environment.definitions, []);
  await assert.rejects(
    supervisor.invoke(
      "fixture",
      runtimeInvocation("fixture_echo", "uninstalled"),
    ),
    /not enabled/u,
  );

  const failedEnvironment = new ToolEnvironment();
  const failedSupervisor = new PluginRuntimeSupervisor(failedEnvironment);
  const failedRegistry = new ZenXCapabilityRegistry(
    {
      load: async () => ({
        grants: {},
        disabled: [],
        uninstalled: [],
        packages: {},
      }),
      save: async () => {
        throw new Error("catalog persistence failed");
      },
    },
    {
      pluginRuntimeLifecycle: new CatalogPluginRuntimeLifecycle({
        supervisor: failedSupervisor,
        registrationFor: bundledPackageRegistration,
      }),
    },
  );
  await failedRegistry.initialize();
  await assert.rejects(
    failedRegistry.install(pluginPackage(), "bundled"),
    /catalog persistence failed/u,
  );
  assert.deepEqual(failedEnvironment.definitions, []);

  const collisionEnvironment = new ToolEnvironment({
    providers: [
      {
        identity: { kind: "external", id: "existing-owner" },
        definitions: [
          {
            name: "fixture_echo",
            description: "Existing owner",
            inputSchema: { type: "object" },
          },
        ],
        execute: async () => ({ output: "existing", exitCode: 0 }),
      },
    ],
  });
  const collisionRegistry = new ZenXCapabilityRegistry(
    {
      load: async () => ({
        grants: {},
        disabled: [],
        uninstalled: [],
        packages: {},
      }),
      save: async () => {},
    },
    {
      pluginRuntimeLifecycle: new CatalogPluginRuntimeLifecycle({
        supervisor: new PluginRuntimeSupervisor(collisionEnvironment),
        registrationFor: bundledPackageRegistration,
      }),
    },
  );
  await collisionRegistry.initialize();
  await assert.rejects(
    collisionRegistry.install(pluginPackage(), "bundled"),
    /Tool is already registered/u,
  );
  assert.deepEqual(collisionRegistry.pluginSnapshot().plugins, []);
  assert.deepEqual(
    collisionEnvironment.definitions.map((definition) => definition.name),
    ["fixture_echo"],
  );

  failSave = false;
  const startFailure = new ZenXCapabilityRegistry(
    {
      load: async () => ({
        grants: {},
        disabled: [],
        uninstalled: [],
        packages: {},
      }),
      save: async () => {
        failSave = true;
      },
    },
    {
      pluginRuntimeLifecycle: {
        stage: async () => {
          throw new Error("runtime start failed");
        },
        stop: async () => {},
      },
    },
  );
  await startFailure.initialize();
  await assert.rejects(
    startFailure.install(pluginPackage(), "bundled"),
    /runtime start failed/u,
  );
  assert.equal(failSave, false);
  assert.deepEqual(startFailure.pluginSnapshot().plugins, []);
});

test("Catalog keeps a staged runtime unpublished until install persistence commits", async () => {
  const environment = new ToolEnvironment();
  const supervisor = new PluginRuntimeSupervisor(environment);
  const saveStarted = deferred<void>();
  const releaseSave = deferred<void>();
  let starts = 0;
  const registry = new ZenXCapabilityRegistry(
    {
      load: async () => emptyCapabilityConfiguration(),
      save: async () => {
        saveStarted.resolve();
        await releaseSave.promise;
      },
    },
    {
      pluginRuntimeLifecycle: new CatalogPluginRuntimeLifecycle({
        supervisor,
        registrationFor: countingRegistrationFor(() => {
          starts += 1;
        }),
      }),
    },
  );
  await registry.initialize();

  const installing = registry.install(pluginPackage(), "bundled");
  await saveStarted.promise;
  assert.equal(starts, 1);
  assert.deepEqual(environment.definitions, []);
  assert.throws(
    () => environment.prepare(invocation("fixture_echo", "too-early")),
    /Unsupported tool/u,
  );
  releaseSave.resolve();
  await installing;
  assert.deepEqual(toolNames(environment), ["fixture_echo"]);
});

test("failed install persistence never publishes its staged runtime", async () => {
  const environment = new ToolEnvironment();
  const supervisor = new PluginRuntimeSupervisor(environment);
  const saveStarted = deferred<void>();
  const releaseSave = deferred<void>();
  let closes = 0;
  const registry = new ZenXCapabilityRegistry(
    {
      load: async () => emptyCapabilityConfiguration(),
      save: async () => {
        saveStarted.resolve();
        await releaseSave.promise;
        throw new Error("catalog save failed");
      },
    },
    {
      pluginRuntimeLifecycle: new CatalogPluginRuntimeLifecycle({
        supervisor,
        registrationFor: (registration) => {
          const runtime = bundledPackageRegistration(registration);
          return {
            ...runtime,
            start: async () => {
              const started = await runtime.start();
              return {
                ...started,
                close: async () => {
                  closes += 1;
                  await started.close();
                },
              };
            },
          };
        },
      }),
    },
  );
  await registry.initialize();

  const installing = registry.install(pluginPackage(), "bundled");
  await saveStarted.promise;
  assert.deepEqual(environment.definitions, []);
  releaseSave.resolve();
  await assert.rejects(installing, /catalog save failed/u);
  assert.equal(closes, 1);
  assert.deepEqual(environment.definitions, []);
  assert.deepEqual(registry.pluginSnapshot().plugins, []);
});

test("disabled reinstall stays installed without staging or publishing a runtime", async () => {
  const environment = new ToolEnvironment();
  const supervisor = new PluginRuntimeSupervisor(environment);
  let starts = 0;
  let durable = emptyCapabilityConfiguration();
  const registry = new ZenXCapabilityRegistry(
    {
      load: async () => structuredClone(durable),
      save: async (configuration) => {
        durable = structuredClone(configuration);
      },
    },
    {
      pluginRuntimeLifecycle: new CatalogPluginRuntimeLifecycle({
        supervisor,
        registrationFor: countingRegistrationFor(() => {
          starts += 1;
        }),
      }),
    },
  );
  await registry.initialize();
  await registry.install(pluginPackage(), "bundled");
  assert.equal(starts, 1);
  await registry.setEnabled("fixture", false);
  await registry.uninstall("fixture");

  await registry.reinstall("fixture");
  assert.equal(starts, 1);
  assert.equal(registry.pluginSnapshot().plugins[0]?.lifecycle, "installed");
  assert.deepEqual(environment.definitions, []);
  await registry.setEnabled("fixture", true);
  assert.equal(starts, 2);
  assert.equal(registry.pluginSnapshot().plugins[0]?.lifecycle, "enabled");
  assert.deepEqual(toolNames(environment), ["fixture_echo"]);
});

test("publish failure restores durable catalog and closes the staged runtime", async () => {
  const environment = new ToolEnvironment({
    providers: [
      {
        identity: { kind: "external", id: "existing" },
        definitions: [
          {
            name: "fixture_echo",
            description: "Existing owner",
            inputSchema: { type: "object" },
          },
        ],
        execute: async () => ({ output: "existing", exitCode: 0 }),
      },
    ],
  });
  const supervisor = new PluginRuntimeSupervisor(environment);
  let durable = emptyCapabilityConfiguration();
  let closes = 0;
  const registry = new ZenXCapabilityRegistry(
    {
      load: async () => structuredClone(durable),
      save: async (configuration) => {
        durable = structuredClone(configuration);
      },
    },
    {
      pluginRuntimeLifecycle: new CatalogPluginRuntimeLifecycle({
        supervisor,
        registrationFor: (registration) => {
          const runtime = bundledPackageRegistration(registration);
          return {
            ...runtime,
            start: async () => {
              const started = await runtime.start();
              return {
                ...started,
                close: async () => {
                  closes += 1;
                  await started.close();
                },
              };
            },
          };
        },
      }),
    },
  );
  await registry.initialize();
  await assert.rejects(
    registry.install(pluginPackage(), "bundled"),
    /Tool is already registered/u,
  );
  assert.equal(closes, 1);
  assert.deepEqual(durable, emptyCapabilityConfiguration());
  assert.deepEqual(registry.pluginSnapshot().plugins, []);
  assert.deepEqual(
    environment.definitions.map((definition) => definition.name),
    ["fixture_echo"],
  );
});

test("failed disable and uninstall close admission during save then restore the enabled provider", async () => {
  const environment = new ToolEnvironment();
  const supervisor = new PluginRuntimeSupervisor(environment);
  let durable = emptyCapabilityConfiguration();
  let blockedSave:
    | {
        started: ReturnType<typeof deferred<void>>;
        gate: ReturnType<typeof deferred<void>>;
      }
    | undefined;
  const registry = new ZenXCapabilityRegistry(
    {
      load: async () => structuredClone(durable),
      save: async (configuration) => {
        const blocked = blockedSave;
        if (blocked !== undefined) {
          blocked.started.resolve();
          await blocked.gate.promise;
        }
        durable = structuredClone(configuration);
      },
    },
    {
      pluginRuntimeLifecycle: new CatalogPluginRuntimeLifecycle({
        supervisor,
        registrationFor: bundledPackageRegistration,
      }),
    },
  );
  await registry.initialize();
  await registry.install(pluginPackage(), "bundled");

  for (const operation of [
    async () => await registry.setEnabled("fixture", false),
    async () => await registry.uninstall("fixture"),
  ]) {
    const prepared = environment.prepare(
      invocation("fixture_echo", randomTestId()),
    );
    const started = deferred<void>();
    const gate = deferred<void>();
    blockedSave = { started, gate };
    const mutation = operation();
    await definitionsDisappear(environment);
    assert.deepEqual(await environment.execute(prepared), {
      output: exactTrace,
      exitCode: 0,
    });
    await started.promise;
    assert.throws(
      () => environment.prepare(invocation("fixture_echo", randomTestId())),
      /Unsupported tool/u,
    );
    gate.reject(new Error("catalog save failed"));
    await assert.rejects(mutation, /catalog save failed/u);
    blockedSave = undefined;
    assert.equal(registry.pluginSnapshot().plugins[0]?.lifecycle, "enabled");
    assert.deepEqual(
      environment.definitions.map((definition) => definition.name),
      ["fixture_echo"],
    );
    const restored = environment.prepare(
      invocation("fixture_echo", randomTestId()),
    );
    assert.deepEqual(await environment.execute(restored), {
      output: exactTrace,
      exitCode: 0,
    });
  }
});

test("runtime close failure rolls back disable admission to an enabled provider", async () => {
  const environment = new ToolEnvironment();
  const supervisor = new PluginRuntimeSupervisor(environment);
  let durable = emptyCapabilityConfiguration();
  let starts = 0;
  const registry = new ZenXCapabilityRegistry(
    {
      load: async () => structuredClone(durable),
      save: async (configuration) => {
        durable = structuredClone(configuration);
      },
    },
    {
      pluginRuntimeLifecycle: new CatalogPluginRuntimeLifecycle({
        supervisor,
        registrationFor: (registration) => {
          const runtime = bundledPackageRegistration(registration);
          return {
            ...runtime,
            start: async () => {
              starts += 1;
              const generation = starts;
              const started = await runtime.start();
              return {
                identity: started.identity,
                invoke: async (invocation) => await started.invoke(invocation),
                close: async () => {
                  if (generation === 1) throw new Error("runtime close failed");
                  await started.close();
                },
              };
            },
          };
        },
      }),
    },
  );
  await registry.initialize();
  await registry.install(pluginPackage(), "bundled");

  await assert.rejects(
    registry.setEnabled("fixture", false),
    /runtime close failed/u,
  );
  assert.equal(starts, 2);
  assert.equal(registry.pluginSnapshot().plugins[0]?.lifecycle, "enabled");
  assert.deepEqual(toolNames(environment), ["fixture_echo"]);
  assert.deepEqual(
    await environment.execute(
      environment.prepare(invocation("fixture_echo", randomTestId())),
    ),
    { output: exactTrace, exitCode: 0 },
  );
});

test("throwing Catalog listeners cannot fail lifecycle commits or block later listeners", async () => {
  const environment = new ToolEnvironment();
  const supervisor = new PluginRuntimeSupervisor(environment);
  let durable = emptyCapabilityConfiguration();
  const observed: ZenXCapabilitySnapshot[] = [];
  const warnings: string[] = [];
  const registry = new ZenXCapabilityRegistry(
    {
      load: async () => structuredClone(durable),
      save: async (configuration) => {
        durable = structuredClone(configuration);
      },
    },
    {
      pluginRuntimeLifecycle: new CatalogPluginRuntimeLifecycle({
        supervisor,
        registrationFor: bundledPackageRegistration,
      }),
    },
  );
  await registry.initialize();
  registry.onChange(() => {
    throw new Error(`listener failed ${"x".repeat(2_000)}`);
  });
  registry.onChange((snapshot) => {
    observed.push(snapshot);
  });
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };

  try {
    let observedBefore = observed.length;
    await registry.install(pluginPackage(), "bundled");
    assert.ok(observed.length > observedBefore);
    assert.equal(registry.pluginSnapshot().plugins[0]?.lifecycle, "enabled");
    assert.deepEqual(toolNames(environment), ["fixture_echo"]);

    await registry.setEnabled("fixture", false);
    assert.equal(registry.pluginSnapshot().plugins[0]?.lifecycle, "installed");
    assert.deepEqual(environment.definitions, []);
    observedBefore = observed.length;
    await registry.setEnabled("fixture", true);
    assert.ok(observed.length > observedBefore);
    assert.equal(registry.pluginSnapshot().plugins[0]?.lifecycle, "enabled");
    assert.deepEqual(toolNames(environment), ["fixture_echo"]);

    await registry.uninstall("fixture");
    assert.equal(
      registry.pluginSnapshot().plugins[0]?.lifecycle,
      "uninstalled",
    );
    assert.deepEqual(environment.definitions, []);
    observedBefore = observed.length;
    await registry.reinstall("fixture");
    assert.ok(observed.length > observedBefore);
    assert.equal(registry.pluginSnapshot().plugins[0]?.lifecycle, "enabled");
    assert.deepEqual(toolNames(environment), ["fixture_echo"]);
    assert.deepEqual(
      await environment.execute(
        environment.prepare(invocation("fixture_echo", randomTestId())),
      ),
      { output: exactTrace, exitCode: 0 },
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(warnings.length >= 3);
  assert.ok(warnings.every((warning) => warning.length < 700));
  assert.equal(
    observed
      .at(-1)
      ?.capabilities.find((capability) => capability.manifest.id === "fixture")
      ?.enabled,
    true,
  );
});

function bundledRegistration(
  pluginId: string,
  invoke: () => Promise<{ output: string; exitCode: number }>,
  close?: () => void,
  tool = `${pluginId.replaceAll("-", "_")}_echo`,
): PluginRuntimeRegistration {
  return {
    identity: { pluginId, packageVersion: "1.0.0" },
    definitions: [
      { name: tool, description: "Fixture", inputSchema: { type: "object" } },
    ],
    start: async () =>
      new BundledModulePluginRuntime(
        { pluginId, packageVersion: "1.0.0" },
        { invoke: async () => await invoke(), close },
      ),
  };
}

function countingRegistrationFor(onStart: () => void) {
  return (
    registration: RegisteredZenXCapability,
  ): PluginRuntimeRegistration => {
    const runtime = bundledPackageRegistration(registration);
    return {
      ...runtime,
      start: async (sdk) => {
        onStart();
        return await runtime.start(sdk);
      },
    };
  };
}

function emptyCapabilityConfiguration(): ZenXCapabilityConfiguration {
  return { grants: {}, disabled: [], uninstalled: [], packages: {} };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let testSequence = 0;
function randomTestId(): string {
  testSequence += 1;
  return `test-${String(testSequence)}`;
}

async function definitionsDisappear(
  environment: ToolEnvironment,
): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (environment.definitions.length === 0) return;
    await Promise.resolve();
  }
  throw new Error("plugin provider remained visible");
}

function toolNames(environment: ToolEnvironment): string[] {
  return environment.definitions.map((definition) => definition.name);
}

function invocation(name: string, callId: string) {
  return {
    callId,
    name,
    arguments: {},
    cwd: process.cwd(),
    signal: new AbortController().signal,
  };
}

function runtimeInvocation(
  tool: string,
  invocationId: string,
  arguments_: Record<string, unknown> = {},
  signal = new AbortController().signal,
) {
  return {
    invocationId,
    tool,
    arguments: arguments_,
    context: { callId: invocationId, cwd: process.cwd() },
    signal,
  };
}

function appServerCalling(
  tool: string,
  environment: ToolEnvironment,
  journal: InMemoryThreadJournal,
): ZenAppServer {
  const model: ModelAdapter = {
    provider: "plugin-fixture-model",
    async *stream(request): AsyncIterable<ModelEvent> {
      if (request.messages.at(-1)?.role === "tool") {
        yield { type: "text_delta", delta: "done" };
        return;
      }
      yield {
        type: "tool_call",
        callId: "agent-plugin-call",
        name: tool,
        arguments: {},
      };
    },
  };
  return new ZenAppServer({
    journal,
    runtime: new AgentRuntime({ toolEnvironment: environment }),
    providerRegistry: new ProviderRegistry([
      {
        providerProfileId: model.provider,
        adapter: model,
        modelCatalog: new StaticModelCatalog([
          { id: "fixture-model", isDefault: true },
        ]),
      },
    ]),
    threadMetadata: new InMemoryThreadMetadataStore(),
    defaults: {
      cwd: process.cwd(),
      providerProfileId: model.provider,
      modelId: "fixture-model",
      reasoningEffort: "medium",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
  });
}

function pluginManifest(): ZenXPluginManifestV2 {
  return {
    schemaVersion: 2,
    id: "fixture",
    name: "Fixture",
    version: "1.0.0",
    description: "Fixture plugin",
    compatibility: { zenx: ">=0.1.0 <0.2.0" },
    runtime: { type: "bundled", entry: "fixture" },
    mainDocument: "Use fixture_echo.",
    provider: {
      id: "fixture-provider",
      platforms: ["*"],
      interactionModes: ["background_safe"],
      capabilities: ["fixture.echo"],
    },
    permissions: [],
    tools: [
      {
        name: "fixture_echo",
        description: "Echo",
        inputSchema: { type: "object" },
        permissions: [],
        interactionMode: "background_safe",
        capabilities: ["fixture.echo"],
      },
    ],
    resources: [],
  };
}

function pluginPackage(): ZenXCapabilityPackage {
  return {
    manifest: pluginManifest(),
    invoke: async () => ({ output: exactTrace, exitCode: 0 }),
  };
}

async function readRequest(
  request: IncomingMessage,
): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    any
  >;
}

function sendJson(response: ServerResponse, value: unknown): void {
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify(value));
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
