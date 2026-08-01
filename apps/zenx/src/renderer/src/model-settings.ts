import type {
  ModelSummary,
  ThreadSettingsSnapshot,
  UpdatedThreadSettings,
  Thread,
} from "../../protocol-client/index.js";

export interface SelectedThreadSettings {
  threadId: string;
  model: string;
  modelProvider: string;
}

export function canChangeThreadModel(thread: Thread): boolean {
  return !thread.turns.some((turn) => turn.status === "inProgress");
}

export function settingsFromSnapshot(
  threadId: string,
  snapshot: ThreadSettingsSnapshot,
): SelectedThreadSettings {
  return {
    threadId,
    model: snapshot.model,
    modelProvider: snapshot.modelProvider,
  };
}

export function applySettingsMirror(
  current: SelectedThreadSettings | null,
  threadId: string,
  settings: UpdatedThreadSettings,
): SelectedThreadSettings | null {
  return current?.threadId === threadId
    ? {
        threadId,
        model: settings.model,
        modelProvider: settings.modelProvider,
      }
    : current;
}

export function validateModelCatalog(models: readonly ModelSummary[]): void {
  const defaults = models.filter((model) => model.isDefault);
  if (defaults.length !== 1 || defaults[0]?.hidden === true) {
    throw new Error("App Server must expose exactly one visible default model");
  }
}

export function modelOptions(
  models: readonly ModelSummary[],
  selectedModel: string,
): Array<ModelSummary & { unavailable: boolean }> {
  const visible = models
    .filter((model) => !model.hidden)
    .map((model) => ({ ...model, unavailable: false }));
  if (visible.some((model) => model.id === selectedModel)) return visible;
  const selected = models.find((model) => model.id === selectedModel);
  if (selected === undefined) {
    return [
      ...visible,
      {
        id: selectedModel,
        model: selectedModel,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: selectedModel,
        description: "Configured by the App Server",
        hidden: true,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: "medium",
        inputModalities: ["text"],
        supportsPersonality: false,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: false,
        unavailable: true,
      },
    ];
  }
  return [...visible, { ...selected, unavailable: true }];
}
