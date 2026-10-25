/** Audit fixture: actual SettingsView, synthetic isolated services, no Host or persistence. */
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
import { getLanguageController } from "../src/renderer/src/language.js";
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
let settleProviderEdit: ((outcome: "success" | "failure") => void) | undefined;
const deferredProviderEdit: Window["zenx"]["settings"]["editProvider"] = async (
  _id,
  _provider,
  _options,
  attemptId,
) => {
  if (query.get("deferredSave") !== "1") return unavailable();
  calls.push("synthetic-deferred-edit");
  return new Promise<
    Awaited<ReturnType<Window["zenx"]["settings"]["editProvider"]>>
  >((resolve) => {
    settleProviderEdit = (outcome) => {
      settleProviderEdit = undefined;
      resolve(
        outcome === "failure"
          ? {
              ok: false,
              outcome: "failed",
              code: "save-rejected",
              attemptId: attemptId ?? "synthetic-save",
            }
          : {
              ok: true,
              settings: structuredClone(settings),
              outcome: "success",
              attemptId: attemptId ?? "synthetic-save",
            },
      );
    };
  });
};
let initialFailure = query.get("initialFailure") === "1";
const unavailable = async () => {
  throw new Error(
    "Audit fixture has no Host, credentials, or mutation access.",
  );
};
Object.assign(window, {
  zenx: {
    platform: "linux",
    settings: {
      get: async () => {
        calls.push("settings-get");
        if (initialFailure) {
          initialFailure = false;
          throw new Error(
            "Synthetic settings load failure. No Host request was made.",
          );
        }
        return structuredClone(settings);
      },
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
      editProvider: deferredProviderEdit,
      deleteProvider: unavailable,
      save: unavailable,
      probeProviderImage: unavailable,
    },
  },
  __settingsAudit: {
    calls,
    settleProviderEdit: (outcome: "success" | "failure" = "success") => {
      if (!settleProviderEdit) throw new Error("No synthetic edit pending");
      settleProviderEdit(outcome);
    },
  },
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
// Receive a fixture-only preference without writing storage. This initializes
// the same controller used by the mounted LanguageSettings component.
getLanguageController().receivePreference(language);
void i18n.changeLanguage(language).then(() => {
  createRoot(document.getElementById("root")!).render(<Preview />);
});
