import assert from "node:assert/strict";
import test from "node:test";

import { MemoryZenXCapabilityGrantStore } from "../src/main/capabilities/grant-store.js";
import {
  CAPABILITY_RESOURCE_TOOL,
  ZenXCapabilityRegistry,
} from "../src/main/capabilities/registry.js";
import type {
  ZenXCapabilityManifest,
  ZenXCapabilityPackage,
} from "../src/main/capabilities/types.js";

const manifest: ZenXCapabilityManifest = {
  schemaVersion: 1,
  id: "fixture",
  displayName: "Fixture",
  version: "1.0.0",
  description: "Test capability",
  provider: {
    id: "fixture-provider",
    platforms: [process.platform],
    interactionModes: ["background_safe", "foreground_required"],
    capabilities: ["fixture.read", "fixture.write"],
  },
  permissions: [
    {
      id: "fixture.read",
      title: "Read",
      description: "Read fixture state",
      scope: "workspace",
    },
    {
      id: "fixture.write",
      title: "Write",
      description: "Write fixture state",
      scope: "workspace",
    },
  ],
  tools: [
    {
      name: "fixture_inspect",
      description: "Inspect fixture",
      inputSchema: { type: "object", additionalProperties: false },
      permissions: ["fixture.read"],
      interactionMode: "background_safe",
      capabilities: ["fixture.read"],
      maxOutputBytes: 1024,
    },
    {
      name: "fixture_change",
      description: "Change fixture",
      inputSchema: { type: "object", additionalProperties: true },
      permissions: ["fixture.write"],
      interactionMode: "foreground_required",
      capabilities: ["fixture.write", "global_input"],
    },
  ],
  resources: [
    {
      id: "fixture-skill",
      kind: "skill",
      title: "Fixture skill",
      description: "How to use the fixture",
      content: "Inspect before changing the fixture.",
    },
  ],
};

const pluginManifest: ZenXCapabilityManifest = {
  ...structuredClone(manifest),
  contributions: {
    pages: [
      {
        id: "fixture",
        title: "Fixture",
        route: "/plugins/fixture/fixture",
      },
    ],
    sidebar: [
      {
        id: "fixture",
        label: "Fixture",
        icon: "fixture",
        pageId: "fixture",
        order: 20,
      },
    ],
  },
};

test("projects enabled plugin contributions and removes tools and UI when disabled", async () => {
  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
  );
  await registry.initialize();
  registry.register(pluginPackageFixture(async () => ({ ok: true })));
  await registry.grant("fixture", ["fixture.read"]);

  assert.equal(registry.snapshot().capabilities[0]?.enabled, true);
  assert.deepEqual(registry.pluginSnapshot().sidebar, [
    {
      id: "fixture",
      key: "fixture:fixture",
      pluginId: "fixture",
      label: "Fixture",
      icon: "fixture",
      pageId: "fixture",
      order: 20,
    },
  ]);
  assert.deepEqual(
    registry.hostSnapshot().definitions.map((tool) => tool.name),
    ["fixture_inspect"],
  );

  await registry.setEnabled("fixture", false);
  assert.equal(registry.snapshot().capabilities[0]?.enabled, false);
  assert.deepEqual(registry.pluginSnapshot().sidebar, []);
  assert.deepEqual(registry.pluginSnapshot().pages, []);
  assert.deepEqual(registry.hostSnapshot().definitions, []);
  await assert.rejects(
    registry.execute(invocation("fixture_inspect", {})),
    /disabled/u,
  );

  await registry.setEnabled("fixture", true);
  assert.equal(registry.snapshot().capabilities[0]?.enabled, true);
  assert.equal(registry.pluginSnapshot().sidebar.length, 1);
});

test("failed enablement persistence leaves memory, tools, and contributions unchanged", async () => {
  const registry = new ZenXCapabilityRegistry({
    load: async () => ({ grants: {}, disabled: [] }),
    save: async () => {
      throw new Error("capability config unavailable");
    },
  });
  await registry.initialize();
  registry.register(pluginPackageFixture(async () => ({ ok: true })));
  const before = registry.snapshot();
  const beforeHost = registry.hostSnapshot();
  const beforePlugins = registry.pluginSnapshot();

  await assert.rejects(
    registry.setEnabled("fixture", false),
    /capability config unavailable/u,
  );
  assert.deepEqual(registry.snapshot(), before);
  assert.deepEqual(registry.hostSnapshot(), beforeHost);
  assert.deepEqual(registry.pluginSnapshot(), beforePlugins);
});

test("concurrent enablement mutations are serialized with the last request authoritative", async () => {
  const saves: Array<{
    disabled: string[];
    release(): void;
  }> = [];
  const registry = new ZenXCapabilityRegistry({
    load: async () => ({ grants: {}, disabled: [] }),
    save: async (configuration) =>
      await new Promise<void>((resolve) => {
        saves.push({ disabled: [...configuration.disabled], release: resolve });
      }),
  });
  await registry.initialize();
  registry.register(pluginPackageFixture(async () => ({ ok: true })));

  const disable = registry.setEnabled("fixture", false);
  const enable = registry.setEnabled("fixture", true);
  await waitUntil(() => saves.length === 1);
  assert.deepEqual(
    saves.map((save) => save.disabled),
    [["fixture"]],
  );
  saves[0]!.release();
  await waitUntil(() => saves.length === 2);
  assert.deepEqual(
    saves.map((save) => save.disabled),
    [["fixture"], []],
  );
  saves[1]!.release();
  await Promise.all([disable, enable]);

  assert.equal(registry.snapshot().capabilities[0]?.enabled, true);
  assert.equal(registry.pluginSnapshot().sidebar.length, 1);
});

test("disable closes admission, aborts accepted execution, and waits for settlement", async () => {
  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
  );
  await registry.initialize();
  let started!: () => void;
  const invocationStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const providerReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.register(
    pluginPackageFixture(async () => {
      started();
      await providerReleased;
      return { late: true };
    }),
  );
  await registry.grant("fixture", ["fixture.read"]);

  const acceptedInvocation = invocation("fixture_inspect", {});
  const call = registry.execute(acceptedInvocation);
  await invocationStarted;
  let disableSettled = false;
  const disable = registry.setEnabled("fixture", false).then(() => {
    disableSettled = true;
  });
  await waitUntil(() => registry.snapshot().capabilities[0]?.enabled === false);
  assert.equal(disableSettled, false);
  assert.deepEqual(registry.hostSnapshot().definitions, []);
  assert.deepEqual(registry.pluginSnapshot().sidebar, []);
  const rejected = registry.execute(invocation("fixture_inspect", {}));
  release();

  await assert.rejects(call, /disabled/u);
  await assert.rejects(rejected, /disabled/u);
  await disable;
  assert.equal(disableSettled, true);
  assert.equal(
    registry
      .snapshot()
      .recentInvocations.find(
        (record) => record.callId === acceptedInvocation.callId,
      )?.status,
    "cancelled",
  );
});

test("failed disable persistence leaves accepted execution admitted", async () => {
  const registry = new ZenXCapabilityRegistry({
    load: async () => ({
      grants: {
        fixture: [{ permissionId: "fixture.read", scope: "workspace" }],
      },
      disabled: [],
    }),
    save: async () => {
      throw new Error("capability config unavailable");
    },
  });
  await registry.initialize();
  let started!: () => void;
  const invocationStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const providerReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  registry.register(
    pluginPackageFixture(async () => {
      started();
      await providerReleased;
      return { completed: true };
    }),
  );

  const call = registry.execute(invocation("fixture_inspect", {}));
  await invocationStarted;
  await assert.rejects(
    registry.setEnabled("fixture", false),
    /capability config unavailable/u,
  );
  assert.equal(registry.snapshot().capabilities[0]?.enabled, true);
  release();
  assert.match((await call).output, /"completed":true/u);
  assert.equal(registry.snapshot().recentInvocations[0]?.status, "completed");
});

test("persisted disablement is authoritative when a package registers later", async () => {
  const registry = new ZenXCapabilityRegistry({
    load: async () => ({ grants: {}, disabled: ["fixture"] }),
    save: async () => undefined,
  });
  await registry.initialize();
  registry.register(pluginPackageFixture(async () => ({ ok: true })));

  assert.equal(registry.snapshot().capabilities[0]?.enabled, false);
  assert.deepEqual(registry.hostSnapshot().definitions, []);
  assert.deepEqual(registry.pluginSnapshot().sidebar, []);
});

test("registration disposal unloads package tools and contributions once", async () => {
  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
  );
  await registry.initialize();
  let closes = 0;
  const dispose = registry.register({
    ...pluginPackageFixture(async () => ({ ok: true })),
    close: () => {
      closes += 1;
    },
  });
  await registry.grant("fixture", ["fixture.read"]);
  assert.equal(registry.pluginSnapshot().sidebar.length, 1);

  await dispose();
  await dispose();
  assert.equal(closes, 1);
  assert.deepEqual(registry.pluginSnapshot().plugins, []);
  assert.deepEqual(registry.hostSnapshot().definitions, []);
});

test("rejects malformed or dangling plugin contributions", async () => {
  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
  );
  await registry.initialize();
  const invalid = structuredClone(pluginManifest);
  invalid.contributions!.sidebar![0]!.pageId = "missing";
  assert.throws(
    () => registry.register({ manifest: invalid, invoke: async () => null }),
    /unknown page missing/u,
  );
  const unsafe = structuredClone(pluginManifest);
  unsafe.contributions!.pages![0]!.route = "/settings";
  assert.throws(
    () => registry.register({ manifest: unsafe, invoke: async () => null }),
    /plugin route/u,
  );
});

test("registers, grants, revokes, and unregisters package contributions", async () => {
  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
  );
  await registry.initialize();
  registry.register(packageFixture(async () => ({ ok: true })));

  assert.deepEqual(registry.hostSnapshot().definitions, []);
  await registry.grant("fixture", ["fixture.read"]);
  assert.deepEqual(
    registry.hostSnapshot().definitions.map((tool) => tool.name),
    ["fixture_inspect"],
  );
  await registry.grant("fixture", ["fixture.write"]);
  assert.deepEqual(
    registry.hostSnapshot().definitions.map((tool) => tool.name),
    ["fixture_inspect", "fixture_change", CAPABILITY_RESOURCE_TOOL],
  );
  assert.deepEqual(registry.snapshot().capabilities[0]?.blockedTools, []);

  const resource = await registry.execute(
    invocation(CAPABILITY_RESOURCE_TOOL, {
      capabilityId: "fixture",
      resourceId: "fixture-skill",
    }),
  );
  assert.match(resource.output, /Inspect before changing/u);
  assert.match(resource.output, /"interactionMode":"background_safe"/u);
  assert.match(resource.output, /"id":"fixture-provider"/u);

  await registry.revoke("fixture", ["fixture.write"]);
  assert.deepEqual(
    registry.hostSnapshot().definitions.map((tool) => tool.name),
    ["fixture_inspect"],
  );
  await assert.rejects(
    registry.execute(invocation("fixture_change", {})),
    /not granted/u,
  );

  await registry.unregister("fixture");
  assert.deepEqual(registry.snapshot().capabilities, []);
  assert.deepEqual(registry.hostSnapshot().definitions, []);
});

test("registration disposer is idempotent and cannot remove a later registration", async () => {
  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
  );
  await registry.initialize();
  let firstCloseCount = 0;
  const disposeFirst = registry.register({
    ...packageFixture(async () => ({ generation: 1 })),
    close: () => {
      firstCloseCount += 1;
    },
  });

  await disposeFirst();
  await disposeFirst();
  assert.equal(firstCloseCount, 1);

  const disposeSecond = registry.register(
    packageFixture(async () => ({ generation: 2 })),
  );
  await disposeFirst();
  assert.equal(registry.snapshot().capabilities.length, 1);
  await disposeSecond();
  assert.equal(registry.snapshot().capabilities.length, 0);
});

test("failed grant persistence leaves snapshot and host projection unchanged", async () => {
  const registry = new ZenXCapabilityRegistry({
    load: async () => ({ grants: {}, disabled: [] }),
    save: async () => {
      throw new Error("grant store unavailable");
    },
  });
  await registry.initialize();
  registry.register(packageFixture(async () => ({ ok: true })));
  const beforeSnapshot = registry.snapshot();
  const beforeHost = registry.hostSnapshot();

  await assert.rejects(
    registry.grant("fixture", ["fixture.read"]),
    /grant store unavailable/u,
  );
  assert.deepEqual(registry.snapshot(), beforeSnapshot);
  assert.deepEqual(registry.hostSnapshot(), beforeHost);
});

test("failed revoke persistence leaves snapshot and host projection unchanged", async () => {
  const registry = new ZenXCapabilityRegistry({
    load: async () => ({
      grants: {
        fixture: [{ permissionId: "fixture.read", scope: "workspace" }],
      },
      disabled: [],
    }),
    save: async () => {
      throw new Error("grant store unavailable");
    },
  });
  await registry.initialize();
  registry.register(packageFixture(async () => ({ ok: true })));
  const beforeSnapshot = registry.snapshot();
  const beforeHost = registry.hostSnapshot();

  await assert.rejects(
    registry.revoke("fixture", ["fixture.read"]),
    /grant store unavailable/u,
  );
  assert.deepEqual(registry.snapshot(), beforeSnapshot);
  assert.deepEqual(registry.hostSnapshot(), beforeHost);
});

test("bounds ordinary provider output and projects invocation audit", async () => {
  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
  );
  await registry.initialize();
  registry.register(
    packageFixture(async () => ({
      cookie: "session=private",
      authorization: "Bearer private",
      nested: { token: "private-token" },
      diagnostic:
        "Authorization failed for Bearer visible-secret access_token=query-secret",
      visible: "x".repeat(8_000),
    })),
  );
  await registry.grant("fixture", ["fixture.read"]);

  const result = await registry.execute(invocation("fixture_inspect", {}));
  assert.ok(Buffer.byteLength(result.output, "utf8") <= 1024);
  assert.match(result.output, /private/u);
  assert.match(result.output, /truncated/u);
  const [audit] = registry.snapshot().recentInvocations;
  assert.equal(audit?.capabilityId, "fixture");
  assert.equal(audit?.providerId, "fixture-provider");
  assert.equal(audit?.toolName, "fixture_inspect");
  assert.equal(audit?.status, "completed");
  assert.equal(audit?.interactionMode, "background_safe");
});

test("rejects unsafe output bounds and still bounds oversized metadata", async () => {
  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
  );
  await registry.initialize();
  for (const maxOutputBytes of [-1, 512, 1024.5, 1024 * 1024 + 1]) {
    const invalid = structuredClone(manifest);
    invalid.id = `invalid-${String(maxOutputBytes).replace(/\W/gu, "-")}`;
    invalid.tools[0]!.maxOutputBytes = maxOutputBytes;
    assert.throws(
      () =>
        registry.register({
          manifest: invalid,
          invoke: async () => null,
        }),
      /maxOutputBytes must be an integer between 1024 and 1048576/u,
    );
  }

  const metadataHeavy = structuredClone(manifest);
  metadataHeavy.id = "metadata-heavy";
  metadataHeavy.provider.id = "provider-" + "p".repeat(4_000);
  metadataHeavy.tools[0]!.capabilities = ["c".repeat(4_000)];
  registry.register({
    manifest: metadataHeavy,
    invoke: async () => ({ ok: true }),
  });
  await registry.grant("metadata-heavy", ["fixture.read"]);
  const result = await registry.execute(invocation("fixture_inspect", {}));
  assert.ok(Buffer.byteLength(result.output, "utf8") <= 1024);
  assert.match(result.output, /metadata exceeded the configured output bound/u);
});

test("can restrict foreground-required tools without conflating restriction with grants", async () => {
  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
    { allowForegroundRequired: false },
  );
  await registry.initialize();
  registry.register(packageFixture(async () => ({ changed: true })));
  await registry.grant("fixture", ["fixture.write"]);
  assert.deepEqual(
    registry.hostSnapshot().definitions.map((tool) => tool.name),
    [],
  );
  assert.deepEqual(registry.snapshot().capabilities[0]?.blockedTools, [
    "fixture_change",
  ]);
  await assert.rejects(
    registry.execute(invocation("fixture_change", {})),
    /foreground_required.*background-safe execution only/u,
  );
});

test("negotiates provider platforms without leaking platform types into tools", async () => {
  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
    { platform: "unsupported-test-platform" },
  );
  await registry.initialize();
  registry.register(packageFixture(async () => ({ ok: true })));
  await registry.grant("fixture", ["fixture.read"]);
  assert.deepEqual(registry.hostSnapshot().definitions, []);
  const capability = registry.snapshot().capabilities[0];
  assert.equal(capability?.available, false);
  assert.match(capability?.unavailableReason ?? "", /does not support/u);
  await assert.rejects(
    registry.execute(invocation("fixture_inspect", {})),
    /does not support unsupported-test-platform/u,
  );
});

test("rejects duplicate tool ownership", async () => {
  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
  );
  await registry.initialize();
  registry.register(packageFixture(async () => null));
  assert.throws(
    () =>
      registry.register({
        ...packageFixture(async () => null),
        manifest: { ...manifest, id: "other" },
      }),
    /already registered/u,
  );
});

test("projects an invocation cancelled while its provider is finishing", async () => {
  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
  );
  const controller = new AbortController();
  await registry.initialize();
  registry.register(
    packageFixture(async () => {
      controller.abort(new DOMException("stopped", "AbortError"));
      return { late: true };
    }),
  );
  await registry.grant("fixture", ["fixture.read"]);
  await assert.rejects(
    registry.execute({
      ...invocation("fixture_inspect", {}),
      signal: controller.signal,
    }),
    /stopped/u,
  );
  assert.equal(registry.snapshot().recentInvocations[0]?.status, "cancelled");
});

test("keeps the newest browser screenshot projection when inspections finish out of order", async () => {
  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
  );
  await registry.initialize();
  const browserManifest = structuredClone(manifest);
  browserManifest.id = "browser";
  browserManifest.tools = [
    {
      ...browserManifest.tools[0]!,
      name: "browser_inspect",
    },
  ];
  let releaseFirst: (() => void) | undefined;
  let calls = 0;
  const firstFinished = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  registry.register({
    manifest: browserManifest,
    invoke: async () => {
      calls += 1;
      if (calls === 1) await firstFinished;
      return {
        screenshot: {
          artifactPath: `/tmp/observation-${String(calls)}.png`,
          observationId: `observation-${String(calls)}`,
          status: "captured",
          width: 1,
          height: 1,
          bytes: 68,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      };
    },
  });
  await registry.grant("browser", ["fixture.read"]);
  const first = registry.execute(invocation("browser_inspect", {}));
  await new Promise((resolve) => setImmediate(resolve));
  await registry.execute(invocation("browser_inspect", {}));
  assert.equal(
    registry.snapshot().currentScreenshot?.observationId,
    "observation-2",
  );
  releaseFirst?.();
  await first;
  assert.equal(
    registry.snapshot().currentScreenshot?.observationId,
    "observation-2",
  );
  await registry.unregister("browser");
  assert.equal(registry.snapshot().currentScreenshot, undefined);
});

test("transient capability reset clears browser projection without changing grants or audit", async () => {
  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
  );
  await registry.initialize();
  const browserManifest = structuredClone(manifest);
  browserManifest.id = "browser";
  browserManifest.tools = [
    { ...browserManifest.tools[0]!, name: "browser_inspect" },
  ];
  registry.register({
    manifest: browserManifest,
    invoke: async () => ({
      screenshot: {
        artifactPath: "/tmp/restart.png",
        observationId: "restart-observation",
        status: "captured",
        width: 1,
        height: 1,
        bytes: 68,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
  });
  await registry.grant("browser", ["fixture.read"]);
  await registry.execute(invocation("browser_inspect", {}));
  const before = registry.snapshot();
  await registry.resetTransient();
  const after = registry.snapshot();
  assert.equal(after.currentScreenshot, undefined);
  assert.deepEqual(
    after.capabilities[0]?.granted,
    before.capabilities[0]?.granted,
  );
  assert.equal(after.recentInvocations.length, before.recentInvocations.length);
});

function packageFixture(
  invoke: ZenXCapabilityPackage["invoke"],
): ZenXCapabilityPackage {
  return { manifest: structuredClone(manifest), invoke };
}

function pluginPackageFixture(
  invoke: ZenXCapabilityPackage["invoke"],
): ZenXCapabilityPackage {
  return { manifest: structuredClone(pluginManifest), invoke };
}

let invocationSequence = 0;

function invocation(name: string, arguments_: Record<string, unknown>) {
  invocationSequence += 1;
  return {
    callId: `call-${name}-${String(invocationSequence)}`,
    name,
    arguments: arguments_,
    cwd: "/workspace",
    signal: new AbortController().signal,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for registry state");
}
