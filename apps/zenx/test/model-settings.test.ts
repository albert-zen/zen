import assert from "node:assert/strict";
import test from "node:test";

import type {
  ModelSummary,
  Thread,
  ThreadSettingsSnapshot,
  UpdatedThreadSettings,
} from "../src/protocol-client/index.js";
import {
  applySettingsMirror,
  canChangeThreadModel,
  modelOptions,
  settingsFromSnapshot,
  validateModelCatalog,
} from "../src/renderer/src/model-settings.js";

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

test("initializes from resume, mirrors only ZAS events, and blocks active turns", () => {
  const snapshot = settingsSnapshot("model-a");
  const selected = settingsFromSnapshot("thread-1", snapshot);
  assert.equal(selected.model, "model-a");
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

  const idle = makeThread("completed");
  const active = makeThread("inProgress");
  assert.equal(canChangeThreadModel(idle), true);
  assert.equal(canChangeThreadModel(active), false);
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
    reasoningEffort: null,
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
    effort: null,
    model: modelId,
    modelProvider: "fake",
    personality: null,
    sandboxPolicy: { type: "dangerFullAccess" },
    serviceTier: null,
    summary: null,
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
