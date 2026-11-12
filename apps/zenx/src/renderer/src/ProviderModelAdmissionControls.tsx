import { useTranslation } from "react-i18next";
import { remainingProviderModelSlots } from "./provider-model-admission.js";

export function ProviderModelDiscoveryOption({
  modelId,
  exists,
  selected,
  selectedCount,
  modelCount,
  onCheckedChange,
}: {
  modelId: string;
  exists: boolean;
  selected: boolean;
  selectedCount: number;
  modelCount: number;
  onCheckedChange(checked: boolean): void;
}) {
  const { t } = useTranslation("settings");
  return (
    <label className="available-model-option">
      <input
        type="checkbox"
        aria-label={t("settingsView.selectNamedModel", { name: modelId })}
        disabled={
          exists ||
          (!selected &&
            selectedCount >= remainingProviderModelSlots(modelCount))
        }
        checked={exists || selected}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      <span>{modelId}</span>
      {exists ? <small>{t("settingsView.alreadyAdded")}</small> : null}
    </label>
  );
}

export function ProviderModelAddControl({
  modelCount,
  buttonId,
  onAdd,
}: {
  modelCount: number;
  buttonId: string;
  onAdd(): void;
}) {
  const { t } = useTranslation("settings");
  const atLimit = remainingProviderModelSlots(modelCount) === 0;
  return (
    <>
      <button
        className="quiet-button add-model-button"
        type="button"
        id={buttonId}
        disabled={atLimit}
        onClick={onAdd}
      >
        {t("settingsView.addModel")}
      </button>
      {atLimit ? (
        <p className="settings-note" role="status">
          {t("settingsView.modelLimitReached1024RemoveAModelTo")}
        </p>
      ) : null}
    </>
  );
}
