import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  hostConfigFromProfile,
  validateHostProfile,
  ZenXHostProfileStore,
} from "../src/main/host-profile.js";

const profile = {
  version: 1 as const,
  onboardingComplete: true,
  provider: {
    type: "openai-compatible" as const,
    name: "local",
    displayName: "Local model",
    baseUrl: "http://localhost:11434/v1",
  },
  defaultModel: "qwen3",
  titleModel: "gpt-5.6-luna",
  models: ["qwen3", "deepseek-r1"],
  workspace: path.join(os.tmpdir(), "workspace"),
  workspaces: [path.join(os.tmpdir(), "workspace")],
  lastUsedWorkspace: null,
  pinnedThreadIds: ["thread-new", " thread-old ", "thread-new"],
  approvalPolicy: "always" as const,
};

test("round-trips credential-free host settings and builds the ModelCatalog config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-profile-"));
  try {
    const store = new ZenXHostProfileStore(
      path.join(directory, "host-profile.json"),
    );
    await store.write(profile);
    const read = await store.read({ ...profile, defaultModel: "unused" });
    assert.deepEqual(read, {
      ...profile,
      workspace: path.resolve(profile.workspace),
      workspaces: [path.resolve(profile.workspace)],
      pinnedThreadIds: ["thread-new", "thread-old"],
    });
    assert.deepEqual(
      hostConfigFromProfile(read, {
        dataDirectory: path.join(os.tmpdir(), "data"),
        subscriptionProfilePath: path.join(os.tmpdir(), "auth"),
        fallbackWorkspace: path.join(os.tmpdir(), "fallback"),
        apiKey: "secret",
      }).models,
      ["qwen3", "deepseek-r1"],
    );
    assert.equal(JSON.stringify(read).includes("secret"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects embedded URL credentials and missing default models", () => {
  assert.throws(
    () =>
      validateHostProfile({
        ...profile,
        provider: {
          ...profile.provider,
          baseUrl: "https://user:pass@example.com/v1",
        },
      }),
    /must not contain credentials/u,
  );
  assert.throws(
    () => validateHostProfile({ ...profile, models: ["other"] }),
    /include the default model/u,
  );
});

test("defaults legacy profiles to the independent Luna title model", () => {
  const {
    titleModel: _titleModel,
    workspaces: _workspaces,
    lastUsedWorkspace: _lastUsedWorkspace,
    pinnedThreadIds: _pinnedThreadIds,
    ...legacy
  } = profile;
  const validated = validateHostProfile(legacy);
  assert.equal(validated.titleModel, "gpt-5.6-luna");
  assert.deepEqual(validated.workspaces, [path.resolve(profile.workspace)]);
  assert.equal(validated.lastUsedWorkspace, null);
  assert.deepEqual(validated.pinnedThreadIds, []);
});

test("reports a corrupt persisted host profile instead of silently replacing it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-profile-bad-"));
  try {
    const file = path.join(directory, "host-profile.json");
    await writeFile(file, "{not-json", { mode: 0o600 });
    const store = new ZenXHostProfileStore(file);
    await assert.rejects(store.read(profile), /contains invalid JSON/u);
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
      first.write({ ...profile, defaultModel: "qwen3" }),
      second.write({ ...profile, defaultModel: "deepseek-r1" }),
    ]);

    const persisted = await first.read(profile);
    assert.ok(["qwen3", "deepseek-r1"].includes(persisted.defaultModel));
    assert.deepEqual(await readdir(directory), ["host-profile.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
