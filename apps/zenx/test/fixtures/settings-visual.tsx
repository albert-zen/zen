import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  PublicHostSettings,
  ZenXModelCatalogEntry,
} from "../../src/main/host-profile.js";
import {
  SettingsView,
  type SettingsTab,
} from "../../src/renderer/src/SettingsView.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
const settings: PublicHostSettings = {
  profile: {
    version: 3,
    onboardingComplete: true,
    providerProfiles: [
      {
        providerProfileId: "fake",
        type: "fake",
        displayName: "Local demo",
        models: [model("fake"), model("gpt-5.6-luna")],
      },
    ],
    defaultModel: { providerProfileId: "fake", modelId: "fake" },
    titleModel: { providerProfileId: "fake", modelId: "gpt-5.6-luna" },
    workspace: "/work/zen",
    workspaces: ["/work/zen"],
    lastUsedWorkspace: "/work/zen",
    approvalPolicy: "never",
    pinnedThreadIds: [],
    sidebarOrder: { projectKeys: [], threadIdsByProject: {} },
  },
  hasApiKey: false,
  apiKeyProviderProfileIds: [],
  subscriptionProviderProfileId: null,
  subscription: { authenticated: false, expired: false },
};

function model(id: string): ZenXModelCatalogEntry {
  return {
    id,
    displayName: id,
    description: "",
    hidden: false,
    supportedReasoningEfforts: ["medium"],
    defaultReasoningEffort: "medium",
    inputModalities: ["text" as const],
    contextWindow: 32_768,
    source: "legacy",
  };
}

const multiProviderSettings: PublicHostSettings = {
  ...settings,
  profile: {
    ...settings.profile,
    providerProfiles: [
      {
        providerProfileId: "profile-alpha",
        type: "openai-compatible",
        name: "alpha-api",
        displayName: "Alpha",
        baseUrl: "https://alpha.example.test/v1",
        models: [model("shared-model"), model("alpha-only")],
      },
      {
        providerProfileId: "profile-beta",
        type: "openai-compatible",
        name: "beta-api",
        displayName: "Beta",
        baseUrl: "https://beta.example.test/v1",
        models: [model("shared-model"), model("beta-only")],
      },
      {
        providerProfileId: "profile-local",
        type: "fake",
        displayName: "Local demo",
        models: [model("fake")],
      },
    ],
    defaultModel: {
      providerProfileId: "profile-alpha",
      modelId: "shared-model",
    },
    titleModel: {
      providerProfileId: "profile-beta",
      modelId: "shared-model",
    },
  },
  hasApiKey: true,
  apiKeyProviderProfileIds: ["profile-alpha", "profile-beta"],
};

const params = new URLSearchParams(location.search);
let previewSettings: PublicHostSettings = {
  ...multiProviderSettings,
  rtk:
    params.get("rtk") === "unavailable"
      ? { available: false, reason: "Available on Apple silicon Macs only." }
      : { available: true },
};
Object.defineProperty(window, "zenx", {
  value: {
    settings: {
      get: async () => previewSettings,
      save: async (profile: object) => {
        previewSettings = {
          ...previewSettings,
          profile: { ...previewSettings.profile, ...profile },
          configuration: {
            status: "pending-restart",
            revision: 1,
            pendingRestart: ["experimentalRtk"],
          },
        };
        return previewSettings;
      },
      safeRestart: async () => {
        previewSettings = {
          ...previewSettings,
          configuration: { status: "applied", revision: 1, pendingRestart: [] },
        };
        return previewSettings;
      },
      onManualCodeRequested: () => () => {},
    },
  },
});
document.documentElement.dataset.appearance = params.get("theme") ?? "light";
function Preview() {
  const [tab, setTab] = useState<SettingsTab>(
    (params.get("tab") ?? "models") as SettingsTab,
  );
  return (
    <SettingsView
      tab={tab}
      onTabChange={setTab}
      archivedError={null}
      archivedLoading={false}
      archivedThreads={[]}
      onRetryArchived={() => {}}
      onUnarchive={async () => {}}
    />
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
