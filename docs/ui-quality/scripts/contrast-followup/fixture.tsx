// Synthetic data ports, actual SettingsView and unchanged production styles.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  SettingsView,
  type SettingsTab,
} from "@repo/apps/zenx/src/renderer/src/SettingsView";
import { getAppearanceController } from "@repo/apps/zenx/src/renderer/src/appearance";
import { i18n } from "@repo/apps/zenx/src/renderer/src/i18n";
import "@repo/apps/zenx/src/renderer/src/theme.css";
import "@repo/apps/zenx/src/renderer/src/styles.css";

const query = new URLSearchParams(location.search);
const mode = query.get("mode") === "light" ? "light" : "dark";
const accent =
  query.get("accent") === "jade"
    ? "jade"
    : query.get("accent") === "iris"
      ? "iris"
      : "azure";
const preset =
  query.get("preset") === "ember"
    ? "ember"
    : query.get("preset") === "cobalt"
      ? "cobalt"
      : "graphite";
getAppearanceController().setPreference({
  mode,
  accent,
  lightPreset: preset,
  darkPreset: preset,
  contrast: query.get("contrast") === "high" ? "high" : "standard",
});
void i18n.changeLanguage(query.get("lang") === "zh-CN" ? "zh-CN" : "en");
const settings = {
  profile: {
    version: 3,
    onboardingComplete: true,
    revision: 1,
    providerProfiles: [
      {
        providerProfileId: "synthetic-account",
        type: "openai-subscription",
        displayName: "Synthetic subscription",
        models: [],
      },
    ],
    defaultModel: {
      providerProfileId: "synthetic-account",
      modelId: "synthetic-model",
    },
    titleModel: {
      providerProfileId: "synthetic-account",
      modelId: "synthetic-model",
    },
    workspace: "/synthetic/project",
    workspaces: ["/synthetic/project"],
    lastUsedWorkspace: "/synthetic/project",
    approvalPolicy: "never",
    pinnedThreadIds: [],
    visibleSubagentThreadIds: [],
    sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
  },
  hasApiKey: false,
  apiKeyProviderProfileIds: [],
  subscriptionProviderProfileId: "synthetic-account",
  subscription: {
    authenticated: true,
    expired: false,
    accountId: "synthetic-qa",
    email: "qa@example.test",
  },
};
const syntheticFailure = () =>
  Promise.reject(
    new Error("Synthetic local sign-out failure. No account request was sent."),
  );
Object.defineProperty(window, "zenx", {
  value: {
    settings: {
      get: async () => settings,
      onManualCodeRequested: () => () => {},
      logoutSubscription: syntheticFailure,
      loginSubscription: syntheticFailure,
      readSubscriptionUsage: async () => ({
        accountId: "synthetic-qa",
        fetchedAt: "2026-11-09T12:00:00.000Z",
        planType: "Synthetic",
        limits: [],
      }),
    },
  },
});
function Fixture() {
  const [tab, setTab] = useState<SettingsTab>(
    query.get("tab") === "account" ? "account" : "appearance",
  );
  return (
    <main className="workspace" style={{ height: "100vh" }}>
      <SettingsView
        active
        archivedError={null}
        archivedLoading={false}
        archivedThreads={[]}
        onRetryArchived={() => {}}
        onTabChange={setTab}
        onUnarchive={async () => {}}
        tab={tab}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
