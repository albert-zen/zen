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
if (params.has("quota")) {
  previewSettings = {
    ...previewSettings,
    subscriptionProviderProfileId: "preview-subscription",
    subscription: {
      authenticated: params.get("quota") !== "signed-out",
      expired: false,
      accountId: "preview-account",
    },
  };
}
Object.defineProperty(window, "zenx", {
  value: {
    nativeBackdrop: params.get("backdrop") === "available",
    settings: {
      get: async () => previewSettings,
      readSubscriptionUsage: async () => {
        if (params.get("quota") === "loading")
          return await new Promise(() => {});
        if (params.get("quota") === "error")
          throw new Error("Preview quota unavailable");
        return {
          accountId: "preview-account",
          fetchedAt: Date.now(),
          planType: params.get("quota") === "pro" ? "pro" : "plus",
          limits: [
            {
              id: "codex",
              name: "Codex",
              primary:
                params.get("quota") === "pro"
                  ? null
                  : {
                      usedPercent:
                        params.get("quota") === "unknown" ? null : 25,
                      windowDurationSeconds: 18000,
                      resetsAt:
                        params.get("quota") === "unknown"
                          ? null
                          : Math.floor(Date.now() / 1000) + 7200,
                    },
              secondary: {
                usedPercent: 62,
                windowDurationSeconds: 604800,
                resetsAt: Math.floor(Date.now() / 1000) + 259200,
              },
            },
            {
              id: "other",
              name: "Other models",
              primary: null,
              secondary: null,
            },
          ],
        };
      },
      save: async (profile: object) => {
        if (params.get("save") === "error")
          throw new Error("Could not save settings. Please try again.");
        if (params.get("save") === "busy")
          return new Promise<PublicHostSettings>(() => {});
        const nextProfile = { ...previewSettings.profile, ...profile };
        const pendingRestart =
          nextProfile.experimentalRtkEnabled !==
          settings.profile.experimentalRtkEnabled
            ? ["experimentalRtk"]
            : [];
        previewSettings = {
          ...previewSettings,
          profile: nextProfile,
          configuration: {
            status: pendingRestart.length ? "pending-restart" : "applied",
            revision: 1,
            pendingRestart,
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
