import assert from "node:assert/strict";
import test from "node:test";

import type {
  ModelSummary,
  Thread,
  ThreadSettingsSnapshot,
  UpdatedThreadSettings,
} from "../src/protocol-client/index.js";
import type { ZenXProviderProfile } from "../src/main/host-profile.js";
import { encodeModelKey } from "../../../src/protocol/codex/model-key.js";
import {
  applySettingsMirror,
  canSendWithModel,
  canChangeThreadModel,
  groupedModelOptions,
  imageCapabilityMessage,
  modelChangeRequest,
  modelOptions,
  reasoningChangeRequest,
  reasoningOptions,
  settingsFromSnapshot,
  validateModelCatalog,
} from "../src/renderer/src/model-settings.js";

test("reports unsupported and Unknown image capability precisely", () => {
  const selected = {
    threadId: "thread-1",
    model: key("provider", "vision"),
    modelProvider: "provider",
    reasoningEffort: "medium",
  };
  const unsupported = provider("provider", "Provider", ["vision"]);
  assert.match(
    imageCapabilityMessage([unsupported], selected) ?? "",
    /does not support image input/u,
  );
  const unknown = {
    ...unsupported,
    models: unsupported.models.map((entry) => ({
      ...entry,
      inputModalities: null,
    })),
  };
  assert.match(
    imageCapabilityMessage([unknown], selected) ?? "",
    /capability.*unknown/u,
  );
  const supported = {
    ...unsupported,
    models: unsupported.models.map((entry) => ({
      ...entry,
      inputModalities: ["text", "image"] as const,
    })),
  };
  assert.equal(imageCapabilityMessage([supported], selected), null);
});

test("shows only visible models while preserving a hidden authoritative value", () => {
  const visible = model("visible", { isDefault: true });
  const hidden = model("hidden", { hidden: true });
  validateModelCatalog([visible, hidden]);
  assert.deepEqual(
    modelOptions([visible, hidden], visible.id).map((entry) => entry.id),
    [visible.id],
  );
  assert.deepEqual(
    modelOptions([visible, hidden], hidden.id).map((entry) => [
      entry.id,
      entry.unavailable,
    ]),
    [
      [visible.id, false],
      [hidden.id, true],
    ],
  );
  assert.throws(
    () => validateModelCatalog([model("one"), model("two")]),
    /exactly one visible default/u,
  );
});

test("initializes from resume, mirrors only ZAS events, and allows next-turn changes", () => {
  const snapshot = settingsSnapshot("model-a");
  const selected = settingsFromSnapshot("thread-1", snapshot);
  assert.equal(selected.model, "model-a");
  assert.equal(selected.reasoningEffort, "high");
  const ignored = applySettingsMirror(
    selected,
    "thread-2",
    updatedSettings("model-b"),
  );
  assert.equal(ignored, selected);
  const mirrored = applySettingsMirror(
    selected,
    "thread-1",
    updatedSettings("model-b"),
  );
  assert.equal(mirrored?.model, "model-b");
  assert.equal(mirrored?.reasoningEffort, "low");

  const idle = makeThread("completed");
  const active = makeThread("inProgress");
  assert.equal(canChangeThreadModel(idle), true);
  assert.equal(canChangeThreadModel(active), true);
});

test("groups runnable visible models by Provider and lists only selected-model efforts", () => {
  const alphaKey = key("provider-alpha", "shared");
  const betaKey = key("provider-beta", "shared");
  const hiddenKey = key("provider-alpha", "hidden");
  const models = [
    model(alphaKey, {
      displayName: "Alpha Shared",
      isDefault: true,
      supportedReasoningEfforts: efforts("low", "medium"),
      defaultReasoningEffort: "medium",
      inputModalities: ["text", "image"],
    }),
    model(betaKey, {
      displayName: "Beta Shared",
      supportedReasoningEfforts: efforts("high"),
      defaultReasoningEffort: "high",
    }),
    model(hiddenKey, { hidden: true }),
  ];
  const groups = groupedModelOptions(models, [
    provider("provider-alpha", "Alpha", ["shared", "hidden"]),
    provider("provider-beta", "Beta", ["shared"]),
  ]);

  assert.deepEqual(
    groups.map((group) => [
      group.providerProfileId,
      group.displayName,
      group.models.map((entry) => entry.id),
    ]),
    [
      ["provider-alpha", "Alpha", [alphaKey]],
      ["provider-beta", "Beta", [betaKey]],
    ],
  );
  assert.deepEqual(
    reasoningOptions(models, alphaKey).map((entry) => entry.reasoningEffort),
    ["low", "medium"],
  );
  assert.equal(canSendWithModel(models, alphaKey), true);
  assert.equal(canSendWithModel(models, hiddenKey), false);
  assert.equal(canSendWithModel(models, key("deleted", "old")), false);
  assert.deepEqual(modelChangeRequest("thread-1", betaKey), {
    threadId: "thread-1",
    model: betaKey,
  });
  assert.deepEqual(reasoningChangeRequest("thread-1", alphaKey, "low"), {
    threadId: "thread-1",
    model: alphaKey,
    effort: "low",
  });
});

function model(
  id: string,
  overrides: Partial<ModelSummary> = {},
): ModelSummary {
  return {
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: id,
    description: id,
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
    ...overrides,
  };
}

function settingsSnapshot(modelId: string): ThreadSettingsSnapshot {
  return {
    model: modelId,
    modelProvider: "fake",
    serviceTier: null,
    cwd: "/workspace",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    reasoningEffort: "high",
  };
}

function updatedSettings(modelId: string): UpdatedThreadSettings {
  return {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    collaborationMode: {
      mode: "default",
      settings: { model: modelId, reasoning_effort: "medium" },
    },
    cwd: "/workspace",
    effort: "low",
    model: modelId,
    modelProvider: "fake",
    personality: null,
    sandboxPolicy: { type: "dangerFullAccess" },
    serviceTier: null,
    summary: null,
  };
}

function key(providerProfileId: string, modelId: string): string {
  return encodeModelKey({ providerProfileId, modelId });
}

function efforts(...values: string[]) {
  return values.map((reasoningEffort) => ({
    reasoningEffort,
    description: reasoningEffort,
  }));
}

function provider(
  providerProfileId: string,
  displayName: string,
  modelIds: string[],
): ZenXProviderProfile {
  return {
    type: "fake",
    providerProfileId,
    displayName,
    models: modelIds.map((id) => ({
      id,
      source: "manual",
      displayName: id,
      description: id,
      hidden: false,
      contextWindow: null,
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
      inputModalities: ["text"],
    })),
  };
}

function makeThread(status: "completed" | "inProgress"): Thread {
  return {
    id: "thread-1",
    sessionId: "thread-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "fake",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: null,
    status:
      status === "inProgress"
        ? { type: "active", activeFlags: [] }
        : { type: "idle" },
    path: null,
    cwd: "/workspace",
    cliVersion: "zen/0.1.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [
      {
        id: "turn-1",
        items: [],
        itemsView: "full",
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
    ],
  };
}
