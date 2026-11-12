import { useTranslation } from "react-i18next";
import { Dialog } from "./ui/controls.js";

/** Presentation only; App retains the pending reference and destination ownership. */
export function SideChatQuoteChooser({
  targets,
  onChoose,
  onClose,
}: {
  targets: readonly { id: string; title: string }[];
  onChoose(id?: string): void;
  onClose(): void;
}) {
  const { t } = useTranslation("shell");
  return (
    <Dialog
      open
      title={t("chooseSideChat")}
      restoreFocus={() => false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="side-chat-quote-chooser">
        <h2>{t("chooseSideChat")}</h2>
        {targets.map((target) => (
          <button
            className="secondary-button"
            type="button"
            key={target.id}
            onClick={() => onChoose(target.id)}
          >
            {target.title}
          </button>
        ))}
        <button
          className="secondary-button"
          type="button"
          onClick={() => onChoose()}
        >
          {t("newSideChat")}
        </button>
        <button className="quiet-button" type="button" onClick={onClose}>
          {t("cancel")}
        </button>
      </div>
    </Dialog>
  );
}
