import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZenXCredentialVault } from "../src/main/credential-vault.js";
import {
  structuredLegacyModelCatalog,
  type ZenXHostProfile,
  ZenXHostProfileStore,
} from "../src/main/host-profile.js";
import {
  discoverOpenAiCompatibleModels,
  discoverOpenAiSubscriptionModels,
  OpenAiSubscriptionModelCache,
} from "../src/main/model-discovery.js";
import { KNOWN_PROVIDER_PRESETS } from "../src/main/provider-presets.js";
import { ZenXSettingsService } from "../src/main/settings-service.js";

test("ChatGPT subscription discovery maps the official Codex catalog and filters unsupported entries", async () => {
  const accessToken = subscriptionToken("acct-models");
  let requestUrl = "";
  let requestHeaders = new Headers();
  const result = await discoverOpenAiSubscriptionModels({
    accessToken,
    clientVersion: "1.2.3",
    etag: '"previous"',
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return Response.json(
        {
          models: [
            {
              slug: "official-fast",
              display_name: "Official Fast",
              description: "Current account model",
              default_reasoning_level: "medium",
              supported_reasoning_levels: [
                { effort: "low", description: "Fast" },
                { effort: "medium", description: "Balanced" },
              ],
              visibility: "list",
              priority: 2,
              input_modalities: ["text", "image"],
              context_window: 300_000,
            },
            {
              slug: "audio-only",
              display_name: "Audio only",
              supported_reasoning_levels: [],
              visibility: "list",
              priority: 1,
              input_modalities: ["audio"],
            },
            {
              slug: "internal",
              display_name: "Internal",
              supported_reasoning_levels: [],
              visibility: "hide",
              priority: 0,
              input_modalities: ["text"],
            },
          ],
        },
        { headers: { etag: '"latest"' } },
      );
    },
  });

  assert.equal(
    requestUrl,
    "https://chatgpt.com/backend-api/codex/models?client_version=1.2.3",
  );
  assert.equal(requestHeaders.get("authorization"), `Bearer ${accessToken}`);
  assert.equal(requestHeaders.get("chatgpt-account-id"), "acct-models");
  assert.equal(requestHeaders.get("if-none-match"), '"previous"');
  assert.equal(result.etag, '"latest"');
  assert.deepEqual(result.models, [
    {
      id: "official-fast",
      displayName: "Official Fast",
      description: "Current account model",
      hidden: false,
      source: "discovered",
      supportedReasoningEfforts: ["low", "medium"],
      defaultReasoningEffort: "medium",
      inputModalities: ["text", "image"],
      contextWindow: 300_000,
    },
  ]);
});

test("subscription discovery uses an account-scoped cache and then built-in fallback", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-sub-models-"));
  const profileStore = new ZenXHostProfileStore(
    path.join(directory, "host-profile.json"),
  );
  const vault = new ZenXCredentialVault(
    path.join(directory, "credentials.vault"),
    encryption,
  );
  const accessToken = subscriptionToken("acct-cache");
  let online = true;
  try {
    await profileStore.write(subscriptionProfile());
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      profileStore,
      vault,
      subscription: {
        ...inactiveSubscription,
        status: async () => ({
          authenticated: true,
          expired: false,
          accountId: "acct-cache",
        }),
        acquireAccessLease: async () => ({ accessToken }),
      },
      providerFetchFactory: () =>
        Object.assign(
          async () => {
            if (!online) throw new Error("offline");
            return Response.json(
              {
                models: [
                  {
                    slug: "official-new",
                    display_name: "Official New",
                    description: null,
                    default_reasoning_level: "high",
                    supported_reasoning_levels: [
                      { effort: "medium", description: "" },
                      { effort: "high", description: "" },
                    ],
                    visibility: "list",
                    priority: 0,
                    input_modalities: ["text", "image"],
                    context_window: 400_000,
                  },
                ],
              },
              { headers: { etag: '"catalog-1"' } },
            );
          },
          { close: async () => undefined },
        ),
    });
    await service.initialize({});
    const remote = await service.discoverProviderModels("openai-codex");
    assert.equal(remote.source, "remote");
    assert.equal(
      remote.models.some((model) => model.id === "official-new"),
      true,
    );

    online = false;
    const cached = await service.discoverProviderModels("openai-codex");
    assert.equal(cached.source, "cache");
    assert.match(cached.warning ?? "", /request failed/u);
    assert.equal(
      cached.models.some((model) => model.id === "official-new"),
      true,
    );

    const fallbackService = new ZenXSettingsService({
      userDataDirectory: path.join(directory, "fresh"),
      zenDataDirectory: path.join(directory, "fresh", "zen"),
      profileStore,
      vault,
      subscription: inactiveSubscription,
      subscriptionModelCache: new OpenAiSubscriptionModelCache(
        path.join(directory, "missing-cache.json"),
      ),
    });
    await fallbackService.initialize({});
    const fallback =
      await fallbackService.discoverProviderModels("openai-codex");
    assert.equal(fallback.source, "fallback");
    assert.equal(
      fallback.models.some((model) => model.id === "gpt-5.6-terra"),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GET /models discovers ids as text-only and routes the selected credential", async () => {
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
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      inputModalities: ["text"],
      contextWindow: null,
    },
    {
      id: "vision-reasoning-1m",
      displayName: "vision-reasoning-1m",
      description: "",
      hidden: false,
      source: "discovered",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      inputModalities: ["text"],
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
          { id: "gpt-5.6-sol", input_modalities: ["audio"] },
          { id: "malformed-modalities", input_modalities: [42] },
          { id: "gpt-5.6-terra" },
          { id: "vision-looking-name" },
        ],
      }),
  });
  assert.deepEqual(models[0]?.inputModalities, ["text", "image"]);
  assert.deepEqual(models[1]?.inputModalities, ["audio"]);
  assert.equal(Object.isFrozen(models[1]?.inputModalities), true);
  assert.equal(models[1]?.source, "preset");
  assert.deepEqual(models[2]?.inputModalities, ["text"]);
  assert.deepEqual(models[3]?.inputModalities, ["text", "image"]);
  assert.equal(models[3]?.source, "preset");
  assert.deepEqual(models[4]?.inputModalities, ["text"]);
});

test("discovery derives transport from one exact profile and credential snapshot", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-discovery-fence-"),
  );
  const profileStore = new ZenXHostProfileStore(
    path.join(directory, "host-profile.json"),
  );
  const vault = new ZenXCredentialVault(
    path.join(directory, "credentials.vault"),
    encryption,
  );
  const model = structuredLegacyModelCatalog("openai-compatible", [
    "shared",
  ])[0]!;
  const profile = compatibleProfile(model);
  const selectedProvider = profile.providerProfiles[0]!;
  assert.equal(selectedProvider.type, "openai-compatible");
  if (selectedProvider.type !== "openai-compatible") {
    throw new Error("Expected an OpenAI-compatible test Provider");
  }
  const transportStarted =
    deferred<ZenXHostProfile["providerProfiles"][number]>();
  const releaseTransport = deferred<void>();
  let fetchCalls = 0;
  try {
    await profileStore.write(profile);
    await vault.writeApiKey("selected", "credential-a");
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      profileStore,
      vault,
      subscription: inactiveSubscription,
      providerFetchFactory: () =>
        Object.assign(
          async () => {
            fetchCalls += 1;
            return Response.json({ data: [{ id: "shared" }] });
          },
          { close: async () => undefined },
        ),
    });
    await service.initialize({});
    const discovery = service.discoverProviderModels("selected", {
      resolveTransport: async (captured) => {
        transportStarted.resolve(captured);
        await releaseTransport.promise;
        return { proxyUrl: "http://proxy-a.example.test:8080" };
      },
    });
    const captured = await transportStarted.promise;
    assert.equal(captured.type, "openai-compatible");
    assert.equal(captured.baseUrl, "https://selected.example.test/v1");
    assert.equal(Object.isFrozen(captured), true);
    assert.equal(Object.isFrozen(captured.models), true);
    assert.equal(Object.isFrozen(captured.models[0]), true);
    await service.editProviderProfile(
      "selected",
      {
        ...selectedProvider,
        baseUrl: "https://changed.example.test/v1",
      },
      {},
    );
    releaseTransport.resolve();
    await assert.rejects(
      discovery,
      /changed during model discovery; try again/u,
    );
    assert.equal(fetchCalls, 0);

    await service.editProviderProfile("selected", selectedProvider, {});
    const credentialTransportStarted = deferred<void>();
    const releaseCredentialTransport = deferred<void>();
    const credentialDiscovery = service.discoverProviderModels("selected", {
      resolveTransport: async () => {
        credentialTransportStarted.resolve();
        await releaseCredentialTransport.promise;
        return { proxyUrl: "http://proxy-a.example.test:8080" };
      },
    });
    await credentialTransportStarted.promise;
    await service.editProviderProfile("selected", selectedProvider, {
      apiKey: "credential-b",
    });
    releaseCredentialTransport.resolve();
    await assert.rejects(
      credentialDiscovery,
      /changed during model discovery; try again/u,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a conclusive image probe cannot overwrite changed model metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-probe-fence-"));
  const profileStore = new ZenXHostProfileStore(
    path.join(directory, "host-profile.json"),
  );
  const vault = new ZenXCredentialVault(
    path.join(directory, "credentials.vault"),
    encryption,
  );
  const model = {
    ...structuredLegacyModelCatalog("openai-compatible", ["shared"])[0]!,
    inputModalities: ["text"] as const,
    source: "manual" as const,
  };
  const profile = compatibleProfile(model);
  const selectedProvider = profile.providerProfiles[0]!;
  assert.equal(selectedProvider.type, "openai-compatible");
  if (selectedProvider.type !== "openai-compatible") {
    throw new Error("Expected an OpenAI-compatible test Provider");
  }
  const requestStarted = deferred<void>();
  const response = deferred<Response>();
  try {
    await profileStore.write(profile);
    await vault.writeApiKey("selected", "credential-a");
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      profileStore,
      vault,
      subscription: inactiveSubscription,
      providerFetchFactory: () =>
        Object.assign(
          async () => {
            requestStarted.resolve();
            return await response.promise;
          },
          { close: async () => undefined },
        ),
    });
    await service.initialize({});
    const probe = service.probeProviderModelImage("selected", "shared", {
      resolveTransport: async () => undefined,
    });
    await requestStarted.promise;
    const changedModel = {
      ...selectedProvider.models[0]!,
      description: "new metadata",
    };
    await service.editProviderProfile(
      "selected",
      { ...selectedProvider, models: [changedModel] },
      {},
    );
    response.resolve(
      new Response(
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    await assert.rejects(
      probe,
      /changed during image capability probe; try again/u,
    );
    const current = (await service.publicSettings()).profile
      .providerProfiles[0]!;
    assert.equal(current.models[0]?.description, "new metadata");
    assert.equal(current.models[0]?.source, "manual");
    assert.deepEqual(current.models[0]?.inputModalities, ["text"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
      resolveTransport: async () => ({
        proxyUrl: "http://proxy.example.test:8080",
      }),
    });
    assert.deepEqual(routedTransport, {
      proxyUrl: "http://proxy.example.test:8080",
    });
    assert.equal(requestAuthorization, "Bearer selected-key");
    assert.equal(closed, true);
    assert.deepEqual(snapshot.models[0], manual);
    assert.equal(snapshot.models[1]?.id, "discovered-only");
    assert.deepEqual(snapshot.models[1]?.supportedReasoningEfforts, []);
    assert.deepEqual(snapshot.models[1]?.inputModalities, ["text"]);
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
          ]).map((model) => ({ ...model, contextWindow: 32_768 })),
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
      assert.deepEqual(snapshot.models[1]?.supportedReasoningEfforts, []);
      assert.equal(snapshot.models[1]?.defaultReasoningEffort, null);
      assert.deepEqual(snapshot.models[1]?.inputModalities, ["text"]);
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

function subscriptionToken(accountId: string): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.signature`;
}

test("an unconfigured subscription catalog auto-configures the recent remote models exactly once", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-sub-auto-"));
  const profileStore = new ZenXHostProfileStore(
    path.join(directory, "host-profile.json"),
  );
  const vault = new ZenXCredentialVault(
    path.join(directory, "credentials.vault"),
    encryption,
  );
  const accessToken = subscriptionToken("acct-auto");
  let requests = 0;
  const catalogFetch = () =>
    Object.assign(
      async () => {
        requests += 1;
        return Response.json({
          models: [
            {
              slug: "gpt-6.1-max",
              display_name: "GPT 6.1 Max",
              default_reasoning_level: "high",
              supported_reasoning_levels: [
                { effort: "medium", description: "" },
                { effort: "high", description: "" },
              ],
              visibility: "list",
              priority: 0,
              input_modalities: ["text", "image"],
              context_window: 400_000,
            },
            {
              slug: "gpt-6.1",
              default_reasoning_level: "medium",
              supported_reasoning_levels: [
                { effort: "medium", description: "" },
              ],
              visibility: "list",
              priority: 1,
              context_window: 400_000,
            },
            {
              slug: "gpt-6.0",
              default_reasoning_level: "medium",
              supported_reasoning_levels: [
                { effort: "medium", description: "" },
              ],
              visibility: "list",
              priority: 2,
              context_window: 300_000,
            },
            {
              slug: "gpt-5.9",
              default_reasoning_level: "medium",
              supported_reasoning_levels: [
                { effort: "medium", description: "" },
              ],
              visibility: "list",
              priority: 3,
              context_window: 272_000,
            },
            {
              slug: "internal-6",
              default_reasoning_level: "medium",
              supported_reasoning_levels: [],
              visibility: "hide",
              priority: 4,
            },
            {
              slug: "gpt-5.8-mini",
              default_reasoning_level: "medium",
              supported_reasoning_levels: [
                { effort: "medium", description: "" },
              ],
              visibility: "list",
              priority: 5,
            },
            {
              slug: "gpt-5.7",
              default_reasoning_level: "medium",
              supported_reasoning_levels: [
                { effort: "medium", description: "" },
              ],
              visibility: "list",
              priority: 6,
              context_window: 200_000,
            },
          ],
        });
      },
      { close: async () => undefined },
    );
  try {
    await profileStore.write(subscriptionProfile());
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      profileStore,
      vault,
      subscription: {
        ...inactiveSubscription,
        status: async () => ({
          authenticated: true,
          expired: false,
          accountId: "acct-auto",
        }),
        acquireAccessLease: async () => ({ accessToken }),
      },
      providerFetchFactory: catalogFetch,
    });
    await service.initialize({});
    // Before seeding, loading applied the build-time presets.
    assert.deepEqual(
      (await service.publicSettings()).profile.providerProfiles[0]!.models.map(
        (model) => model.id,
      ),
      ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
    );

    assert.equal(await service.autoConfigureSubscriptionModels(), true);

    const profile = (await service.publicSettings()).profile;
    const provider = profile.providerProfiles[0]!;
    // The hidden entry never appears; the window-less gpt-5.8-mini is
    // excluded because Host requires a positive context for configured
    // models; only the five most recent usable models are kept.
    assert.deepEqual(
      provider.models.map((model) => model.id),
      ["gpt-6.1-max", "gpt-6.1", "gpt-6.0", "gpt-5.9", "gpt-5.7"],
    );
    assert.equal(provider.modelsUserConfigured, true);
    assert.deepEqual(provider.models[0]?.supportedReasoningEfforts, [
      "medium",
      "high",
    ]);
    assert.equal(provider.models[0]?.contextWindow, 400_000);
    // Old default/title references were repaired to the new catalog.
    assert.equal(
      provider.models.some(
        (model) => model.id === profile.defaultModel.modelId,
      ),
      true,
    );
    assert.equal(
      provider.models.some((model) => model.id === profile.titleModel.modelId),
      true,
    );

    // A second attempt is a no-op: the catalog now belongs to the user.
    const requestsAfterSeed = requests;
    assert.equal(await service.autoConfigureSubscriptionModels(), false);
    assert.equal(requests, requestsAfterSeed);

    // Reloading the persisted profile never re-injects the old presets.
    const reloaded = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      profileStore,
      vault,
      subscription: inactiveSubscription,
      providerFetchFactory: catalogFetch,
    });
    await reloaded.initialize({});
    assert.deepEqual(
      (await reloaded.publicSettings()).profile.providerProfiles[0]!.models.map(
        (model) => model.id,
      ),
      ["gpt-6.1-max", "gpt-6.1", "gpt-6.0", "gpt-5.9", "gpt-5.7"],
    );
    assert.equal(requests, requestsAfterSeed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("auto-configuration keeps the built-in presets when the subscription is unavailable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-sub-auto-off-"));
  const profileStore = new ZenXHostProfileStore(
    path.join(directory, "host-profile.json"),
  );
  try {
    await profileStore.write(subscriptionProfile());
    let requests = 0;
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      profileStore,
      vault: new ZenXCredentialVault(
        path.join(directory, "credentials.vault"),
        encryption,
      ),
      subscription: inactiveSubscription,
      providerFetchFactory: () =>
        Object.assign(
          async () => {
            requests += 1;
            throw new Error("offline");
          },
          { close: async () => undefined },
        ),
    });
    await service.initialize({});
    assert.equal(await service.autoConfigureSubscriptionModels(), false);
    assert.equal(requests, 0);
    assert.equal(
      (await service.publicSettings()).profile.providerProfiles[0]!.models.some(
        (model) => model.id === "gpt-5.6-terra",
      ),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removing subscription models marks the catalog user-owned and survives reload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-sub-own-"));
  const profileStore = new ZenXHostProfileStore(
    path.join(directory, "host-profile.json"),
  );
  const vault = new ZenXCredentialVault(
    path.join(directory, "credentials.vault"),
    encryption,
  );
  try {
    await profileStore.write(subscriptionProfile());
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      profileStore,
      vault,
      subscription: inactiveSubscription,
    });
    await service.initialize({});
    const before = (await service.publicSettings()).profile;
    const provider = before.providerProfiles[0]!;
    // A pure metadata save (same model IDs) keeps the catalog Host-owned.
    const renamed = provider.models.map((model, index) =>
      index === 0 ? { ...model, displayName: "Renamed" } : model,
    );
    await service.editProviderProfile(
      provider.providerProfileId,
      { ...provider, models: renamed },
      { baseRevision: before.revision },
    );
    const afterRename = (await service.publicSettings()).profile;
    assert.equal(
      afterRename.providerProfiles[0]!.modelsUserConfigured,
      undefined,
    );
    // Deleting a model ID takes ownership of the catalog.
    const trimmed = afterRename.providerProfiles[0]!.models.filter(
      (model) => model.id !== "gpt-5.4",
    );
    await service.editProviderProfile(
      provider.providerProfileId,
      { ...afterRename.providerProfiles[0]!, models: trimmed },
      { baseRevision: afterRename.revision },
    );
    const edited = (await service.publicSettings()).profile;
    assert.equal(edited.providerProfiles[0]!.modelsUserConfigured, true);
    assert.equal(
      edited.providerProfiles[0]!.models.some(
        (model) => model.id === "gpt-5.4",
      ),
      false,
    );
    // A reloaded profile keeps the deletion; repackaging cannot resurrect
    // built-in models for a user-owned catalog.
    const reloaded = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      profileStore,
      vault,
      subscription: inactiveSubscription,
    });
    await reloaded.initialize({});
    const kept = (await reloaded.publicSettings()).profile.providerProfiles[0]!;
    assert.equal(kept.modelsUserConfigured, true);
    assert.equal(
      kept.models.some((model) => model.id === "gpt-5.4"),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("auto-configuration carries the user's hidden and manual catalog choices", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-sub-carry-"));
  const profileStore = new ZenXHostProfileStore(
    path.join(directory, "host-profile.json"),
  );
  const accessToken = subscriptionToken("acct-carry");
  try {
    const base = subscriptionProfile();
    const provider = base.providerProfiles[0]!;
    await profileStore.write({
      ...base,
      providerProfiles: [
        {
          ...provider,
          models: provider.models.map((model) =>
            model.id === "gpt-5.6-luna"
              ? { ...model, hidden: true }
              : model.id === "gpt-5.6-terra"
                ? { ...model, source: "manual" as const, displayName: "Mine" }
                : model,
          ),
        },
      ],
    });
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      profileStore,
      vault: new ZenXCredentialVault(
        path.join(directory, "credentials.vault"),
        encryption,
      ),
      subscription: {
        ...inactiveSubscription,
        status: async () => ({
          authenticated: true,
          expired: false,
          accountId: "acct-carry",
        }),
        acquireAccessLease: async () => ({ accessToken }),
      },
      providerFetchFactory: () =>
        Object.assign(
          async () =>
            Response.json({
              models: [
                {
                  slug: "gpt-5.6-terra",
                  display_name: "Remote Terra",
                  default_reasoning_level: "medium",
                  supported_reasoning_levels: [
                    { effort: "medium", description: "" },
                  ],
                  visibility: "list",
                  priority: 0,
                  context_window: 300_000,
                },
                {
                  slug: "gpt-5.6-luna",
                  display_name: "Remote Luna",
                  default_reasoning_level: "medium",
                  supported_reasoning_levels: [
                    { effort: "medium", description: "" },
                  ],
                  visibility: "list",
                  priority: 1,
                  context_window: 200_000,
                },
              ],
            }),
          { close: async () => undefined },
        ),
    });
    await service.initialize({});
    assert.equal(await service.autoConfigureSubscriptionModels(), true);
    const providerAfter = (await service.publicSettings()).profile
      .providerProfiles[0]!;
    // Manual metadata wins over the remote description for the same id.
    assert.equal(providerAfter.models[0]?.displayName, "Mine");
    // The hidden choice carries across the seed.
    assert.equal(providerAfter.models[1]?.hidden, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function subscriptionProfile(): ZenXHostProfile {
  const models = structuredLegacyModelCatalog("openai-subscription", [
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
  return {
    version: 3,
    onboardingComplete: true,
    providerProfiles: [
      {
        providerProfileId: "openai-codex",
        type: "openai-subscription",
        displayName: "OpenAI subscription",
        models,
      },
    ],
    defaultModel: {
      providerProfileId: "openai-codex",
      modelId: "gpt-5.6-terra",
    },
    titleModel: {
      providerProfileId: "openai-codex",
      modelId: "gpt-5.6-luna",
    },
    workspace: null,
    workspaces: [],
    lastUsedWorkspace: null,
    approvalPolicy: "never",
    pinnedThreadIds: [],
    sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
  };
}

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
        models: [
          {
            ...model,
            contextWindow: model.contextWindow ?? 32_768,
          },
        ],
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("subscription discovery rejects old account results after account switch or logout", async () => {
  for (const responseKind of ["remote", "cache", "offline"] as const) {
    for (const nextAccount of ["account-b", undefined]) {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "zenx-catalog-account-"),
      );
      try {
        const profileStore = new ZenXHostProfileStore(
          path.join(directory, "profile.json"),
        );
        await profileStore.write(subscriptionProfile());
        let account: string | undefined = "account-a";
        const entered = deferred<void>();
        const reply = deferred<Response>();
        const cache = new OpenAiSubscriptionModelCache(
          path.join(directory, "models-cache.json"),
        );
        await cache.store({
          accountId: "account-a",
          fetchedAt: Date.now(),
          etag: '"a"',
          models: [],
        });
        const service = new ZenXSettingsService({
          userDataDirectory: directory,
          zenDataDirectory: path.join(directory, "zen"),
          profileStore,
          vault: new ZenXCredentialVault(
            path.join(directory, "vault"),
            encryption,
          ),
          subscriptionModelCache: cache,
          subscription: {
            ...inactiveSubscription,
            status: async () => ({
              authenticated: account !== undefined,
              expired: false,
              accountId: account,
            }),
            acquireAccessLease: async () => ({
              accessToken: subscriptionToken("account-a"),
            }),
          },
          providerFetchFactory: () =>
            Object.assign(
              async () => {
                entered.resolve();
                return await reply.promise;
              },
              { close: async () => undefined },
            ),
        });
        await service.initialize({});
        const result = service.discoverProviderModels("openai-codex");
        await entered.promise;
        account = nextAccount;
        if (responseKind === "offline") reply.reject(new Error("offline"));
        else
          reply.resolve(
            responseKind === "cache"
              ? new Response(null, { status: 304 })
              : Response.json({ models: [] }),
          );
        await assert.rejects(result, /account.*changed/i);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

test("subscription discovery renews rejected tokens and honors same-account ETag cache", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-catalog-renew-"),
  );
  try {
    const profileStore = new ZenXHostProfileStore(
      path.join(directory, "profile.json"),
    );
    await profileStore.write(subscriptionProfile());
    const cache = new OpenAiSubscriptionModelCache(
      path.join(directory, "catalog.json"),
    );
    await cache.store({
      accountId: "account-a",
      fetchedAt: Date.now(),
      etag: '"cached-a"',
      models: [],
    });
    const first = subscriptionToken("account-a");
    const renewed = first.replace(".signature", ".renewed");
    let calls = 0;
    let renewals = 0;
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      profileStore,
      vault: new ZenXCredentialVault(path.join(directory, "vault"), encryption),
      subscriptionModelCache: cache,
      subscription: {
        ...inactiveSubscription,
        status: async () => ({
          authenticated: true,
          expired: false,
          accountId: "account-a",
        }),
        acquireAccessLease: async () => ({ accessToken: first }),
        renewAccessLease: async (rejected) => {
          assert.equal(rejected, first);
          renewals++;
          return { accessToken: renewed };
        },
      },
      providerFetchFactory: () =>
        Object.assign(
          async (_input: string | URL | Request, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            assert.equal(headers.get("if-none-match"), '"cached-a"');
            assert.equal(
              headers.get("authorization"),
              `Bearer ${calls === 0 ? first : renewed}`,
            );
            calls++;
            return new Response(null, { status: calls === 1 ? 401 : 304 });
          },
          { close: async () => undefined },
        ),
    });
    await service.initialize({});
    const snapshot = await service.discoverProviderModels("openai-codex");
    assert.equal(snapshot.source, "cache");
    assert.equal(snapshot.warning, undefined);
    assert.equal(calls, 2);
    assert.equal(renewals, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("subscription discovery defaults to its own current catalog compatibility version", async () => {
  let requested = "";
  await discoverOpenAiSubscriptionModels({
    accessToken: subscriptionToken("catalog-version"),
    fetch: async (url) => {
      requested = String(url);
      return Response.json({ models: [] });
    },
  });
  assert.equal(
    new URL(requested).searchParams.get("client_version"),
    "0.153.4",
  );
});

test("subscription cache rejects ETags from another catalog compatibility version", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-catalog-version-"),
  );
  try {
    const file = path.join(directory, "cache.json");
    const cache = new OpenAiSubscriptionModelCache(file);
    const entry = {
      accountId: "account",
      fetchedAt: Date.now(),
      etag: '"catalog"',
      models: [],
    };
    await cache.store(entry);
    assert.deepEqual(await cache.load("account"), entry);
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.equal(stored.catalogClientVersion, "0.153.4");
    await writeFile(
      file,
      JSON.stringify({ ...stored, catalogClientVersion: "0.146.0" }),
    );
    assert.equal(await cache.load("account"), undefined);
    delete stored.catalogClientVersion;
    await writeFile(file, JSON.stringify(stored));
    assert.equal(await cache.load("account"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const changedDuring of ["fetch", "close"] as const) {
  test(`auto seed refuses an old account catalog after switching during ${changedDuring}`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-auto-account-"),
    );
    try {
      const profileStore = new ZenXHostProfileStore(
        path.join(directory, "profile.json"),
      );
      await profileStore.write(subscriptionProfile());
      let account = "account-a";
      const entered = deferred<void>();
      const release = deferred<void>();
      const response = () =>
        Response.json({
          models: [
            {
              slug: "account-a-exclusive",
              visibility: "list",
              priority: 0,
              context_window: 300_000,
              supported_reasoning_levels: [],
            },
          ],
        });
      const service = new ZenXSettingsService({
        userDataDirectory: directory,
        zenDataDirectory: path.join(directory, "zen"),
        profileStore,
        vault: new ZenXCredentialVault(
          path.join(directory, "vault"),
          encryption,
        ),
        subscription: {
          ...inactiveSubscription,
          status: async () => ({
            authenticated: true,
            expired: false,
            accountId: account,
          }),
          acquireAccessLease: async () => ({
            accessToken: subscriptionToken("account-a"),
          }),
        },
        providerFetchFactory: () =>
          Object.assign(
            async () => {
              if (changedDuring === "fetch") {
                entered.resolve();
                await release.promise;
              }
              return response();
            },
            {
              close: async () => {
                if (changedDuring === "close") {
                  entered.resolve();
                  await release.promise;
                }
              },
            },
          ),
      });
      await service.initialize({});
      const result = service.autoConfigureSubscriptionModels();
      await entered.promise;
      account = "account-b";
      release.resolve();
      assert.equal(
        await result,
        false,
        "must not permanently seed account-a models for account-b",
      );
      const profile = (await service.publicSettings()).profile;
      assert.notEqual(profile.providerProfiles[0]?.modelsUserConfigured, true);
      assert.equal(
        profile.providerProfiles[0]?.models.some(
          (model) => model.id === "account-a-exclusive",
        ),
        false,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("auto seed repairs title model when default belongs to another Provider", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-auto-title-"));
  try {
    const profileStore = new ZenXHostProfileStore(
      path.join(directory, "profile.json"),
    );
    const profile = subscriptionProfile();
    profile.providerProfiles.push({
      providerProfileId: "fake",
      displayName: "Fake",
      type: "fake",
      models: structuredLegacyModelCatalog("fake", ["fake"]),
    });
    profile.defaultModel = { providerProfileId: "fake", modelId: "fake" };
    await profileStore.write(profile);
    const service = new ZenXSettingsService({
      userDataDirectory: directory,
      zenDataDirectory: path.join(directory, "zen"),
      profileStore,
      vault: new ZenXCredentialVault(path.join(directory, "vault"), encryption),
      subscription: {
        ...inactiveSubscription,
        status: async () => ({
          authenticated: true,
          expired: false,
          accountId: "account-a",
        }),
        acquireAccessLease: async () => ({
          accessToken: subscriptionToken("account-a"),
        }),
      },
      providerFetchFactory: () =>
        Object.assign(
          async () =>
            Response.json({
              models: [
                {
                  slug: "new-model",
                  visibility: "list",
                  priority: 0,
                  context_window: 300000,
                  supported_reasoning_levels: [],
                },
              ],
            }),
          { close: async () => undefined },
        ),
    });
    await service.initialize({});
    assert.equal(
      await service.autoConfigureSubscriptionModels(),
      true,
      "valid separate default Provider must not prevent subscription seeding",
    );
    const after = (await service.publicSettings()).profile;
    assert.deepEqual(after.defaultModel, {
      providerProfileId: "fake",
      modelId: "fake",
    });
    assert.deepEqual(after.titleModel, {
      providerProfileId: "openai-codex",
      modelId: "new-model",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
