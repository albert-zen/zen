import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenXCredentialVault } from "../src/main/credential-vault.js";
import {
  structuredLegacyModelCatalog,
  type ZenXHostProfile,
  ZenXHostProfileStore,
} from "../src/main/host-profile.js";
import { discoverOpenAiCompatibleModels } from "../src/main/model-discovery.js";
import { KNOWN_PROVIDER_PRESETS } from "../src/main/provider-presets.js";
import { ZenXSettingsService } from "../src/main/settings-service.js";

test("GET /models discovers ids with unknown capabilities and routes the selected credential", async () => {
  let requestUrl = "";
  let authorization: string | null = null;
  const models = await discoverOpenAiCompatibleModels({
    baseUrl: "https://selected.example.test/v1",
    apiKey: "selected-secret",
    fetch: async (input, init) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json({
        data: [{ id: "shared-model" }, { id: "vision-reasoning-1m" }],
      });
    },
  });

  assert.equal(requestUrl, "https://selected.example.test/v1/models");
  assert.equal(authorization, "Bearer selected-secret");
  assert.deepEqual(models, [
    {
      id: "shared-model",
      displayName: "shared-model",
      description: "",
      hidden: false,
      source: "discovered",
      supportedReasoningEfforts: null,
      defaultReasoningEffort: null,
      inputModalities: null,
      contextWindow: null,
    },
    {
      id: "vision-reasoning-1m",
      displayName: "vision-reasoning-1m",
      description: "",
      hidden: false,
      source: "discovered",
      supportedReasoningEfforts: null,
      defaultReasoningEffort: null,
      inputModalities: null,
      contextWindow: null,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(models), /selected-secret/u);
});

test("GET /models uses explicit rich modalities and exact catalog enrichment without name guessing", async () => {
  const models = await discoverOpenAiCompatibleModels({
    baseUrl: "https://provider.example.test/v1",
    apiKey: "secret",
    fetch: async () =>
      Response.json({
        data: [
          { id: "rich", architecture: { input_modalities: ["text", "image"] } },
          { id: "gpt-5.6-sol" },
          { id: "vision-looking-name" },
        ],
      }),
  });
  assert.deepEqual(models[0]?.inputModalities, ["text", "image"]);
  assert.deepEqual(models[1]?.inputModalities, ["text", "image"]);
  assert.equal(models[1]?.source, "preset");
  assert.equal(models[2]?.inputModalities, null);
});

test("GET /models rejects duplicate, malformed, and failed discovery explicitly", async () => {
  await assert.rejects(
    discoverOpenAiCompatibleModels({
      baseUrl: "https://provider.example.test/v1",
      apiKey: "secret",
      fetch: async () =>
        Response.json({ data: [{ id: "same" }, { id: "same" }] }),
    }),
    /duplicate model id/u,
  );
  await assert.rejects(
    discoverOpenAiCompatibleModels({
      baseUrl: "https://provider.example.test/v1",
      apiKey: "secret",
      fetch: async () => Response.json({ data: [{ object: "model" }] }),
    }),
    /malformed/u,
  );
  await assert.rejects(
    discoverOpenAiCompatibleModels({
      baseUrl: "https://provider.example.test/v1",
      apiKey: "credential-must-not-leak",
      fetch: async () => new Response("no", { status: 503 }),
    }),
    (error: unknown) =>
      error instanceof Error &&
      /503/u.test(error.message) &&
      !error.message.includes("credential-must-not-leak"),
  );
});

test("Host discovery keeps manual overrides and routes the selected profile transport and vault key", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-discovery-"));
  const profileStore = new ZenXHostProfileStore(
    path.join(directory, "host-profile.json"),
  );
  const vault = new ZenXCredentialVault(
    path.join(directory, "credentials.vault"),
    encryption,
  );
  const manual = {
    ...structuredLegacyModelCatalog("openai-compatible", ["shared-model"])[0]!,
    source: "manual" as const,
    supportedReasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high",
    inputModalities: ["text" as const, "image" as const],
    contextWindow: 64_000,
  };
  const profile = compatibleProfile(manual);
  let routedTransport: unknown;
  let requestAuthorization: string | null = null;
  let closed = false;
  try {
    await profileStore.write(profile);
    await vault.writeApiKey("selected", "selected-key");
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      profileStore,
      vault,
      subscription: inactiveSubscription,
      providerFetchFactory: (transport) => {
        routedTransport = transport;
        return Object.assign(
          async (_input: URL | RequestInfo, init?: RequestInit) => {
            requestAuthorization = new Headers(init?.headers).get(
              "authorization",
            );
            return Response.json({
              data: [{ id: "shared-model" }, { id: "discovered-only" }],
            });
          },
          { close: async () => void (closed = true) },
        );
      },
    });
    await service.initialize({});
    const before = (await service.publicSettings()).profile;
    const snapshot = await service.discoverProviderModels("selected", {
      transport: { proxyUrl: "http://proxy.example.test:8080" },
    });
    assert.deepEqual(routedTransport, {
      proxyUrl: "http://proxy.example.test:8080",
    });
    assert.equal(requestAuthorization, "Bearer selected-key");
    assert.equal(closed, true);
    assert.deepEqual(snapshot.models[0], manual);
    assert.equal(snapshot.models[1]?.id, "discovered-only");
    assert.equal(snapshot.models[1]?.supportedReasoningEfforts, null);
    assert.deepEqual((await service.publicSettings()).profile, before);
    assert.doesNotMatch(JSON.stringify(snapshot), /selected-key/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Host discovery failure is explicit and leaves configured catalog entries intact", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-discovery-failure-"),
  );
  const profileStore = new ZenXHostProfileStore(
    path.join(directory, "host-profile.json"),
  );
  const vault = new ZenXCredentialVault(
    path.join(directory, "credentials.vault"),
    encryption,
  );
  const profile = compatibleProfile(
    structuredLegacyModelCatalog("openai-compatible", ["configured"])[0]!,
  );
  try {
    await profileStore.write(profile);
    await vault.writeApiKey("selected", "selected-key");
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      profileStore,
      vault,
      subscription: inactiveSubscription,
      providerFetchFactory: () =>
        Object.assign(async () => new Response(null, { status: 502 }), {
          close: async () => undefined,
        }),
    });
    await service.initialize({});
    const before = (await service.publicSettings()).profile;
    await assert.rejects(
      service.discoverProviderModels("selected"),
      /HTTP 502/u,
    );
    assert.deepEqual((await service.publicSettings()).profile, before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a conclusive explicit image probe persists through the existing Host catalog boundary", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-probe-persist-"),
  );
  const profileStore = new ZenXHostProfileStore(
    path.join(directory, "host-profile.json"),
  );
  const vault = new ZenXCredentialVault(
    path.join(directory, "credentials.vault"),
    encryption,
  );
  const runnable = structuredLegacyModelCatalog("openai-compatible", [
    "runnable",
  ])[0]!;
  const unknown = {
    ...runnable,
    id: "unknown-image",
    displayName: "unknown-image",
    inputModalities: null,
    source: "manual" as const,
  };
  const profile = compatibleProfile(runnable);
  profile.providerProfiles[0]!.models.push(unknown);
  try {
    await profileStore.write(profile);
    await vault.writeApiKey("selected", "selected-key");
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      profileStore,
      vault,
      subscription: inactiveSubscription,
      providerFetchFactory: () =>
        Object.assign(
          async () =>
            new Response(
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { status: 200, headers: { "content-type": "text/event-stream" } },
            ),
          { close: async () => undefined },
        ),
    });
    await service.initialize({});
    const result = await service.probeProviderModelImage(
      "selected",
      "unknown-image",
    );
    assert.equal(result.outcome, "supported");
    assert.deepEqual(result.model.inputModalities, ["text", "image"]);
    assert.equal(result.model.source, "probe");
    const persisted = await profileStore.readOptional();
    assert.deepEqual(
      persisted?.providerProfiles[0]?.models[1]?.inputModalities,
      ["text", "image"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("all known Provider presets create with profile-scoped keys and discover Unknown model ids", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-presets-"));
  const profileStore = new ZenXHostProfileStore(
    path.join(directory, "host-profile.json"),
  );
  const vault = new ZenXCredentialVault(
    path.join(directory, "credentials.vault"),
    encryption,
  );
  const seed = structuredLegacyModelCatalog("fake", ["fake"])[0]!;
  const requests: Array<{ url: string; authorization: string | null }> = [];
  try {
    await profileStore.write({
      version: 3,
      onboardingComplete: true,
      providerProfiles: [
        {
          providerProfileId: "fake",
          type: "fake",
          displayName: "Local demo",
          models: [seed],
        },
      ],
      defaultModel: { providerProfileId: "fake", modelId: "fake" },
      titleModel: { providerProfileId: "fake", modelId: "fake" },
      workspace: null,
      workspaces: [],
      lastUsedWorkspace: null,
      approvalPolicy: "never",
      pinnedThreadIds: [],
      sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
    });
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      profileStore,
      vault,
      subscription: inactiveSubscription,
      providerFetchFactory: () =>
        Object.assign(
          async (input: URL | RequestInfo, init?: RequestInit) => {
            const url = String(input);
            requests.push({
              url,
              authorization: new Headers(init?.headers).get("authorization"),
            });
            return Response.json({ data: [{ id: "discovered-model" }] });
          },
          { close: async () => undefined },
        ),
    });
    await service.initialize({});
    for (const preset of KNOWN_PROVIDER_PRESETS) {
      await service.addProviderProfile(
        {
          ...preset,
          type: "openai-compatible",
          models: structuredLegacyModelCatalog("openai-compatible", [
            "manual-seed",
          ]),
        },
        `${preset.providerProfileId}-key`,
      );
      const snapshot = await service.discoverProviderModels(
        preset.providerProfileId,
      );
      assert.deepEqual(
        snapshot.models.map((model) => model.id),
        ["manual-seed", "discovered-model"],
      );
      assert.equal(snapshot.models[1]?.supportedReasoningEfforts, null);
      assert.equal(snapshot.models[1]?.defaultReasoningEffort, null);
      assert.equal(snapshot.models[1]?.inputModalities, null);
      assert.equal(snapshot.models[1]?.contextWindow, null);
    }
    assert.deepEqual(
      requests,
      KNOWN_PROVIDER_PRESETS.map((preset) => ({
        url: `${preset.baseUrl}/models`,
        authorization: `Bearer ${preset.providerProfileId}-key`,
      })),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`secure:${value}`),
  decryptString: (value: Buffer) => value.toString().replace(/^secure:/u, ""),
};

const inactiveSubscription = {
  login: async () => undefined,
  logout: async () => undefined,
  status: async () => ({ authenticated: false, expired: false }),
};

function compatibleProfile(
  model: ZenXHostProfile["providerProfiles"][number]["models"][number],
): ZenXHostProfile {
  return {
    version: 3,
    onboardingComplete: true,
    providerProfiles: [
      {
        providerProfileId: "selected",
        type: "openai-compatible",
        name: "selected-runtime",
        displayName: "Selected",
        baseUrl: "https://selected.example.test/v1",
        models: [model],
      },
    ],
    defaultModel: { providerProfileId: "selected", modelId: model.id },
    titleModel: { providerProfileId: "selected", modelId: model.id },
    workspace: null,
    workspaces: [],
    lastUsedWorkspace: null,
    approvalPolicy: "never",
    pinnedThreadIds: [],
    sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
  };
}
