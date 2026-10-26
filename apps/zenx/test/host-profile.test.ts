import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
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
  experimentalRtkEnabled: false,
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
  composerSendMode: "queue",
  pinnedThreadIds: [],
  visibleSubagentThreadIds: [],
  sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
};

for (const legacyOwnershipMarker of [false, true]) {
  test(`loading a saved subscription catalog preserves deletions and metadata (legacy marker: ${legacyOwnershipMarker})`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "zenx-saved-catalog-"),
    );
    const file = path.join(directory, "host-profile.json");
    try {
      const models = structuredLegacyModelCatalog("openai-subscription", [
        "gpt-5.6-luna",
        "gpt-5.6-terra",
      ]).map((model, index) => ({
        ...model,
        displayName: `My model ${index}`,
        description: "Saved capability choices",
        hidden: index === 0,
        contextWindow: 64_000,
        supportedReasoningEfforts: ["high"],
        defaultReasoningEffort: "high",
        inputModalities: ["text" as const],
      }));
      const reference = {
        providerProfileId: "openai-codex",
        modelId: "gpt-5.6-terra",
      };
      await writeFile(
        file,
        JSON.stringify({
          ...profile,
          providerProfiles: [
            {
              providerProfileId: "openai-codex",
              type: "openai-subscription",
              displayName: "OpenAI subscription",
              models,
              ...(legacyOwnershipMarker ? { modelsUserConfigured: true } : {}),
            },
          ],
          defaultModel: reference,
          titleModel: reference,
        }),
      );
      const store = new ZenXHostProfileStore(file);
      for (let load = 0; load < 2; load++) {
        const loaded = await store.readOptional();
        assert.deepEqual(loaded?.providerProfiles[0]?.models, models);
        assert.deepEqual(loaded?.defaultModel, reference);
        assert.deepEqual(loaded?.titleModel, reference);
        const persisted = JSON.parse(await readFile(file, "utf8"));
        assert.deepEqual(persisted.providerProfiles[0].models, models);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("loading a saved compatible catalog keeps explicitly unknown capabilities", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-unknown-catalog-"),
  );
  try {
    const store = new ZenXHostProfileStore(
      path.join(directory, "profile.json"),
    );
    const models = profile.providerProfiles[0]!.models.map((model, index) =>
      index === 1
        ? {
            ...model,
            supportedReasoningEfforts: null,
            defaultReasoningEffort: null,
            inputModalities: null,
            contextWindow: null,
          }
        : model,
    );
    await store.write({
      ...profile,
      providerProfiles: [{ ...profile.providerProfiles[0]!, models }],
    });
    const loaded = await store.readOptional();
    assert.deepEqual(loaded?.providerProfiles[0]?.models, models);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizes explicit child Thread Sidebar visibility independently of Pins", () => {
  const legacy = { ...profile } as Record<string, unknown>;
  delete legacy.visibleSubagentThreadIds;
  legacy.pinnedThreadIds = ["child-pinned"];
  assert.deepEqual(validateHostProfile(legacy).visibleSubagentThreadIds, []);

  const input = {
    ...profile,
    pinnedThreadIds: ["child-pinned", "root"],
    visibleSubagentThreadIds: [" child-b ", "child-a", "child-b", " child-a"],
    sidebarOrder: {
      pinnedProjectKeys: ["project"],
      projectKeys: ["project"],
      threadIdsByProject: { project: ["child-a", "root", "child-b"] },
    },
  };
  const normalized = validateHostProfile(input);
  assert.deepEqual(normalized.visibleSubagentThreadIds, ["child-b", "child-a"]);
  assert.deepEqual(normalized.pinnedThreadIds, input.pinnedThreadIds);
  assert.deepEqual(normalized.sidebarOrder, input.sidebarOrder);
  assert.deepEqual(input.visibleSubagentThreadIds, [
    " child-b ",
    "child-a",
    "child-b",
    " child-a",
  ]);
});

test("rejects malformed or unbounded child Thread Sidebar visibility preferences", () => {
  for (const visibleSubagentThreadIds of [
    null,
    "child-a",
    {},
    [null],
    [1],
    [""],
    ["   "],
    ["x".repeat(513)],
    Array.from({ length: 4_097 }, (_, index) => `child-${index}`),
  ]) {
    assert.throws(
      () => validateHostProfile({ ...profile, visibleSubagentThreadIds }),
      /visible Subagent Thread (?:list|id) is invalid/u,
    );
  }
  const atLimit = Array.from({ length: 4_096 }, (_, index) => `child-${index}`);
  atLimit[0] = "x".repeat(512);
  assert.deepEqual(
    validateHostProfile({ ...profile, visibleSubagentThreadIds: atLimit })
      .visibleSubagentThreadIds,
    atLimit,
  );
});

test("persists the hidden-by-default migration without deriving visibility from Pins", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-child-sidebar-"),
  );
  const file = path.join(directory, "host-profile.json");
  try {
    const expected = validateHostProfile({
      ...profile,
      pinnedThreadIds: ["child-pinned", "root"],
      sidebarOrder: {
        projectKeys: ["project"],
        threadIdsByProject: { project: ["child-pinned", "root"] },
      },
    });
    const legacy = { ...expected } as Record<string, unknown>;
    delete legacy.visibleSubagentThreadIds;
    await writeFile(file, JSON.stringify(legacy));
    const first = await new ZenXHostProfileStore(file).readOptional();
    assert.deepEqual(first, expected);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), expected);
    const second = await new ZenXHostProfileStore(file).readOptional();
    assert.deepEqual(second, expected);

    await new ZenXHostProfileStore(file).write({
      ...expected,
      visibleSubagentThreadIds: [" child-b ", "child-a", "child-b"],
    });
    assert.deepEqual(await new ZenXHostProfileStore(file).readOptional(), {
      ...expected,
      visibleSubagentThreadIds: ["child-b", "child-a"],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
    await store.write({ ...profile, composerSendModeExplicit: true });
    const read = await store.read(profile);
    assert.deepEqual(read, {
      ...profile,
      composerSendModeExplicit: true,
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
        visibleSubagentThreadIds: [],
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
        ["gpt-5.6-terra", "preset", "medium"],
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

test("composer send modes persist and reject unknown modes", async () => {
  assert.equal(
    validateHostProfile({ ...profile, composerSendMode: undefined })
      .composerSendMode,
    "soft",
  );
  assert.equal(
    validateHostProfile({ ...profile, composerSendMode: undefined })
      .composerSendModeExplicit,
    false,
  );
  assert.equal(
    validateHostProfile({ ...profile, composerSendMode: "soft" })
      .composerSendModeExplicit,
    true,
  );
  assert.equal(
    validateHostProfile({ ...profile, composerSendMode: "queue" })
      .composerSendModeExplicit,
    false,
  );
  assert.equal(
    validateHostProfile({
      ...profile,
      composerSendMode: "soft",
      composerSendModeExplicit: false,
    }).composerSendModeExplicit,
    false,
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-send-mode-"));
  try {
    const store = new ZenXHostProfileStore(
      path.join(directory, "profile.json"),
    );
    for (const composerSendMode of [
      "batch",
      "queue",
      "soft",
      "hard",
    ] as const) {
      await store.write({
        ...profile,
        composerSendMode,
        composerSendModeExplicit: true,
      });
      assert.equal(
        (await store.read(profile)).composerSendMode,
        composerSendMode,
      );
    }
    assert.throws(
      () => validateHostProfile({ ...profile, composerSendMode: "invalid" }),
      /send mode/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("old ambiguous Queue is migrated once with an undo record; trustworthy choices survive", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-old-queue-"));
  try {
    const filename = path.join(directory, "host-profile.json");
    const store = new ZenXHostProfileStore(filename);
    // Earlier versions wrote Queue into the profile even when no user chose it.
    await writeFile(filename, JSON.stringify(profile));
    const migrated = await store.read(profile);
    assert.equal(migrated.composerSendMode, "soft");
    assert.equal(migrated.composerSendModeExplicit, false);
    assert.deepEqual(migrated.composerSendModeMigration, {
      version: 1,
      previousMode: "queue",
      acknowledged: false,
    });
    assert.equal(
      JSON.parse(await readFile(filename, "utf8")).composerSendMode,
      "soft",
    );
    assert.deepEqual(await store.read(profile), migrated);

    // The explicit restore is persisted, not a repeated migration on reopen.
    await store.write({
      ...migrated,
      composerSendMode: "queue",
      composerSendModeExplicit: true,
      composerSendModeMigration: {
        version: 1,
        previousMode: "queue",
        acknowledged: true,
      },
    });
    assert.equal((await store.read(profile)).composerSendMode, "queue");
    assert.equal((await store.read(profile)).composerSendModeExplicit, true);
    for (const mode of ["soft", "hard", "batch"] as const) {
      const fromPast = validateHostProfile({
        ...profile,
        composerSendMode: mode,
        ...(mode === "batch" ? { composerSendModeExplicit: false } : {}),
      });
      assert.equal(fromPast.composerSendMode, mode === "batch" ? "soft" : mode);
      assert.equal(fromPast.composerSendModeMigration, undefined);
    }
    assert.equal(
      validateHostProfile({ ...profile, composerSendModeExplicit: true })
        .composerSendMode,
      "queue",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("implicit Composer modes normalize to soft without changing explicit choices", () => {
  const { composerSendMode: _mode, ...missing } = profile;
  assert.equal(validateHostProfile(missing).composerSendMode, "soft");
  for (const mode of ["queue", "batch", "hard"] as const) {
    assert.equal(
      validateHostProfile({
        ...profile,
        composerSendMode: mode,
        composerSendModeExplicit: false,
      }).composerSendMode,
      "soft",
    );
    assert.equal(
      validateHostProfile({
        ...profile,
        composerSendMode: mode,
        composerSendModeExplicit: true,
      }).composerSendMode,
      mode,
    );
  }
  assert.throws(
    () =>
      validateHostProfile({
        ...profile,
        composerSendMode: "invalid",
        composerSendModeExplicit: false,
      }),
    /send mode/,
  );
});

test("compaction retention settings persist without requiring a custom prompt and reach the Host", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-compaction-settings-"),
  );
  try {
    const config = {
      triggerPercent: 90,
      targetPercent: 60,
      retention: {
        mode: "recent-items" as const,
        recentItemCount: 20,
        preserveUserMessages: true,
        finalMessages: "recent" as const,
        finalMessageCount: 10,
      },
    };
    const store = new ZenXHostProfileStore(
      path.join(directory, "profile.json"),
    );
    await store.write({ ...profile, contextCompaction: config });
    const loaded = await store.read(profile);
    assert.deepEqual(loaded?.contextCompaction, config);
    assert.deepEqual(
      hostConfigFromProfile(loaded!, {
        dataDirectory: directory,
        subscriptionProfilePath: path.join(directory, "auth"),
        fallbackWorkspace: directory,
        apiKeys: { local: "test-key" },
      }).contextCompaction,
      config,
    );
    assert.throws(() =>
      validateHostProfile({
        ...profile,
        contextCompaction: { ...config, targetPercent: 95 },
      }),
    );
    assert.throws(() =>
      validateHostProfile({
        ...profile,
        contextCompaction: {
          retention: { mode: "recent-items", recentItemCount: 0 },
        },
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("project names preserve Windows case-insensitive workspace identity", () => {
  const configured = validateHostProfile(
    {
      ...profile,
      workspace: "C:\\Work",
      workspaces: ["C:\\Work"],
      lastUsedWorkspace: null,
      projectNames: { "c:\\work": "Renamed" },
    },
    "win32",
  );
  assert.deepEqual(configured.projectNames, { "C:\\Work": "Renamed" });
});

test("Agentic compaction opt-in persists, reaches Host configuration, and validates its type", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-agentic-settings-"),
  );
  try {
    const store = new ZenXHostProfileStore(
      path.join(directory, "profile.json"),
    );
    assert.equal(profile.contextCompaction?.agenticEnabled, undefined);
    for (const agenticEnabled of [true, false]) {
      const contextCompaction = { agenticEnabled, triggerPercent: 90 };
      await store.write({ ...profile, contextCompaction });
      const loaded = await store.read(profile);
      assert.deepEqual(loaded?.contextCompaction, contextCompaction);
      assert.deepEqual(
        hostConfigFromProfile(loaded!, {
          dataDirectory: directory,
          subscriptionProfilePath: path.join(directory, "auth"),
          fallbackWorkspace: directory,
          apiKeys: { local: "test-key" },
        }).contextCompaction,
        contextCompaction,
      );
    }
    assert.throws(
      () =>
        validateHostProfile({
          ...profile,
          contextCompaction: { agenticEnabled: "true" },
        }),
      /agenticEnabled/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("RTK is an explicit boolean opt-in retained through profile persistence", async () => {
  assert.equal(validateHostProfile(profile).experimentalRtkEnabled, false);
  assert.throws(
    () => validateHostProfile({ ...profile, experimentalRtkEnabled: "true" }),
    /RTK/,
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-rtk-profile-"));
  try {
    const store = new ZenXHostProfileStore(
      path.join(directory, "profile.json"),
    );
    await store.write({ ...profile, experimentalRtkEnabled: true });
    assert.equal((await store.readOptional())?.experimentalRtkEnabled, true);
    await store.write({ ...profile, experimentalRtkEnabled: false });
    assert.equal((await store.readOptional())?.experimentalRtkEnabled, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public Responses protocol is explicit and missing legacy protocol roundtrips unchanged", () => {
  const legacy = validateHostProfile(profile);
  assert.equal(Object.hasOwn(legacy.providerProfiles[0]!, "protocol"), false);
  assert.deepEqual(
    validateHostProfile(JSON.parse(JSON.stringify(legacy))),
    legacy,
  );
  for (const protocol of ["responses", "chat-completions"] as const) {
    const selected = validateHostProfile({
      ...profile,
      providerProfiles: profile.providerProfiles.map((provider) => ({
        ...provider,
        protocol,
      })),
    });
    const saved = selected.providerProfiles[0]!;
    assert.equal(saved.type, "openai-compatible");
    if (saved.type !== "openai-compatible") throw new Error("fixture type");
    assert.equal(saved.protocol, protocol);
    const config = hostConfigFromProfile(selected, {
      dataDirectory: path.join(os.tmpdir(), "data"),
      subscriptionProfilePath: path.join(os.tmpdir(), "auth"),
      fallbackWorkspace: path.join(os.tmpdir(), "fallback"),
      apiKeys: { local: "synthetic" },
    });
    assert.equal(config.providers![0]!.provider.type, "openai-compatible");
    if (config.providers![0]!.provider.type !== "openai-compatible")
      throw new Error("fixture type");
    assert.equal(
      (config.providers![0]!.provider as { protocol?: string }).protocol,
      protocol,
    );
  }
  assert.throws(
    () =>
      validateHostProfile({
        ...profile,
        providerProfiles: profile.providerProfiles.map((provider) => ({
          ...provider,
          protocol: "automatic",
        })),
      }),
    /protocol/u,
  );
});

test("external application preferences omit the empty default and preserve configured paths across round trips", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-external-apps-"),
  );
  try {
    const file = path.join(directory, "host-profile.json");
    const store = new ZenXHostProfileStore(file);
    for (const applications of [
      undefined,
      {},
      {
        custom: "/Applications/My Editor.app",
        vscode: "C:\\Editors\\Code.exe",
      },
    ]) {
      const input = {
        ...profile,
        composerSendModeExplicit: true,
        ...(applications === undefined
          ? {}
          : { externalApplications: applications }),
      };
      const expected =
        applications && Object.keys(applications).length
          ? applications
          : undefined;
      await store.write(input);
      for (let round = 0; round < 2; round++) {
        const loaded = await store.read(profile);
        const persisted = JSON.parse(await readFile(file, "utf8"));
        assert.deepEqual(loaded.externalApplications, expected);
        assert.deepEqual(persisted.externalApplications, expected);
        assert.equal(
          Object.hasOwn(loaded, "externalApplications"),
          expected !== undefined,
        );
        assert.equal(
          Object.hasOwn(persisted, "externalApplications"),
          expected !== undefined,
        );
        await store.write(loaded);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
