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
