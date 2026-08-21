import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  hostConfigFromProfile,
  migrateLegacyHostProfile,
  validateHostProfile,
  ZenXHostProfileStore,
  type ZenXHostProfile,
} from "../src/main/host-profile.js";

const profile: ZenXHostProfile = {
  version: 2,
  onboardingComplete: true,
  providerProfiles: [
    {
      providerProfileId: "local",
      type: "openai-compatible",
      name: "local",
      displayName: "Local model",
      baseUrl: "http://localhost:11434/v1",
      models: ["qwen3", "deepseek-r1", "gpt-5.6-luna"],
    },
  ],
  defaultModel: { providerProfileId: "local", modelId: "qwen3" },
  titleModel: { providerProfileId: "local", modelId: "gpt-5.6-luna" },
  workspace: path.join(os.tmpdir(), "workspace"),
  workspaces: [path.join(os.tmpdir(), "workspace")],
  lastUsedWorkspace: null,
  approvalPolicy: "always",
  pinnedThreadIds: [],
  sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
};

test("round-trips credential-free v2 profiles and builds all host registry entries", async () => {
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
    assert.deepEqual(config.providers?.[0]?.models, [
      "qwen3",
      "deepseek-r1",
      "gpt-5.6-luna",
    ]);
    assert.deepEqual(config.defaultSelection, profile.defaultModel);
    assert.equal(JSON.stringify(read).includes("secret"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrates v1 deterministically, persists v2, and preserves adapter identity and preferences", async () => {
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
    assert.equal(first?.version, 2);
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
