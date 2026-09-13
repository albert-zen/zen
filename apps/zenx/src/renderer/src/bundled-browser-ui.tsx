import React from "react";

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
  return (
    <p className="browser-page-redirect">
      Open a thread and use its Browser panel to view that thread's pages.
    </p>
  );
}
