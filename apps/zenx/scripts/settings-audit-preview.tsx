/** Audit fixture: actual SettingsView, synthetic read-only services, no Host. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  SettingsView,
  type SettingsTab,
} from "../src/renderer/src/SettingsView.js";
import type {
  PublicHostSettings,
  ZenXModelCatalogEntry,
} from "../src/main/host-profile.js";
import { i18n } from "../src/renderer/src/i18n.js";
import "../src/renderer/src/theme.css";
import "../src/renderer/src/styles.css";
const query = new URLSearchParams(location.search);
const language = query.get("lang") === "zh-CN" ? "zh-CN" : "en";
document.documentElement.lang = language;
document.documentElement.dataset.appearance =
  query.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.themePreset = "graphite";
document.documentElement.dataset.platform = "linux";
const model = (id: string, known = true): ZenXModelCatalogEntry => ({
  id,
  displayName: id,
  description: "Synthetic audit model",
  hidden: false,
  supportedReasoningEfforts: known ? ["low", "medium", "high"] : null,
  defaultReasoningEffort: known ? "medium" : null,
  inputModalities: known ? ["text", "image"] : null,
  contextWindow: known ? 32768 : null,
  source: known ? "manual" : "discovered",
});
const settings: PublicHostSettings = {
  profile: {
    version: 3,
    revision: 1,
    onboardingComplete: true,
    providerProfiles: Array.from({ length: 4 }, (_, index) => ({
      providerProfileId: `synthetic-${index}`,
      type: "openai-compatible" as const,
      name: `audit-${index}`,
      displayName: `Synthetic Provider ${index + 1}`,
      baseUrl: "https://provider.example.test/v1",
      models: Array.from({ length: index === 3 ? 12 : 2 }, (_, n) =>
        model(`audit-model-${n + 1}`),
      ),
    })),
    defaultModel: {
      providerProfileId: "synthetic-0",
      modelId: "audit-model-1",
    },
    titleModel: { providerProfileId: "synthetic-0", modelId: "audit-model-2" },
    workspace: "/synthetic/audit",
    workspaces: ["/synthetic/audit"],
    lastUsedWorkspace: "/synthetic/audit",
    approvalPolicy: "always",
    pinnedThreadIds: [],
    visibleSubagentThreadIds: [],
    sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
  },
  hasApiKey: true,
  apiKeyProviderProfileIds: [
    "synthetic-0",
    "synthetic-1",
    "synthetic-2",
    "synthetic-3",
  ],
  subscriptionProviderProfileId: null,
  subscription: { authenticated: false, expired: false },
};
const calls: string[] = [];
const unavailable = async () => {
  throw new Error(
    "Audit fixture has no Host, credentials, or mutation access.",
  );
};
Object.assign(window, {
  zenx: {
    platform: "linux",
    settings: {
      get: async () => structuredClone(settings),
      onManualCodeRequested: () => () => undefined,
      recordDiagnostic: async () => {
        calls.push("validation-diagnostic");
      },
      discoverProvider: async () => {
        calls.push("synthetic-discovery");
        return {
          models: [
            model("catalog-known", true),
            model("catalog-unknown", false),
          ],
          source: "remote",
        };
      },
      addProvider: unavailable,
      editProvider: unavailable,
      deleteProvider: unavailable,
      save: unavailable,
      probeProviderImage: unavailable,
    },
  },
  __settingsAudit: { calls },
});
function Preview() {
  const [tab, setTab] = useState<SettingsTab>("models");
  return (
    <SettingsView
      tab={tab}
      onTabChange={setTab}
      archivedError={null}
      archivedLoading={false}
      archivedThreads={[]}
      onRetryArchived={() => undefined}
      onUnarchive={unavailable}
    />
  );
}
void i18n.changeLanguage(language).then(() => {
  createRoot(document.getElementById("root")!).render(<Preview />);
});
