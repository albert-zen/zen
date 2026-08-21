import type {
  ClientRequestParams,
  ModelSummary,
  ThreadSettingsSnapshot,
  UpdatedThreadSettings,
  Thread,
} from "../../protocol-client/index.js";
import type { ZenXProviderProfile } from "../../main/host-profile.js";
import {
  decodeModelKey,
  encodeModelKey,
} from "../../../../../src/protocol/codex/model-key.js";

export interface SelectedThreadSettings {
  threadId: string;
  model: string;
  modelProvider: string;
  reasoningEffort: string | null;
}

export type ModelOption = Omit<
  ModelSummary,
  "supportedReasoningEfforts" | "defaultReasoningEffort" | "inputModalities"
> &
  Partial<
    Pick<
      ModelSummary,
      "supportedReasoningEfforts" | "defaultReasoningEffort" | "inputModalities"
    >
  > & { unavailable: boolean };

export interface ProviderModelGroup {
  providerProfileId: string;
  displayName: string;
  models: ModelSummary[];
}

export function canChangeThreadModel(_thread: Thread): boolean {
  return true;
}

export function settingsFromSnapshot(
  threadId: string,
  snapshot: ThreadSettingsSnapshot,
): SelectedThreadSettings {
  return {
    threadId,
    model: snapshot.model,
    modelProvider: snapshot.modelProvider,
    reasoningEffort: snapshot.reasoningEffort,
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
        reasoningEffort: settings.effort,
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
): ModelOption[] {
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

export function groupedModelOptions(
  models: readonly ModelSummary[],
  providerProfiles: readonly ZenXProviderProfile[],
): ProviderModelGroup[] {
  const available = new Map(
    models.filter((model) => !model.hidden).map((model) => [model.id, model]),
  );
  return providerProfiles.flatMap((provider) => {
    const providerModels = provider.models.flatMap((model) => {
      const key = encodeModelKey({
        providerProfileId: provider.providerProfileId,
        modelId: model.id,
      });
      const option = available.get(key);
      return option === undefined ? [] : [option];
    });
    return providerModels.length === 0
      ? []
      : [
          {
            providerProfileId: provider.providerProfileId,
            displayName: provider.displayName,
            models: providerModels,
          },
        ];
  });
}

export function reasoningOptions(
  models: readonly ModelSummary[],
  selectedModel: string,
): ModelSummary["supportedReasoningEfforts"] {
  const selected = models.find(
    (model) => model.id === selectedModel && !model.hidden,
  );
  return selected?.supportedReasoningEfforts ?? [];
}

export function canSendWithModel(
  models: readonly ModelSummary[],
  selectedModel: string,
): boolean {
  return models.some(
    (model) => model.id === selectedModel && model.hidden === false,
  );
}

export function imageCapabilityMessage(
  providerProfiles: readonly ZenXProviderProfile[],
  settings: SelectedThreadSettings | null,
): string | null {
  if (settings === null) return "Choose a model before sending images.";
  let identity: ReturnType<typeof decodeModelKey>;
  try {
    identity = decodeModelKey(settings.model);
  } catch {
    return "Choose a model with known image input support before sending images.";
  }
  const profile = providerProfiles.find(
    (entry) => entry.providerProfileId === identity.providerProfileId,
  );
  const model = profile?.models.find((entry) => entry.id === identity.modelId);
  const label = model?.displayName ?? identity.modelId;
  if (model?.inputModalities === null || model === undefined) {
    return `Image input capability for “${label}” is unknown. Set it in Models & providers or choose a model with image support.`;
  }
  return model.inputModalities.includes("image")
    ? null
    : `“${label}” does not support image input. Remove the images or choose a model with image support.`;
}

export function modelChangeRequest(
  threadId: string,
  model: string,
): ClientRequestParams["thread/settings/update"] {
  return { threadId, model };
}

export function reasoningChangeRequest(
  threadId: string,
  model: string,
  effort: string,
): ClientRequestParams["thread/settings/update"] {
  return { threadId, model, effort };
}
