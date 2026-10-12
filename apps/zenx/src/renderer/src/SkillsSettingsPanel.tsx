import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { Select } from "./ui/controls.js";
import type { SkillsSnapshot, SkillMode } from "../../../../cli/src/skills.js";
import { DirectoryPicker } from "./DirectoryPicker.js";

export function SkillsSettingsPanel() {
  const { t } = useTranslation("settings");
  const [snapshot, setSnapshot] = useState<SkillsSnapshot | null>(null);
  const [directory, setDirectory] = useState("");
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const refresh = async () => setSnapshot(await window.zenx.skills.list());
  useEffect(() => {
    let active = true;
    void window.zenx.skills
      .list()
      .then((value) => active && setSnapshot(value))
      .catch((reason: unknown) => active && setError(String(reason)));
    return () => {
      active = false;
    };
  }, []);
  const perform = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await action();
      await refresh();
      setStatus(message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <header>
        <h2>{t("skillsSettingsPanel.skills")}</h2>
        <p className="settings-note">
          {t(
            "skillsSettingsPanel.importInstructionsAndTheirResourcesManualSkillsStayOut",
          )}
        </p>
      </header>
      <section className="settings-card">
        <div className="settings-card-head">
          <div>
            <h3>{t("skillsSettingsPanel.importASkill")}</h3>
            <span>
              {t(
                "skillsSettingsPanel.chooseADirectoryContainingSkillMdZenKeepsA",
              )}
            </span>
          </div>
        </div>
        <label className="field settings-field">
          <span>{t("skillsSettingsPanel.skillDirectory")}</span>
          <input
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            placeholder={t("skillsSettingsPanel.absoluteDirectoryPath")}
          />
        </label>
        <div className="settings-actions">
          <button
            type="button"
            className="quiet-button"
            onClick={() => setPicker(true)}
            disabled={busy}
          >
            {t("skillsSettingsPanel.browse")}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || directory.trim().length === 0}
            onClick={() =>
              void perform(async () => {
                await window.zenx.skills.importDirectory(directory.trim());
                setDirectory("");
              }, t("skillsSettingsPanel.skillImportedCheckItsEffectiveModeBelow"))
            }
          >
            {busy
              ? t("skillsSettingsPanel.saving")
              : t("skillsSettingsPanel.importSkill")}
          </button>
        </div>
      </section>
      {error !== null && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {status !== null && <p role="status">{status}</p>}
      {snapshot === null ? (
        <p role="status">{t("skillsSettingsPanel.loadingSkills")}</p>
      ) : (
        <>
          <label className="field settings-field">
            <span>
              {t("skillsSettingsPanel.findImportedSkills", {
                count: snapshot.skills.length,
              })}
            </span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("skillsSettingsPanel.nameDescriptionOrSource")}
            />
          </label>
          <p>
            {t("skillsSettingsPanel.automaticModeHelp", {
              kib: snapshot.catalogBudgetBytes / 1024,
            })}
          </p>
          {snapshot.errors.map((message) => (
            <p key={message} className="settings-error" role="alert">
              {message}
            </p>
          ))}
          {snapshot.skills.length === 0 && (
            <section className="settings-card">
              <h3>{t("skillsSettingsPanel.noSkillsImported")}</h3>
              <p>
                {t(
                  "skillsSettingsPanel.yourModelReceivesNoSkillsMetadataImportADirectory",
                )}
              </p>
            </section>
          )}
          {snapshot.skills
            .filter((skill) =>
              `${skill.name} ${skill.description} ${skill.source}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((skill) => (
              <section className="settings-card" key={skill.id}>
                <div className="settings-card-head">
                  <div>
                    <h3>{skill.name}</h3>
                    <span>{skill.description}</span>
                  </div>
                </div>
                <label className="field settings-field">
                  <span>
                    {t("skillsSettingsPanel.effectiveMode")}{" "}
                    {skill.configurationSource === "user"
                      ? t("skillsSettingsPanel.yourOverride")
                      : skill.configurationSource === "package"
                        ? t("skillsSettingsPanel.packagePolicy")
                        : t("skillsSettingsPanel.default")}
                  </span>
                  <Select
                    aria-label={t("skillsSettingsPanel.modeForSkill", {
                      name: skill.name,
                      id: skill.id,
                    })}
                    disabled={busy}
                    value={skill.mode}
                    onValueChange={(value) =>
                      void perform(
                        () =>
                          window.zenx.skills.setMode(
                            skill.id,
                            value as SkillMode,
                          ),
                        t("skillsSettingsPanel.namedModeSaved", {
                          name: skill.name,
                        }),
                      )
                    }
                  >
                    <option value="manual">
                      {t("skillsSettingsPanel.manualUse")}
                    </option>
                    <option value="auto">
                      {t("skillsSettingsPanel.automaticallyVisible")}
                    </option>
                    <option value="disabled">
                      {t("skillsSettingsPanel.disabled")}
                    </option>
                  </Select>
                </label>
                <details>
                  <summary>
                    {t("skillsSettingsPanel.sourceAndConfiguration")}
                  </summary>
                  <p className="skills-source">
                    {t("skillsSettingsPanel.importedFrom")} {skill.source}
                  </p>
                  <p className="skills-source">
                    {t("skillsSettingsPanel.localCopy")} {skill.directory}
                  </p>
                  <p>
                    {t(
                      "skillsSettingsPanel.yourOverrideTakesPrecedenceOverAgentsZenYamlThen",
                    )}
                  </p>
                  <button
                    type="button"
                    className="quiet-button"
                    disabled={busy || skill.configurationSource !== "user"}
                    onClick={() =>
                      void perform(
                        () => window.zenx.skills.setMode(skill.id, null),
                        t("skillsSettingsPanel.userOverrideRemoved"),
                      )
                    }
                  >
                    {t("skillsSettingsPanel.usePackageDefault")}
                  </button>
                </details>
              </section>
            ))}
        </>
      )}
      {picker && (
        <DirectoryPicker
          onCancel={() => setPicker(false)}
          onSelect={(value) => {
            setDirectory(value);
            setPicker(false);
          }}
        />
      )}
    </>
  );
}
