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

test("bounds and redacts provider output and projects invocation audit", async () => {
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
  assert.doesNotMatch(result.output, /private/u);
  assert.doesNotMatch(result.output, /visible-secret|query-secret/u);
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

function packageFixture(
  invoke: ZenXCapabilityPackage["invoke"],
): ZenXCapabilityPackage {
  return { manifest: structuredClone(manifest), invoke };
}

function invocation(name: string, arguments_: Record<string, unknown>) {
  return {
    callId: "call-1",
    name,
    arguments: arguments_,
    cwd: "/workspace",
    signal: new AbortController().signal,
  };
}
