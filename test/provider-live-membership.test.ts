import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderRegistry,
  type ProviderProfile,
} from "../src/provider-registry.js";
import { StaticModelCatalog } from "../src/model-catalog.js";
function profile(provider: string): ProviderProfile {
  return {
    providerProfileId: "profile",
    adapter: {
      provider,
      async *stream() {
        yield { type: "text_delta", delta: provider };
      },
    },
    modelCatalog: new StaticModelCatalog([
      {
        id: "model",
        isDefault: true,
        contextWindow: 32768,
        defaultReasoningEffort: "medium",
      },
    ]),
  };
}
test("ordinary profile edits preserve frozen resource; delete/re-add permanently revokes its old lease", async () => {
  const original = profile("old-endpoint");
  const registry = new ProviderRegistry([original]);
  const old = registry.acquire({
    providerProfileId: "profile",
    modelId: "model",
  });
  const edit = registry.prepareSnapshot([profile("new-endpoint")], 1);
  registry.publishSnapshot(edit);
  old.assertDispatchAllowed();
  assert.equal(old.adapter.provider, "old-endpoint");
  const next = registry.acquire({
    providerProfileId: "profile",
    modelId: "model",
  });
  assert.equal(next.adapter.provider, "new-endpoint");
  registry.publishSnapshot(
    registry.prepareSnapshot(
      [{ ...profile("other"), providerProfileId: "other" }],
      2,
    ),
  );
  assert.throws(() => old.assertDispatchAllowed(), /revoked/);
  assert.throws(() => next.assertDispatchAllowed(), /revoked/);
  registry.publishSnapshot(
    registry.prepareSnapshot([profile("third-endpoint")], 3),
  );
  assert.throws(() => old.assertDispatchAllowed(), /revoked/);
  const newSession = registry.acquire({
    providerProfileId: "profile",
    modelId: "model",
  });
  newSession.assertDispatchAllowed();
  old.release();
  next.release();
  newSession.release();
  await registry.close();
});
test("released/closed leases reject dispatch without cancelling an already-observed response", async () => {
  const registry = new ProviderRegistry([profile("old")]);
  const lease = registry.acquire({
    providerProfileId: "profile",
    modelId: "model",
  });
  const result = lease.adapter.stream({
    model: "model",
    reasoningEffort: "medium",
    messages: [],
    tools: [],
    signal: new AbortController().signal,
  });
  lease.release();
  assert.throws(() => lease.assertDispatchAllowed(), /revoked/);
  const events = [];
  for await (const e of result) events.push(e);
  assert.equal(events.length, 1);
  await registry.close();
});
