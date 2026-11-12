import React from "react";
import { useTranslation } from "react-i18next";
import { classifyMessageLink } from "../../external-link-policy.js";
import { Icon } from "./icons.js";

/** Open only the selected Host-reported page, never an address-bar draft. */
export function BrowserExternalOpen({
  url,
  disabled = false,
  onOpen,
}: {
  url: string | undefined;
  disabled?: boolean;
  onOpen?(): void;
}) {
  const { t } = useTranslation("panels");
  const target = classifyMessageLink(url ?? "");
  const href = target.kind === "browser" ? target.value : undefined;
  return (
    <button
      type="button"
      className="icon-button browser-external-open"
      aria-label={t("openCurrentPageExternally")}
      title={t("openCurrentPageExternally")}
      disabled={disabled || href === undefined}
      onClick={() => {
        // The app window's existing window-open handler validates the URL
        // again and dispatches shell.openExternal without creating a child view.
        if (disabled || href === undefined) return;
        if (onOpen) onOpen();
        else window.open(href, "_blank", "noopener,noreferrer");
      }}
    >
      <Icon name="external-link" />
    </button>
  );
}
