import React from "react";
import { useTranslation } from "react-i18next";

import type { PluginUiModule, PluginUiRegistry } from "./plugin-ui-host.js";

export const BROWSER_UI_ENTRY = "zenx/bundled/browser-ui";

export function registerBundledBrowserUi(
  registry: PluginUiRegistry,
): () => void {
  return registry.registerTrusted(BROWSER_UI_ENTRY, {
    "browser-page": BrowserPage,
  } satisfies PluginUiModule);
}

export function BrowserPage() {
  const { t } = useTranslation("panels");
  return (
    <p className="browser-page-redirect">{t("browserPageInstructions")}</p>
  );
}
