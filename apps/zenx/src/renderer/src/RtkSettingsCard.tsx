import { i18n } from "./i18n.js";
import { useTranslation } from "react-i18next";
import type {
  PublicHostSettings,
  ZenXHostProfile,
} from "../../main/host-profile.js";

export function RtkSettingsCard({
  draft,
  settings,
  busy,
  onChange,
}: {
  draft: ZenXHostProfile;
  settings: PublicHostSettings;
  busy: boolean;
  onChange(enabled: boolean): void;
}) {
  const { t } = useTranslation("settings");
  const enabled = draft.experimentalRtkEnabled === true;
  const saved = settings.profile.experimentalRtkEnabled === true;
  const available = settings.rtk?.available === true;
  const dirty = enabled !== saved;
  const pending =
    settings.configuration?.pendingRestart.includes("experimentalRtk") === true;
  const unconfirmed = settings.configuration?.status === "unconfirmed";
  const status = !available
    ? t("rtkSettingsCard.unavailable")
    : dirty
      ? t("rtkSettingsCard.unsavedChange")
      : unconfirmed
        ? t("rtkSettingsCard.applicationUnconfirmed")
        : pending
          ? t("rtkSettingsCard.restartRequired")
          : saved
            ? t("rtkSettingsCard.on")
            : t("rtkSettingsCard.off");
  return (
    <div
      className="page-card settings-card rtk-settings-card"
      aria-label={t("rtkSettingsCard.rtkExperiment")}
    >
      <div className="settings-row">
        <div>
          <h3>
            {t("rtkSettingsCard.compactShellOutput")}{" "}
            <span className="rtk-experiment-label">
              {t("rtkSettingsCard.experimentalRtk")}
            </span>
          </h3>
          <span>
            {t("rtkSettingsCard.reduceRepetitiveTestOutputSentToTheModelWhile")}
          </span>
        </div>
        <button
          className="plugin-switch"
          type="button"
          role="switch"
          aria-label={t("rtkSettingsCard.compactShellOutputWithRtk")}
          aria-describedby="rtk-scope rtk-state"
          aria-checked={enabled}
          disabled={busy || unconfirmed || (!available && !enabled)}
          onClick={() => onChange(!enabled)}
        />
      </div>
      <p id="rtk-scope" className="settings-note">
        {t("rtkSettingsCard.appleSiliconMacsCargoTestOnlyCommandsRunAs")}
      </p>
      <div
        id="rtk-state"
        className="rtk-settings-state"
        role="status"
        aria-live="polite"
      >
        <strong>{status}</strong>
        <span>
          {!available
            ? (settings.rtk?.reason ??
              t("rtkSettingsCard.rtkIsNotIncludedInThisBuild"))
            : dirty
              ? t("rtkSettingsCard.applyToSaveTheChangeTakesEffectNextLaunch")
              : unconfirmed
                ? t(
                    "rtkSettingsCard.checkApplicationStatusBelowBeforeMakingAnotherChange",
                  )
                : pending
                  ? t("rtkSettingsCard.savedStateRestart", {
                      state: saved
                        ? t("rtkSettingsCard.onLower")
                        : t("rtkSettingsCard.offLower"),
                    })
                  : t(
                      "rtkSettingsCard.offByDefaultChangesTakeEffectNextLaunchRunning",
                    )}
        </span>
      </div>
    </div>
  );
}
