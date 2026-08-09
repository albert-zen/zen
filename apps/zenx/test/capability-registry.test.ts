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
      maxOutputBytes: 1024,
    },
    {
      name: "fixture_change",
      description: "Change fixture",
      inputSchema: { type: "object", additionalProperties: true },
      permissions: ["fixture.write"],
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

  const resource = await registry.execute(
    invocation(CAPABILITY_RESOURCE_TOOL, {
      capabilityId: "fixture",
      resourceId: "fixture-skill",
    }),
  );
  assert.match(resource.output, /Inspect before changing/u);

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
  assert.equal(audit?.toolName, "fixture_inspect");
  assert.equal(audit?.status, "completed");
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
