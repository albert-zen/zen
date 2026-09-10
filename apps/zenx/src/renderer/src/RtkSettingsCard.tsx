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
  const enabled = draft.experimentalRtkEnabled === true;
  const saved = settings.profile.experimentalRtkEnabled === true;
  const available = settings.rtk?.available === true;
  const dirty = enabled !== saved;
  const pending =
    settings.configuration?.pendingRestart.includes("experimentalRtk") === true;
  const unconfirmed = settings.configuration?.status === "unconfirmed";
  const status = !available
    ? "Unavailable"
    : dirty
      ? "Unsaved change"
      : unconfirmed
        ? "Application unconfirmed"
        : pending
          ? "Restart required"
          : saved
            ? "On"
            : "Off";
  return (
    <div
      className="page-card settings-card rtk-settings-card"
      aria-label="RTK experiment"
    >
      <div className="settings-row">
        <div>
          <h3>
            Compact shell output{" "}
            <span className="rtk-experiment-label">Experimental · RTK</span>
          </h3>
          <span>
            Reduce repetitive test output sent to the model while keeping the
            original output available to read back.
          </span>
        </div>
        <button
          className="plugin-switch"
          type="button"
          role="switch"
          aria-label="Compact shell output with RTK"
          aria-describedby="rtk-scope rtk-state"
          aria-checked={enabled}
          disabled={busy || unconfirmed || (!available && !enabled)}
          onClick={() => onChange(!enabled)}
        />
      </div>
      <p id="rtk-scope" className="settings-note">
        Apple silicon Macs · cargo test only. Commands run as usual. Shell
        output inside run_code stays unchanged.
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
            ? (settings.rtk?.reason ?? "RTK is not included in this build.")
            : dirty
              ? "Apply to save. The change takes effect next launch."
              : unconfirmed
                ? "Check application status below before making another change."
                : pending
                  ? `Saved ${saved ? "on" : "off"}. Use Safe restart when tasks are idle, or relaunch ZenX later.`
                  : "Off by default. Changes take effect next launch; running tasks keep their current behavior."}
        </span>
      </div>
    </div>
  );
}
