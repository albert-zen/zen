import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyBuiltInModelCatalogPresets,
  hostConfigFromProfile,
  migrateLegacyHostProfile,
  structuredLegacyModelCatalog,
  validateHostProfile,
  ZenXHostProfileStore,
  type ZenXHostProfile,
} from "../src/main/host-profile.js";

const profile: ZenXHostProfile = {
  version: 3,
  onboardingComplete: true,
  computerForegroundControlEnabled: false,
  providerProfiles: [
    {
      providerProfileId: "local",
      type: "openai-compatible",
      name: "local",
      displayName: "Local model",
      baseUrl: "http://localhost:11434/v1",
      models: structuredLegacyModelCatalog("openai-compatible", [
        "qwen3",
        "deepseek-r1",
        "gpt-5.6-luna",
      ]).map((model) => ({ ...model, contextWindow: 32_768 })),
    },
  ],
  defaultModel: { providerProfileId: "local", modelId: "qwen3" },
  titleModel: { providerProfileId: "local", modelId: "gpt-5.6-luna" },
  workspace: path.join(os.tmpdir(), "workspace"),
  workspaces: [path.join(os.tmpdir(), "workspace")],
  lastUsedWorkspace: null,
  approvalPolicy: "always",
  toolPresentation: "both",
  pinnedThreadIds: [],
  sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
};

test("foreground computer control is an explicit persisted opt-in", async () => {
  assert.equal(
    validateHostProfile(profile).computerForegroundControlEnabled,
    false,
  );
  assert.equal(
    validateHostProfile({ ...profile, computerForegroundControlEnabled: true })
      .computerForegroundControlEnabled,
    true,
  );

  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-foreground-profile-"),
  );
  const file = path.join(directory, "host-profile.json");
  try {
    const legacyV3 = { ...profile } as Record<string, unknown>;
    delete legacyV3.computerForegroundControlEnabled;
    delete legacyV3.toolPresentation;
    await writeFile(file, JSON.stringify(legacyV3), { mode: 0o600 });

    const migrated = await new ZenXHostProfileStore(file).readOptional();
    assert.equal(migrated?.computerForegroundControlEnabled, false);
    assert.equal(migrated?.toolPresentation, "both");
    assert.equal(
      (JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>)[
        "computerForegroundControlEnabled"
      ],
      false,
    );

    await new ZenXHostProfileStore(file).write({
      ...profile,
      computerForegroundControlEnabled: true,
    });
    assert.equal(
      (await new ZenXHostProfileStore(file).readOptional())
        ?.computerForegroundControlEnabled,
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validates and projects Host-owned tool presentation without Thread state", () => {
  for (const toolPresentation of ["direct", "code", "both"] as const) {
    const validated = validateHostProfile({ ...profile, toolPresentation });
    const config = hostConfigFromProfile(validated, {
      dataDirectory: path.join(os.tmpdir(), "data"),
      subscriptionProfilePath: path.join(os.tmpdir(), "auth"),
      fallbackWorkspace: path.join(os.tmpdir(), "fallback"),
      apiKeys: { local: "secret" },
    });
    assert.equal(validated.toolPresentation, toolPresentation);
    assert.equal(config.toolPresentation, toolPresentation);
  }
  assert.throws(
    () => validateHostProfile({ ...profile, toolPresentation: "automatic" }),
    /tool presentation must be direct, code, or both/u,
  );
});

test("round-trips credential-free v3 profiles and builds all host registry entries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-profile-"));
  try {
    const store = new ZenXHostProfileStore(
      path.join(directory, "host-profile.json"),
    );
    await store.write(profile);
    const read = await store.read(profile);
    assert.deepEqual(read, {
      ...profile,
      workspace: path.resolve(profile.workspace!),
      workspaces: [path.resolve(profile.workspace!)],
    });
    const config = hostConfigFromProfile(read, {
      dataDirectory: path.join(os.tmpdir(), "data"),
      subscriptionProfilePath: path.join(os.tmpdir(), "auth"),
      fallbackWorkspace: path.join(os.tmpdir(), "fallback"),
      apiKeys: { local: "secret" },
    });
    assert.deepEqual(
      config.providers?.[0]?.modelCatalog?.map((entry) => entry.id),
      ["qwen3", "deepseek-r1", "gpt-5.6-luna"],
    );
    assert.deepEqual(config.defaultSelection, profile.defaultModel);
    assert.equal(config.maxToolRounds, undefined);
    assert.equal(JSON.stringify(read).includes("secret"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy profiles remain readable but an incomplete default or title model cannot build runtime config", async () => {
  const incomplete = {
    ...profile.providerProfiles[0]!.models[0]!,
    contextWindow: null,
    source: "discovered" as const,
  };
  const legacyTolerant = validateHostProfile({
    ...profile,
    providerProfiles: [
      {
        ...profile.providerProfiles[0]!,
        models: [incomplete, ...profile.providerProfiles[0]!.models.slice(1)],
      },
    ],
  });

  assert.equal(
    legacyTolerant.providerProfiles[0]?.models[0]?.contextWindow,
    null,
  );
  assert.throws(
    () =>
      hostConfigFromProfile(legacyTolerant, {
        dataDirectory: path.join(os.tmpdir(), "data"),
        subscriptionProfilePath: path.join(os.tmpdir(), "auth"),
        fallbackWorkspace: path.join(os.tmpdir(), "fallback"),
        apiKeys: { local: "secret" },
      }),
    /default model qwen3.*positive context window/u,
  );

  const titleIncomplete = validateHostProfile({
    ...profile,
    providerProfiles: [
      {
        ...profile.providerProfiles[0]!,
        models: profile.providerProfiles[0]!.models.map((model) =>
          model.id === "gpt-5.6-luna"
            ? { ...model, contextWindow: null, source: "legacy" as const }
            : model,
        ),
      },
    ],
  });
  assert.throws(
    () =>
      hostConfigFromProfile(titleIncomplete, {
        dataDirectory: path.join(os.tmpdir(), "data"),
        subscriptionProfilePath: path.join(os.tmpdir(), "auth"),
        fallbackWorkspace: path.join(os.tmpdir(), "fallback"),
        apiKeys: { local: "secret" },
      }),
    /title model gpt-5\.6-luna.*positive context window/u,
  );
});

test("validates and projects an opt-in maximum tool round setting", () => {
  const configured = validateHostProfile({ ...profile, maxToolRounds: 24 });
  const config = hostConfigFromProfile(configured, {
    dataDirectory: path.join(os.tmpdir(), "data"),
    subscriptionProfilePath: path.join(os.tmpdir(), "auth"),
    fallbackWorkspace: path.join(os.tmpdir(), "fallback"),
    apiKeys: { local: "secret" },
  });

  assert.equal(configured.maxToolRounds, 24);
  assert.equal(config.maxToolRounds, 24);
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => validateHostProfile({ ...profile, maxToolRounds: invalid }),
      /maximum tool rounds/u,
    );
  }
});

test("validates and projects the optional context compaction prompt", () => {
  const configured = validateHostProfile({
    ...profile,
    contextCompaction: {
      summaryInstruction: "Custom summary prompt.",
    },
  });
  const config = hostConfigFromProfile(configured, {
    dataDirectory: path.join(os.tmpdir(), "data"),
    subscriptionProfilePath: path.join(os.tmpdir(), "auth"),
    fallbackWorkspace: path.join(os.tmpdir(), "fallback"),
    apiKeys: { local: "secret" },
  });

  assert.deepEqual(configured.contextCompaction, {
    summaryInstruction: "Custom summary prompt.",
  });
  assert.deepEqual(config.contextCompaction, configured.contextCompaction);
  assert.equal(
    validateHostProfile({ ...profile, contextCompaction: {} })
      .contextCompaction,
    undefined,
  );
  assert.throws(
    () =>
      validateHostProfile({
        ...profile,
        contextCompaction: { summaryInstruction: "" },
      }),
    /context compaction prompt/u,
  );
});

test("migrates v1 deterministically, persists v3, and preserves adapter identity and preferences", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-profile-v1-"));
  const file = path.join(directory, "host-profile.json");
  try {
    const legacy = {
      version: 1,
      onboardingComplete: true,
      provider: {
        type: "openai-compatible",
        name: "legacy-runtime",
        displayName: "Legacy",
        baseUrl: "https://example.com/v1",
      },
      defaultModel: "shared",
      titleModel: "title-only",
      models: ["shared"],
      workspace: "/tmp/work",
      workspaces: ["/tmp/work", "/tmp/other"],
      lastUsedWorkspace: "/tmp/other",
      approvalPolicy: "never",
      pinnedThreadIds: ["thread-1"],
      sidebarOrder: { projectKeys: ["one"], threadIdsByProject: {} },
    };
    await writeFile(file, JSON.stringify(legacy), { mode: 0o600 });
    const store = new ZenXHostProfileStore(file);
    const first = await store.readOptional();
    const persistedAfterFirst = await readFile(file, "utf8");
    const second = await store.readOptional();
    assert.deepEqual(second, first);
    assert.equal(await readFile(file, "utf8"), persistedAfterFirst);
    assert.equal(first?.version, 3);
    assert.equal(
      first?.providerProfiles[0]?.providerProfileId,
      "legacy-runtime",
    );
    assert.deepEqual(first?.defaultModel, {
      providerProfileId: "legacy-runtime",
      modelId: "shared",
    });
    assert.deepEqual(first?.pinnedThreadIds, ["thread-1"]);
    assert.equal(first?.lastUsedWorkspace, path.resolve("/tmp/other"));
    assert.equal(first?.computerForegroundControlEnabled, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v1 migration preserves fake and OpenAI subscription runtime identities", () => {
  for (const [provider, expected] of [
    [{ type: "fake", displayName: "Local demo" }, "fake"],
    [
      { type: "openai-subscription", displayName: "OpenAI subscription" },
      "openai-codex",
    ],
  ] as const) {
    const migrated = migrateLegacyHostProfile({
      version: 1,
      provider,
      defaultModel: "model",
      titleModel: "model",
      models: ["model"],
      workspace: null,
      approvalPolicy: "never",
    });
    assert.equal(migrated.providerProfiles[0]?.providerProfileId, expected);
  }
});

test("upgrades an existing subscription catalog with current presets while preserving manual overrides", () => {
  const oldTerra = {
    ...structuredLegacyModelCatalog("openai-subscription", [
      "gpt-5.6-terra",
    ])[0]!,
    supportedReasoningEfforts: ["medium"],
    inputModalities: ["text" as const],
  };
  const luna = {
    ...structuredLegacyModelCatalog("openai-subscription", [
      "gpt-5.6-luna",
    ])[0]!,
    displayName: "Luna override",
    source: "manual" as const,
  };
  const upgraded = applyBuiltInModelCatalogPresets({
    ...profile,
    providerProfiles: [
      {
        providerProfileId: "openai-codex",
        type: "openai-subscription",
        displayName: "OpenAI subscription",
        models: [oldTerra, luna],
      },
    ],
    defaultModel: {
      providerProfileId: "openai-codex",
      modelId: "gpt-5.6-terra",
    },
    titleModel: {
      providerProfileId: "openai-codex",
      modelId: "gpt-5.6-terra",
    },
  });
  assert.deepEqual(
    upgraded.providerProfiles[0]?.models.map((model) => model.id),
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
  );
  assert.deepEqual(
    upgraded.providerProfiles[0]?.models[1]?.supportedReasoningEfforts,
    ["low", "medium", "high", "xhigh", "max", "ultra"],
  );
  assert.deepEqual(upgraded.providerProfiles[0]?.models[1]?.inputModalities, [
    "text",
    "image",
  ]);
  assert.equal(
    upgraded.providerProfiles[0]?.models[2]?.displayName,
    "Luna override",
  );
  assert.equal(upgraded.providerProfiles[0]?.models[2]?.source, "manual");
});

test("migrates unconfigured compatible models to text-only without inferring provider controls", () => {
  const unconfigured = {
    ...profile.providerProfiles[0]!.models[1]!,
    source: "manual" as const,
    supportedReasoningEfforts: null,
    defaultReasoningEffort: null,
    inputModalities: null,
    contextWindow: null,
  };
  const upgraded = applyBuiltInModelCatalogPresets({
    ...profile,
    providerProfiles: [
      {
        ...profile.providerProfiles[0]!,
        models: [profile.providerProfiles[0]!.models[0]!, unconfigured],
      },
    ],
    titleModel: profile.defaultModel,
  });

  const migrated = upgraded.providerProfiles[0]!.models[1]!;
  assert.deepEqual(migrated.supportedReasoningEfforts, []);
  assert.equal(migrated.defaultReasoningEffort, null);
  assert.deepEqual(migrated.inputModalities, ["text"]);
  assert.equal(migrated.contextWindow, null);
});

test("migrates v2 string catalogs deterministically without changing active model references", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-profile-v2-"));
  const file = path.join(directory, "host-profile.json");
  try {
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        onboardingComplete: true,
        providerProfiles: [
          {
            providerProfileId: "openai-codex",
            type: "openai-subscription",
            displayName: "OpenAI subscription",
            models: ["gpt-5.6-terra", "custom-confirmed"],
          },
        ],
        defaultModel: {
          providerProfileId: "openai-codex",
          modelId: "custom-confirmed",
        },
        titleModel: {
          providerProfileId: "openai-codex",
          modelId: "gpt-5.6-terra",
        },
        workspace: null,
        workspaces: [],
        lastUsedWorkspace: null,
        approvalPolicy: "never",
        pinnedThreadIds: [],
        sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
      }),
      { mode: 0o600 },
    );
    const migrated = await new ZenXHostProfileStore(file).readOptional();
    assert.equal(migrated?.version, 3);
    assert.deepEqual(migrated?.defaultModel, {
      providerProfileId: "openai-codex",
      modelId: "custom-confirmed",
    });
    assert.deepEqual(
      migrated?.providerProfiles[0]?.models.map((model) => [
        model.id,
        model.source,
        model.defaultReasoningEffort,
      ]),
      [
        ["gpt-5.6-sol", "preset", "medium"],
        ["gpt-5.6-terra", "preset", "medium"],
        ["gpt-5.6-luna", "preset", "medium"],
        ["gpt-5.5", "preset", "medium"],
        ["gpt-5.4", "preset", "medium"],
        ["custom-confirmed", "legacy", "medium"],
      ],
    );
    assert.equal(JSON.parse(await readFile(file, "utf8")).version, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validates duplicate, dangling, missing model, bounded id, URL, and secret fields", () => {
  assert.throws(
    () =>
      validateHostProfile({
        ...profile,
        providerProfiles: [
          ...profile.providerProfiles,
          { ...profile.providerProfiles[0] },
        ],
      }),
    /ids must be unique/u,
  );
  assert.throws(
    () =>
      validateHostProfile({
        ...profile,
        defaultModel: { providerProfileId: "missing", modelId: "qwen3" },
      }),
    /unknown Provider profile/u,
  );
  assert.throws(
    () =>
      validateHostProfile({
        ...profile,
        titleModel: { providerProfileId: "local", modelId: "missing" },
      }),
    /absent/u,
  );
  assert.throws(
    () =>
      validateHostProfile({
        ...profile,
        providerProfiles: [
          {
            ...profile.providerProfiles[0],
            models: [
              profile.providerProfiles[0]!.models[0],
              profile.providerProfiles[0]!.models[0],
            ],
          },
        ],
      }),
    /unique per Provider profile/u,
  );
  assert.throws(
    () =>
      validateHostProfile({
        ...profile,
        providerProfiles: [
          {
            ...profile.providerProfiles[0],
            models: [
              {
                ...profile.providerProfiles[0]!.models[0],
                source: "marketing",
              },
            ],
          },
        ],
      }),
    /catalog metadata is invalid/u,
  );
  assert.throws(
    () =>
      validateHostProfile({
        ...profile,
        titleModel: profile.defaultModel,
        providerProfiles: [
          {
            ...profile.providerProfiles[0],
            models: [
              {
                ...profile.providerProfiles[0]!.models[0],
                supportedReasoningEfforts: null,
                defaultReasoningEffort: null,
                inputModalities: null,
                source: "discovered",
              },
            ],
          },
        ],
      }),
    /default model requires a known default reasoning effort/u,
  );
  assert.throws(
    () =>
      validateHostProfile({
        ...profile,
        titleModel: profile.defaultModel,
        providerProfiles: [
          {
            ...profile.providerProfiles[0],
            models: [
              {
                ...profile.providerProfiles[0]!.models[0],
                inputModalities: null,
                source: "manual",
              },
            ],
          },
        ],
      }),
    /default model requires known text input modalities/u,
  );
  assert.throws(
    () =>
      validateHostProfile({
        ...profile,
        providerProfiles: [
          {
            ...profile.providerProfiles[0],
            providerProfileId: "x".repeat(513),
          },
        ],
      }),
    /profile id is invalid/u,
  );
  assert.throws(
    () =>
      validateHostProfile({
        ...profile,
        providerProfiles: [
          {
            ...profile.providerProfiles[0],
            baseUrl: "https://user:pass@example.com/v1",
          },
        ],
      }),
    /must not contain credentials/u,
  );
  assert.throws(
    () =>
      validateHostProfile({
        ...profile,
        providerProfiles: [
          {
            ...profile.providerProfiles[0],
            baseUrl: "https://example.com/v1?token=forbidden",
          },
        ],
      }),
    /must not contain query or fragment/u,
  );
  assert.doesNotMatch(
    JSON.stringify(
      validateHostProfile({
        ...profile,
        providerProfiles: [
          { ...profile.providerProfiles[0], apiKey: "must-not-persist" },
        ],
      }),
    ),
    /must-not-persist/u,
  );
});

test("reports corrupt profile data instead of silently replacing it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-profile-bad-"));
  try {
    const file = path.join(directory, "host-profile.json");
    await writeFile(file, "{not-json", { mode: 0o600 });
    await assert.rejects(
      new ZenXHostProfileStore(file).read(profile),
      /contains invalid JSON/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent profile stores use independent atomic staging files", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-concurrent-"),
  );
  try {
    const file = path.join(directory, "host-profile.json");
    const first = new ZenXHostProfileStore(file);
    const second = new ZenXHostProfileStore(file);
    await Promise.all([
      first.write(profile),
      second.write({
        ...profile,
        defaultModel: { providerProfileId: "local", modelId: "deepseek-r1" },
      }),
    ]);
    const persisted = await first.read(profile);
    assert.ok(
      ["qwen3", "deepseek-r1"].includes(persisted.defaultModel.modelId),
    );
    assert.deepEqual(await readdir(directory), ["host-profile.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
