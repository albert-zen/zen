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
  const options = modelOptions(models, selectedModel);
  return (
    <div className="model-control">
      <label htmlFor="thread-model">Model</label>
      <select
        aria-describedby={error === null ? undefined : "model-error"}
        disabled={disabled || switching}
        id="thread-model"
        onChange={(event) => onChange(event.target.value)}
        value={selectedModel}
      >
        {options.map((model) => (
          <option disabled={model.unavailable} key={model.id} value={model.id}>
            {model.displayName}
            {model.isDefault ? " · Default" : ""}
            {model.unavailable ? " · Unavailable" : ""}
          </option>
        ))}
      </select>
      {error === null ? null : (
        <span id="model-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
