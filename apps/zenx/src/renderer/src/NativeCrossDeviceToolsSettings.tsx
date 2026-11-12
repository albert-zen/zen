import { useId } from "react";
import { useTranslation } from "react-i18next";

export function NativeCrossDeviceToolsSettings({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  onChange(enabled: boolean): void;
}) {
  const { t } = useTranslation("settings");
  const helpId = useId();
  return (
    <section className="page-card settings-card">
      <div className="settings-row">
        <div>
          <h3>{t("nativeCrossDeviceTools.title")}</h3>
          <span>{t("nativeCrossDeviceTools.description")}</span>
        </div>
        <button
          className="plugin-switch"
          type="button"
          role="switch"
          aria-label={t("nativeCrossDeviceTools.title")}
          aria-describedby={helpId}
          aria-checked={enabled}
          disabled={disabled}
          onClick={() => onChange(!enabled)}
        />
      </div>
      <p id={helpId} className="settings-note">
        {t("nativeCrossDeviceTools.help")}
      </p>
    </section>
  );
}
