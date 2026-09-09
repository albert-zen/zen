import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ZenXSettingsService } from "../src/main/settings-service.js";
import { ZenXCredentialVault } from "../src/main/credential-vault.js";

async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-runtime-settings-"),
  );
  const service = new ZenXSettingsService({
    userDataDirectory: directory,
    zenDataDirectory: directory,
    vault: new ZenXCredentialVault(path.join(directory, "vault"), {
      isEncryptionAvailable: () => true,
      encryptString: (v) => Buffer.from(v),
      decryptString: (v) => v.toString(),
    }),
  });
  await service.initialize({ ZENX_PROVIDER: "fake" });
  return {
    service,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
test("same draft is unchanged; stale window cannot overwrite a committed configuration", async () => {
  const { service, close } = await fixture();
  try {
    const before = await service.publicSettings();
    await service.save({
      ...before.profile,
      baseRevision: before.profile.revision ?? 0,
    });
    assert.equal(
      (await service.publicSettings()).configuration?.status,
      "unchanged",
    );
    await service.save({
      ...before.profile,
      maxToolRounds: 3,
      baseRevision: before.profile.revision ?? 0,
    });
    await assert.rejects(
      service.save({
        ...before.profile,
        maxToolRounds: 4,
        baseRevision: before.profile.revision ?? 0,
      }),
      /conflict/i,
    );
    assert.equal((await service.publicSettings()).profile.maxToolRounds, 3);
  } finally {
    await close();
  }
});
test("prepare failure does not save; lost publish acknowledgement stays unconfirmed and blocks another save", async () => {
  const { service, close } = await fixture();
  try {
    const before = (await service.publicSettings()).profile;
    let failPrepare = true;
    service.setConfigurationControl({
      prepare: async (_config, revision) => {
        if (failPrepare) throw new Error("prepare failed");
        return {
          processEpoch: "epoch",
          candidateToken: "token",
          revision,
          pendingRestart: [],
        };
      },
      publish: async () => {
        throw new Error("ack lost");
      },
      discard: async () => {},
      current: async () => {
        throw new Error("disconnected");
      },
    });
    await assert.rejects(
      service.save({ ...before, maxToolRounds: 3 }),
      /prepare failed/,
    );
    assert.equal(
      (await service.publicSettings()).profile.maxToolRounds,
      undefined,
    );
    failPrepare = false;
    await service.save({ ...before, maxToolRounds: 3 });
    assert.equal(
      (await service.publicSettings()).configuration?.status,
      "unconfirmed",
    );
    await assert.rejects(
      service.save({ ...before, maxToolRounds: 4 }),
      /unconfirmed/i,
    );
  } finally {
    await close();
  }
});

test("lost ACK reconciles by revision and retry republishes the saved candidate without another write", async () => {
  const { service, close } = await fixture();
  try {
    let revision = 0;
    let publishes = 0;
    let acknowledge = false;
    service.setConfigurationControl({
      prepare: async (_config, next) => ({
        processEpoch: "epoch",
        candidateToken: `token-${next}`,
        revision: next,
        pendingRestart: [],
      }),
      publish: async (candidate) => {
        publishes++;
        if (!acknowledge) throw new Error("lost");
        revision = candidate.revision;
        return { processEpoch: "epoch", revision, pendingRestart: [] };
      },
      discard: async () => {},
      current: async () => ({
        processEpoch: "epoch",
        revision,
        pendingRestart: [],
      }),
    });
    await service.save({
      ...(await service.publicSettings()).profile,
      maxToolRounds: 5,
    });
    const saved = (await service.publicSettings()).profile.revision;
    assert.equal(
      (await service.publicSettings()).configuration?.status,
      "unconfirmed",
    );
    acknowledge = true;
    await service.reconcileConfiguration(true);
    assert.equal(
      (await service.publicSettings()).configuration?.status,
      "applied",
    );
    assert.equal((await service.publicSettings()).profile.revision, saved);
    assert.equal(publishes, 2);
  } finally {
    await close();
  }
});
test("Host-confirmed publication despite a lost ACK is reported applied", async () => {
  const { service, close } = await fixture();
  try {
    let applied = 0;
    service.setConfigurationControl({
      prepare: async (_config, revision) => ({
        processEpoch: "epoch",
        candidateToken: "token",
        revision,
        pendingRestart: [],
      }),
      publish: async (candidate) => {
        applied = candidate.revision;
        throw new Error("lost ACK");
      },
      discard: async () => {},
      current: async () => ({
        processEpoch: "epoch",
        revision: applied,
        pendingRestart: [],
      }),
    });
    await service.save({
      ...(await service.publicSettings()).profile,
      maxToolRounds: 5,
    });
    assert.equal(
      (await service.publicSettings()).configuration?.status,
      "applied",
    );
  } finally {
    await close();
  }
});
test("auxiliary title lease prevents maintenance until released, and maintenance rejects new title work", async () => {
  const { service, close } = await fixture();
  try {
    const title = await service.titleModel();
    assert.equal(service.tryBeginMaintenance(), false);
    title.release();
    title.release();
    assert.equal(service.tryBeginMaintenance(), true);
    await assert.rejects(service.titleModel(), /host_restarting/);
    service.endMaintenance();
    assert.equal(service.activeConfigurationOperations(), 0);
  } finally {
    await close();
  }
});

test("settings publish to the running Host: old null-effort turn completes, next turn requires an explicit new effort", async () => {
  const { createHostedAppServer } = await import("../../cli/src/host.js");
  const { service, close } = await fixture();
  const originalFetch = globalThis.fetch;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === 1) {
      started();
      await firstGate;
    }
    return new Response(
      'data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  let host: ReturnType<typeof createHostedAppServer> | undefined;
  try {
    const profile = (await service.publicSettings()).profile;
    const model = {
      ...profile.providerProfiles[0]!.models[0]!,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
    };
    const provider = {
      type: "openai-compatible" as const,
      providerProfileId: "test",
      name: "test",
      displayName: "Test",
      baseUrl: "https://example.test/v1",
      models: [model],
    };
    await service.addProviderProfile(provider, "test-key");
    await service.save({
      ...(await service.publicSettings()).profile,
      defaultModel: { providerProfileId: "test", modelId: model.id },
      titleModel: { providerProfileId: "test", modelId: model.id },
    });
    host = createHostedAppServer(await service.hostConfig());
    const currentHost = host;
    service.setConfigurationControl({
      prepare: async (config, revision) =>
        currentHost.prepareConfiguration(config, revision),
      publish: async (candidate) => currentHost.publishConfiguration(candidate),
      discard: async (candidate) => currentHost.discardConfiguration(candidate),
      current: async () => currentHost.currentConfiguration(),
    });
    const epoch = host.processEpoch;
    const thread = await host.startThread();
    const running = await host.startTurn(thread.id, "first");
    await firstStarted;
    await service.editProviderProfile(
      "test",
      {
        ...provider,
        models: [
          {
            ...model,
            supportedReasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "medium",
          },
        ],
      },
      { baseRevision: service.configurationRevision() },
    );
    assert.equal(
      (await service.publicSettings()).configuration?.status,
      "applied",
    );
    assert.equal(host.processEpoch, epoch);
    assert.equal(host.tryBeginMaintenance().accepted, false);
    releaseFirst();
    await running.done;
    assert.equal(requests[0]!.reasoning_effort, undefined);
    await assert.rejects(
      host.startTurn(thread.id, "requires choice"),
      /explicit supported reasoning effort/,
    );
    await host.updateThreadSettings(thread.id, {
      selection: {
        providerProfileId: "test",
        modelId: model.id,
        reasoningEffort: "high",
      },
    });
    await (
      await host.startTurn(thread.id, "next")
    ).done;
    assert.equal(requests[1]!.reasoning_effort, "high");
    assert.deepEqual(
      (await host.readThread(thread.id)).turns.map(
        (turn) => turn.selection?.reasoningEffort,
      ),
      [null, "high"],
    );
  } finally {
    releaseFirst();
    await host?.closeHostResources();
    globalThis.fetch = originalFetch;
    await close();
  }
});

test("plugin maintenance includes queued mutations and blocks new mutations at their shared entry", async () => {
  const { ZenXCapabilityService } =
    await import("../src/main/capability-service.js");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zen-plugin-maintenance-"),
  );
  try {
    const service = new ZenXCapabilityService({
      userDataDirectory: directory,
      bundledProvidersOnly: true,
    });
    const pending = service
      .setEnabled("not-installed", false)
      .catch(() => undefined);
    assert.equal(service.tryBeginMaintenance(), false);
    await pending;
    assert.equal(service.tryBeginMaintenance(), true);
    await assert.rejects(
      service.setEnabled("not-installed", false),
      /host_restarting/,
    );
    service.endMaintenance();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
