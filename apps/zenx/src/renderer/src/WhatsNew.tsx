import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "./ui/controls.js";
import { Icon } from "./icons.js";
import { RELEASE_NOTES } from "./release-notes.js";

export function WhatsNew() {
  const { t, i18n } = useTranslation("shell");
  const [open, setOpen] = useState(false);
  const language = i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en";
  return (
    <>
      <button
        className="icon-button whats-new-trigger"
        type="button"
        aria-label={t("whatsNew")}
        title={t("whatsNew")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Icon name="book" />
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t("whatsNew")}
        className="whats-new-dialog"
      >
        <header className="whats-new-header">
          <div>
            <h2>{t("whatsNew")}</h2>
            <p>{t("whatsNewLocal")}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t("whatsNewClose")}
            title={t("whatsNewClose")}
            onClick={() => setOpen(false)}
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="whats-new-list" tabIndex={0}>
          {RELEASE_NOTES.map((release) => (
            <section key={release.id} aria-labelledby={`release-${release.id}`}>
              <h3 id={`release-${release.id}`}>
                <time dateTime={release.date}>{release.date}</time>
              </h3>
              <ul>
                {release.items.map((item) => (
                  <li key={item.id}>{item[language]}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </Dialog>
    </>
  );
}
