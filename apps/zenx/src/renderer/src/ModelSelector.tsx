import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import { Select } from "./ui/controls.js";
import type { ModelSummary } from "../../protocol-client/index.js";
import { modelOptions } from "./model-settings";

interface ModelSelectorProps {
  disabled: boolean;
  error: string | null;
  models: readonly ModelSummary[];
  onChange(model: string): void;
  selectedModel: string;
  switching: boolean;
}

export function ModelSelector({
  disabled,
  error,
  models,
  onChange,
  selectedModel,
  switching,
}: ModelSelectorProps) {
  useTranslation("shell");
  const options = modelOptions(models, selectedModel);
  return (
    <div className="model-control">
      <label htmlFor="thread-model">{i18n.t("shell:model")}</label>
      <Select
        aria-describedby={error === null ? undefined : "model-error"}
        disabled={disabled || switching}
        id="thread-model"
        onValueChange={(value) => onChange(value)}
        value={selectedModel}
      >
        {options.map((model) => (
          <option disabled={model.unavailable} key={model.id} value={model.id}>
            {model.displayName}
            {model.isDefault ? i18n.t("shell:defaultModel") : ""}
            {model.unavailable ? i18n.t("shell:unavailableModelSuffix") : ""}
          </option>
        ))}
      </Select>
      {error === null ? null : (
        <span id="model-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
