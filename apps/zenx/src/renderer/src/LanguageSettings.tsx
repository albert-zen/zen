import { useId, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { getLanguageController } from "./language.js";
import { normalizeLanguagePreference } from "./language-preference.js";
import { Select } from "./ui/controls.js";

export function LanguageSettings() {
  const { t } = useTranslation("common");
  const language = getLanguageController();
  const preference = useSyncExternalStore(
    language.subscribe,
    language.getPreference,
  );
  const [saveFailed, setSaveFailed] = useState(false);
  const id = useId();
  return (
    <section
      className="page-card settings-card"
      aria-labelledby={`${id}-heading`}
    >
      <h3 id={`${id}-heading`}>{t("language")}</h3>
      <p id={`${id}-description`}>{t("languageDescription")}</p>
      <Select
        aria-label={t("language")}
        aria-describedby={`${id}-description`}
        value={preference}
        onValueChange={(value) =>
          setSaveFailed(
            !language.setPreference(normalizeLanguagePreference(value)),
          )
        }
      >
        <option value="system">{t("system")}</option>
        <option value="en" lang="en">
          English
        </option>
        <option value="zh-CN" lang="zh-CN">
          简体中文
        </option>
      </Select>
      {saveFailed ? <p role="alert">{t("languageSaveFailed")}</p> : null}
    </section>
  );
}
