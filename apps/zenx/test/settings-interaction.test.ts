/// <reference path="../src/renderer/src/env.d.ts" />

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import type { Root } from "react-dom/client";

import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import type {
  PublicHostSettings,
  ZenXHostProfile,
  ZenXModelCatalogEntry,
  ZenXProviderDeleteReplacements,
  ZenXProviderEditOptions,
  ZenXProviderProfile,
  ZenXSettingsUpdate,
} from "../src/main/host-profile.js";
import type { SettingsTab } from "../src/renderer/src/SettingsView.js";
import type { ZenXProviderCatalogSnapshot } from "../src/main/settings-service.js";
import type { ZenXImageCapabilityProbeResult } from "../src/main/settings-service.js";

const { act, createElement, useState } = React;
const bootstrapDom = new JSDOM(
  "<!doctype html><html><body><div id=root></div></body></html>",
  { url: "http://localhost" },
);
Object.assign(globalThis, {
  React,
  document: bootstrapDom.window.document,
  Event: bootstrapDom.window.Event,
  HTMLElement: bootstrapDom.window.HTMLElement,
  localStorage: bootstrapDom.window.localStorage,
  Node: bootstrapDom.window.Node,
  window: bootstrapDom.window,
});
const { createRoot } = await import("react-dom/client");
const { SettingsView } = await import("../src/renderer/src/SettingsView.js");

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

test("Settings saves global model routing by Provider profile identity", async () => {
  const saved: ZenXSettingsUpdate[] = [];
  const harness = await mountSettings("models", {
    initialSettings: multiProviderSettings,
    save: async (profile) => {
      saved.push(profile);
      return {
        ...multiProviderSettings,
        profile: { ...multiProviderSettings.profile, ...profile },
      };
    },
  });
  try {
    await waitFor(() => exactButton("Apply & restart"));
    assert.equal(document.querySelector(".page-header-actions"), null);
    assert.equal(exactButton("Done"), undefined);
    assert.equal(exactButton("Save and restart host"), undefined);

    const apply = exactButton("Apply & restart");
    assert.ok(apply);
    assert.equal(apply.disabled, true);
    const defaultModel = labeledSelect("Default model");
    assert.ok(defaultModel);
    const betaShared = Array.from(defaultModel.options).find(
      (option) => option.textContent?.trim() === "Beta · shared-model",
    );
    assert.ok(betaShared);
    await changeControl(defaultModel, betaShared.value);
    assert.equal(apply.disabled, false);
    await act(async () => {
      apply.click();
      await Promise.resolve();
    });
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0]?.defaultModel, {
      providerProfileId: "profile-beta",
      modelId: "shared-model",
    });
    assert.match(document.body.textContent ?? "", /local host restarted/u);
    assert.equal(apply.disabled, true);
  } finally {
    await unmount(harness);
  }
});

test("Models lists every profile and keeps duplicate model IDs distinguishable and keyboard reachable", async () => {
  const harness = await mountSettings("models", {
    initialSettings: multiProviderSettings,
  });
  try {
    await waitFor(() => exactButton("Add provider"));
    assert.match(document.body.textContent ?? "", /Alpha/u);
    assert.match(document.body.textContent ?? "", /Beta/u);
    assert.match(document.body.textContent ?? "", /Local demo/u);
    assert.match(document.body.textContent ?? "", /API key saved/u);
    assert.doesNotMatch(document.body.textContent ?? "", /Connected/u);

    const defaultModel = labeledSelect("Default model");
    assert.ok(defaultModel);
    const sharedOptions = Array.from(defaultModel.options).filter((option) =>
      option.textContent?.includes("shared-model"),
    );
    assert.deepEqual(
      sharedOptions.map((option) => option.textContent?.trim()),
      ["Alpha · shared-model", "Beta · shared-model"],
    );
    assert.notEqual(sharedOptions[0]?.value, sharedOptions[1]?.value);

    for (const control of [
      exactButton("Add provider"),
      exactButton("Add custom provider"),
      labeledButton("Edit Alpha"),
      labeledButton("Delete Alpha"),
    ]) {
      assert.ok(control);
      assert.equal(control.tabIndex, 0);
    }
  } finally {
    await unmount(harness);
  }
});

test("Provider discovery starts text-only and manual overrides persist", async () => {
  const discovered = {
    ...model("alpha-vision"),
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    inputModalities: ["text" as const],
    contextWindow: null,
    source: "discovered" as const,
  };
  let edited: ZenXProviderProfile | undefined;
  let editCalls = 0;
  const harness = await mountSettings("models", {
    initialSettings: multiProviderSettings,
    discoverProvider: async () => ({
      providerProfileId: "profile-alpha",
      models: [
        ...multiProviderSettings.profile.providerProfiles[0]!.models,
        discovered,
      ],
    }),
    editProvider: async (_id, provider) => {
      editCalls += 1;
      edited = provider;
      return {
        ...multiProviderSettings,
        profile: {
          ...multiProviderSettings.profile,
          providerProfiles: multiProviderSettings.profile.providerProfiles.map(
            (candidate) =>
              candidate.providerProfileId === provider.providerProfileId
                ? provider
                : candidate,
          ),
        },
      };
    },
  });
  try {
    await waitFor(() => labeledButton("Edit Alpha"));
    await click(labeledButtonRequired("Edit Alpha"));
    await click(exactButtonRequired("Get available models"));
    await waitFor(() => labelControl<HTMLInputElement>("Model 3", "input"));
    assert.equal(requiredInput("Model 3").value, "alpha-vision");
    assert.match(
      document.body.textContent ?? "",
      /text only · reasoning not configured · text · context required/u,
    );
    assert.equal(
      Array.from(labeledSelect("Default model")?.options ?? []).some(
        (option) => option.textContent?.trim() === "Alpha · alpha-vision",
      ),
      false,
    );
    assert.ok(labelControl("Model 3 context window (Required)", "input"));
    await click(exactButtonRequired("Save provider"));
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /model alpha-vision requires a positive context window/u,
    );
    assert.equal(editCalls, 0);

    const reasoningMode = labeledSelect("Model 3 reasoning metadata");
    const modalities = labeledSelect("Model 3 input modalities");
    assert.ok(reasoningMode);
    assert.ok(modalities);
    await changeControl(reasoningMode, "configured");
    await changeControl(
      requiredInput("Model 3 reasoning efforts"),
      "low, high",
    );
    await changeControl(
      requiredInput("Model 3 default reasoning effort"),
      "high",
    );
    await changeControl(modalities, "text-image");
    await changeControl(
      requiredInput("Model 3 context window (Required)"),
      "128000",
    );
    await click(exactButtonRequired("Save provider"));
    await waitFor(() => edited);
    const configured = edited?.models.find(
      (entry) => entry.id === "alpha-vision",
    );
    assert.deepEqual(configured, {
      ...discovered,
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
      inputModalities: ["text", "image"],
      contextWindow: 128000,
      source: "manual",
    });
    assert.ok(
      Array.from(labeledSelect("Default model")?.options ?? []).some(
        (option) => option.textContent?.trim() === "Alpha · alpha-vision",
      ),
    );
  } finally {
    await unmount(harness);
  }
});

test("a saved Unknown model offers a user-triggered image probe and shows its persisted outcome", async () => {
  const unknownModel = {
    ...multiProviderSettings.profile.providerProfiles[0]!.models[0]!,
    inputModalities: null,
  };
  const initialSettings = {
    ...multiProviderSettings,
    profile: {
      ...multiProviderSettings.profile,
      providerProfiles: multiProviderSettings.profile.providerProfiles.map(
        (provider, index) =>
          index === 0 ? { ...provider, models: [unknownModel] } : provider,
      ),
    },
  };
  let probed: [string, string] | undefined;
  const harness = await mountSettings("models", {
    initialSettings,
    probeProviderImage: async (providerProfileId, modelId) => {
      probed = [providerProfileId, modelId];
      return {
        outcome: "supported",
        model: {
          ...unknownModel,
          inputModalities: ["text", "image"],
          source: "probe",
        },
      };
    },
  });
  try {
    await waitFor(() => labeledButton("Edit Alpha"));
    await click(labeledButtonRequired("Edit Alpha"));
    await click(exactButtonRequired("Test image support"));
    await waitFor(() => probed);
    assert.deepEqual(probed, ["profile-alpha", "shared-model"]);
    assert.match(document.body.textContent ?? "", /support was saved/u);
    assert.match(document.body.textContent ?? "", /text \+ image/u);
  } finally {
    await unmount(harness);
  }
});

test("Add custom provider submits an opaque identity, credential, and repeatable model rows", async () => {
  let added:
    { provider: ZenXProviderProfile; apiKey: string | undefined } | undefined;
  const harness = await mountSettings("models", {
    initialSettings: settings,
    addProvider: async (provider, apiKey) => {
      added = { provider, apiKey };
      return {
        ...settings,
        profile: {
          ...settings.profile,
          providerProfiles: [...settings.profile.providerProfiles, provider],
        },
        apiKeyProviderProfileIds: [provider.providerProfileId],
      };
    },
  });
  try {
    const addCustom = await waitFor(() => exactButton("Add custom provider"));
    await click(addCustom);
    await changeControl(requiredInput("Display name"), "Acme AI");
    await changeControl(requiredInput("Provider name"), "acme");
    await changeControl(
      requiredInput("Base URL"),
      "https://models.acme.example/v1",
    );
    await changeControl(requiredInput("API key"), "secret-replacement");
    await changeControl(requiredInput("Model 1"), "shared-model");
    await changeControl(
      requiredInput("Model 1 context window (Required)"),
      "32768",
    );
    await click(exactButtonRequired("Add model"));
    await changeControl(requiredInput("Model 2"), "acme-large");
    await changeControl(
      requiredInput("Model 2 context window (Required)"),
      "65536",
    );
    await click(exactButtonRequired("Add provider"));
    await waitFor(() => added);

    assert.equal(added?.apiKey, "secret-replacement");
    assert.equal(added?.provider.type, "openai-compatible");
    assert.equal(added?.provider.displayName, "Acme AI");
    assert.deepEqual(
      added?.provider.models.map((entry) => entry.id),
      ["shared-model", "acme-large"],
    );
    assert.ok(
      added?.provider.models.every(
        (entry) =>
          entry.source === "manual" &&
          entry.supportedReasoningEfforts?.length === 0 &&
          entry.inputModalities?.length === 1 &&
          entry.inputModalities[0] === "text" &&
          entry.contextWindow !== null,
      ),
    );
    assert.notEqual(added?.provider.providerProfileId, "Acme AI");
    assert.notEqual(added?.provider.providerProfileId, "acme");
    assert.match(added?.provider.providerProfileId ?? "", /^[0-9a-f-]{20,}$/u);
    assert.doesNotMatch(document.body.textContent ?? "", /secret-replacement/u);
  } finally {
    await unmount(harness);
  }
});

test("Add reconciles an applied provider when host restart rejects", async () => {
  let authoritative = settings;
  let calls = 0;
  const harness = await mountSettings("models", {
    initialSettings: settings,
    get: async () => authoritative,
    addProvider: async (provider) => {
      calls += 1;
      authoritative = {
        ...settings,
        profile: {
          ...settings.profile,
          providerProfiles: [...settings.profile.providerProfiles, provider],
        },
      };
      throw new Error("host restart failed after add");
    },
  });
  try {
    await waitFor(() => exactButton("Add custom provider"));
    await click(exactButtonRequired("Add custom provider"));
    await changeControl(requiredInput("Display name"), "Committed AI");
    await changeControl(requiredInput("Provider name"), "committed");
    await changeControl(
      requiredInput("Base URL"),
      "https://committed.example/v1",
    );
    await changeControl(requiredInput("API key"), "committed-key");
    await changeControl(requiredInput("Model 1"), "committed-model");
    await changeControl(
      requiredInput("Model 1 context window (Required)"),
      "32768",
    );
    await click(exactButtonRequired("Add provider"));
    await waitFor(
      () =>
        calls === 1 && /Committed AI/u.test(document.body.textContent ?? ""),
    );
    assert.equal(
      document.querySelector('[aria-label="Add Provider profile"]'),
      null,
    );
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /host restart failed after add/u,
    );
    assert.doesNotMatch(
      document.body.textContent ?? "",
      /Provider added · local host restarted/u,
    );
  } finally {
    await unmount(harness);
  }
});

test("Add provider offers known local and subscription flows without creating account lifecycle", async () => {
  let added: ZenXProviderProfile | undefined;
  const harness = await mountSettings("models", {
    initialSettings: settings,
    addProvider: async (provider) => {
      added = provider;
      return {
        ...settings,
        profile: {
          ...settings.profile,
          providerProfiles: [...settings.profile.providerProfiles, provider],
        },
      };
    },
  });
  try {
    await waitFor(() => exactButton("Add provider"));
    await click(exactButtonRequired("Add provider"));
    assert.ok(labeledButton("Add OpenAI subscription"));
    assert.ok(labeledButton("Add Local demo"));
    for (const name of [
      "SiliconFlow（硅基流动）",
      "DashScope",
      "DeepSeek",
      "Kimi",
      "Zhipu（智谱）",
    ]) {
      assert.ok(labeledButton(`Add ${name}`));
    }
    for (const kind of [
      "siliconflow",
      "dashscope",
      "deepseek",
      "moonshot",
      "zhipu",
    ]) {
      assert.ok(
        document.querySelector(
          `.provider-add-choices .provider-logo.${kind} img`,
        ),
        `known Provider choice should render the ${kind} brand asset`,
      );
    }
    assert.equal(
      document.querySelectorAll(".provider-add-choices .provider-logo.generic")
        .length,
      0,
    );
    await click(labeledButtonRequired("Add Local demo"));
    await click(exactButtonRequired("Add provider"));
    await waitFor(() => added);
    assert.equal(added?.type, "fake");
    assert.deepEqual(
      added?.models.map((entry) => entry.id),
      ["fake"],
    );
    assert.notEqual(added?.providerProfileId, "fake");
  } finally {
    await unmount(harness);
  }
});

test("known Provider choice pre-fills its stable profile identity and connection", async () => {
  let added:
    { provider: ZenXProviderProfile; apiKey: string | undefined } | undefined;
  const harness = await mountSettings("models", {
    initialSettings: settings,
    addProvider: async (provider, apiKey) => {
      added = { provider, apiKey };
      return {
        ...settings,
        profile: {
          ...settings.profile,
          providerProfiles: [...settings.profile.providerProfiles, provider],
        },
      };
    },
  });
  try {
    await waitFor(() => exactButton("Add provider"));
    await click(exactButtonRequired("Add provider"));
    await click(labeledButtonRequired("Add DeepSeek"));
    assert.equal(requiredInput("Display name").value, "DeepSeek");
    assert.equal(requiredInput("Provider name").value, "deepseek");
    assert.equal(requiredInput("Base URL").value, "https://api.deepseek.com");
    await changeControl(requiredInput("API key"), "deepseek-key");
    await changeControl(requiredInput("Model 1"), "deepseek-chat");
    await changeControl(
      requiredInput("Model 1 context window (Required)"),
      "65536",
    );
    await click(exactButtonRequired("Add provider"));
    await waitFor(() => added);
    assert.equal(added?.provider.providerProfileId, "deepseek");
    assert.equal(added?.apiKey, "deepseek-key");
  } finally {
    await unmount(harness);
  }
});

test("OpenAI subscription choice exposes the five host-confirmed models", async () => {
  let added: ZenXProviderProfile | undefined;
  const harness = await mountSettings("models", {
    initialSettings: settings,
    addProvider: async (provider) => {
      added = provider;
      return {
        ...settings,
        profile: {
          ...settings.profile,
          providerProfiles: [...settings.profile.providerProfiles, provider],
        },
      };
    },
  });
  try {
    await waitFor(() => exactButton("Add provider"));
    await click(exactButtonRequired("Add provider"));
    await click(labeledButtonRequired("Add OpenAI subscription"));
    for (const [index, id] of [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
    ].entries()) {
      assert.equal(requiredInput(`Model ${index + 1}`).value, id);
    }
    await click(exactButtonRequired("Add provider"));
    await waitFor(() => added);
    assert.deepEqual(
      added?.models.map((entry) => entry.id),
      ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
    );
    assert.deepEqual(
      added?.models.map((entry) => entry.inputModalities),
      Array.from({ length: 5 }, () => ["text", "image"]),
    );
    assert.deepEqual(added?.models[1]?.supportedReasoningEfforts, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  } finally {
    await unmount(harness);
  }
});

test("Edit keeps a blank saved credential and replaces only the edited profile key", async () => {
  const edits: Array<{
    id: string;
    provider: ZenXProviderProfile;
    options: ZenXProviderEditOptions | undefined;
  }> = [];
  let current = multiProviderSettings;
  const harness = await mountSettings("models", {
    initialSettings: current,
    editProvider: async (id, provider, options) => {
      edits.push({ id, provider, options });
      current = {
        ...current,
        profile: {
          ...current.profile,
          providerProfiles: current.profile.providerProfiles.map((candidate) =>
            candidate.providerProfileId === id ? provider : candidate,
          ),
        },
      };
      return current;
    },
  });
  try {
    await waitFor(() => labeledButton("Edit Alpha"));
    await click(labeledButtonRequired("Edit Alpha"));
    const key = requiredInput("API key");
    assert.equal(key.value, "");
    assert.match(key.placeholder, /leave blank to keep/u);
    await changeControl(requiredInput("Display name"), "Alpha edited");
    await click(exactButtonRequired("Save provider"));
    await waitFor(() => edits.length === 1);
    assert.equal(edits[0]?.id, "profile-alpha");
    assert.equal(edits[0]?.options?.apiKey, undefined);
    assert.equal(
      current.profile.providerProfiles.find(
        (provider) => provider.providerProfileId === "profile-beta",
      )?.displayName,
      "Beta",
    );

    await click(labeledButtonRequired("Edit Alpha edited"));
    await changeControl(requiredInput("API key"), "replacement-key");
    await click(exactButtonRequired("Save provider"));
    await waitFor(() => edits.length === 2);
    assert.equal(edits[1]?.options?.apiKey, "replacement-key");
    assert.doesNotMatch(document.body.textContent ?? "", /replacement-key/u);
  } finally {
    await unmount(harness);
  }
});

test("Edit reconciles an applied provider when host restart rejects", async () => {
  let authoritative = multiProviderSettings;
  let calls = 0;
  const harness = await mountSettings("models", {
    initialSettings: multiProviderSettings,
    get: async () => authoritative,
    editProvider: async (id, provider) => {
      calls += 1;
      authoritative = {
        ...multiProviderSettings,
        profile: {
          ...multiProviderSettings.profile,
          providerProfiles: multiProviderSettings.profile.providerProfiles.map(
            (candidate) =>
              candidate.providerProfileId === id ? provider : candidate,
          ),
        },
      };
      throw new Error("host restart failed after edit");
    },
  });
  try {
    await waitFor(() => labeledButton("Edit Alpha"));
    await click(labeledButtonRequired("Edit Alpha"));
    await changeControl(requiredInput("Display name"), "Alpha committed");
    await click(exactButtonRequired("Save provider"));
    await waitFor(
      () =>
        calls === 1 && /Alpha committed/u.test(document.body.textContent ?? ""),
    );
    assert.equal(document.querySelector('[aria-label="Edit Alpha"]'), null);
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /host restart failed after edit/u,
    );
  } finally {
    await unmount(harness);
  }
});

test("Delete submits required default and title replacements atomically without Thread scanning", async () => {
  const bothReferenced: PublicHostSettings = {
    ...multiProviderSettings,
    profile: {
      ...multiProviderSettings.profile,
      titleModel: multiProviderSettings.profile.defaultModel,
    },
  };
  let deletion:
    | { id: string; replacements: ZenXProviderDeleteReplacements | undefined }
    | undefined;
  const harness = await mountSettings("models", {
    initialSettings: bothReferenced,
    deleteProvider: async (id, replacements) => {
      deletion = { id, replacements };
      return {
        ...bothReferenced,
        profile: {
          ...bothReferenced.profile,
          providerProfiles: bothReferenced.profile.providerProfiles.filter(
            (provider) => provider.providerProfileId !== id,
          ),
          defaultModel:
            replacements?.defaultModel ?? bothReferenced.profile.defaultModel,
          titleModel:
            replacements?.titleModel ?? bothReferenced.profile.titleModel,
        },
      };
    },
  });
  try {
    await waitFor(() => labeledButton("Delete Alpha"));
    await click(labeledButtonRequired("Delete Alpha"));
    const defaultReplacement = labeledSelect("Replacement default model");
    const titleReplacement = labeledSelect("Replacement title model");
    assert.ok(defaultReplacement);
    assert.ok(titleReplacement);
    const beta = Array.from(defaultReplacement.options).find(
      (option) => option.textContent?.trim() === "Beta · shared-model",
    );
    assert.ok(beta);
    await changeControl(defaultReplacement, beta.value);
    await changeControl(titleReplacement, beta.value);
    await click(exactButtonRequired("Delete provider"));
    await waitFor(() => deletion);
    assert.deepEqual(deletion, {
      id: "profile-alpha",
      replacements: {
        defaultModel: {
          providerProfileId: "profile-beta",
          modelId: "shared-model",
        },
        titleModel: {
          providerProfileId: "profile-beta",
          modelId: "shared-model",
        },
      },
    });
    assert.doesNotMatch(document.body.textContent ?? "", /scan|rewrite/u);
  } finally {
    await unmount(harness);
  }
});

test("Delete removes an unreferenced Provider without replacement selections", async () => {
  let deletion:
    | { id: string; replacements: ZenXProviderDeleteReplacements | undefined }
    | undefined;
  const harness = await mountSettings("models", {
    initialSettings: multiProviderSettings,
    deleteProvider: async (id, replacements) => {
      deletion = { id, replacements };
      return {
        ...multiProviderSettings,
        profile: {
          ...multiProviderSettings.profile,
          providerProfiles:
            multiProviderSettings.profile.providerProfiles.filter(
              (provider) => provider.providerProfileId !== id,
            ),
        },
      };
    },
  });
  try {
    await waitFor(() => labeledButton("Delete Local demo"));
    await click(labeledButtonRequired("Delete Local demo"));
    assert.equal(labeledSelect("Replacement default model"), undefined);
    assert.equal(labeledSelect("Replacement title model"), undefined);
    await click(exactButtonRequired("Delete provider"));
    await waitFor(() => deletion);
    assert.deepEqual(deletion, {
      id: "profile-local",
      replacements: undefined,
    });
  } finally {
    await unmount(harness);
  }
});

test("Delete reports a generic finalization failure after its mutation committed", async () => {
  let authoritative = multiProviderSettings;
  let calls = 0;
  const harness = await mountSettings("models", {
    initialSettings: multiProviderSettings,
    get: async () => authoritative,
    deleteProvider: async (id) => {
      calls += 1;
      authoritative = {
        ...multiProviderSettings,
        profile: {
          ...multiProviderSettings.profile,
          providerProfiles:
            multiProviderSettings.profile.providerProfiles.filter(
              (candidate) => candidate.providerProfileId !== id,
            ),
        },
      };
      throw new Error("subscription credential cleanup failed after delete");
    },
  });
  try {
    await waitFor(() => labeledButton("Delete Local demo"));
    await click(labeledButtonRequired("Delete Local demo"));
    await click(exactButtonRequired("Delete provider"));
    await waitFor(
      () => calls === 1 && !/Local demo/u.test(document.body.textContent ?? ""),
    );
    assert.equal(
      document.querySelector('[aria-label="Delete Local demo"]'),
      null,
    );
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /subscription credential cleanup failed after delete/u,
    );
    assert.match(
      document.body.textContent ?? "",
      /saved, but finalization failed/u,
    );
    assert.doesNotMatch(
      document.body.textContent ?? "",
      /local host restart failed/u,
    );
    assert.doesNotMatch(document.body.textContent ?? "", /not configured/u);
  } finally {
    await unmount(harness);
  }
});

test("Validation and mutation failures keep the provider editor recoverable", async () => {
  let attempts = 0;
  const harness = await mountSettings("models", {
    initialSettings: settings,
    addProvider: async (provider) => {
      attempts += 1;
      if (attempts === 1) throw new Error("Host restart failed");
      return {
        ...settings,
        profile: {
          ...settings.profile,
          providerProfiles: [...settings.profile.providerProfiles, provider],
        },
      };
    },
  });
  try {
    await waitFor(() => exactButton("Add custom provider"));
    await click(exactButtonRequired("Add custom provider"));
    await click(exactButtonRequired("Add provider"));
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /Display name is required/u,
    );
    assert.equal(attempts, 0);

    await changeControl(requiredInput("Display name"), "Recoverable");
    await changeControl(requiredInput("Provider name"), "recoverable");
    await changeControl(
      requiredInput("Base URL"),
      "https://recover.example/v1",
    );
    await changeControl(requiredInput("API key"), "new-key");
    await changeControl(requiredInput("Model 1"), "recover-model");
    await changeControl(
      requiredInput("Model 1 context window (Required)"),
      "32768",
    );
    await click(exactButtonRequired("Add provider"));
    await waitFor(() =>
      document
        .querySelector('[role="alert"]')
        ?.textContent?.includes("Host restart failed"),
    );
    assert.equal(attempts, 1);
    assert.equal(requiredInput("Display name").value, "Recoverable");
    await click(exactButtonRequired("Add provider"));
    await waitFor(() => attempts === 2);
    assert.match(document.body.textContent ?? "", /Provider added/u);
  } finally {
    await unmount(harness);
  }
});

test("Archived threads is a Settings section with keyboard-reachable Unarchive", async () => {
  let restored: string | null = null;
  const harness = await mountSettings("account", {
    archivedThreads: [archivedSummary()],
    onUnarchive: async (thread) => {
      restored = thread.threadId;
    },
  });
  try {
    const archivedTab = await waitFor(() => exactButton("Archived threads"));
    archivedTab.focus();
    await act(async () => archivedTab.click());
    assert.match(document.body.textContent ?? "", /Archived conversation/u);
    assert.ok(document.querySelector(".provider-logo.deepseek img"));
    const unarchive = exactButton("Unarchive");
    assert.ok(unarchive);
    assert.equal(unarchive.disabled, false);
    await act(async () => {
      unarchive.click();
      await Promise.resolve();
    });
    assert.equal(restored, "archived-thread");
  } finally {
    await unmount(harness);
  }
});

test("Appearance is an independent Settings section and persists the complete profile without restarting the host", async () => {
  const saved: ZenXSettingsUpdate[] = [];
  const harness = await mountSettings("appearance", {
    save: async (profile) => {
      saved.push(profile);
      return { ...settings, profile: { ...settings.profile, ...profile } };
    },
  });
  try {
    await waitFor(() => appearanceModeRadio("light"));
    const system = appearanceModeRadio("system");
    const light = appearanceModeRadio("light");
    const dark = appearanceModeRadio("dark");
    assert.ok(system);
    assert.ok(light);
    assert.ok(dark);
    assert.equal(system.type, "radio");
    assert.equal(light.type, "radio");
    assert.equal(dark.type, "radio");
    assert.equal(system.name, "appearance-mode");
    assert.equal(light.name, system.name);
    assert.equal(dark.name, system.name);
    assert.ok(exactButton("Appearance"));
    assert.match(document.body.textContent ?? "", /Soft violet/u);
    assert.match(document.body.textContent ?? "", /Fresh green/u);
    assert.equal(
      document.querySelectorAll(".appearance-accent-options label").length,
      3,
    );
    await act(async () => light.click());
    assert.equal(document.documentElement.dataset.appearance, "light");
    assert.deepEqual(
      JSON.parse(localStorage.getItem("zenx.appearance") ?? ""),
      {
        mode: "light",
        lightPreset: "graphite",
        darkPreset: "graphite",
        accent: "azure",
        contrast: "standard",
        translucentSidebar: false,
      },
    );
    assert.equal(light.checked, true);
    assert.equal(system.checked, false);
    assert.equal(dark.checked, false);
    assert.equal(saved.length, 0);
    assert.equal(exactButton("Apply & restart"), undefined);

    const cobaltLight = appearanceChoice("light-preset", "cobalt");
    const emberDark = appearanceChoice("dark-preset", "ember");
    const jade = appearanceChoice("appearance-accent", "jade");
    const highContrast = appearanceChoice("appearance-contrast", "high");
    const translucent = appearanceChoice("sidebar-translucency", "on");
    assert.ok(cobaltLight);
    assert.ok(emberDark);
    assert.ok(jade);
    assert.ok(highContrast);
    assert.ok(translucent);
    assert.equal(translucent.getAttribute("role"), "switch");
    await act(async () => cobaltLight.click());
    await act(async () => emberDark.click());
    await act(async () => jade.click());
    await act(async () => highContrast.click());
    await act(async () => translucent.click());
    assert.equal(document.documentElement.dataset.themePreset, "cobalt");
    assert.equal(document.documentElement.dataset.accent, "jade");
    assert.equal(document.documentElement.dataset.contrast, "high");
    assert.equal(document.documentElement.dataset.sidebarTranslucency, "on");
    const preview = document.querySelector(
      '[aria-label="Live appearance preview"]',
    );
    assert.ok(preview);
    assert.match(preview.textContent ?? "", /Accent/u);
    assert.doesNotMatch(preview.textContent ?? "", /Action/u);
    assert.deepEqual(
      JSON.parse(localStorage.getItem("zenx.appearance") ?? ""),
      {
        mode: "light",
        lightPreset: "cobalt",
        darkPreset: "ember",
        accent: "jade",
        contrast: "high",
        translucentSidebar: true,
      },
    );

    const reset = exactButtonRequired("Reset appearance");
    assert.equal(reset.disabled, false);
    await act(async () => reset.click());
    assert.equal(document.documentElement.dataset.appearance, "light");
    assert.equal(document.documentElement.dataset.themePreset, "graphite");
    assert.equal(document.documentElement.dataset.accent, "azure");
    assert.equal(document.documentElement.dataset.contrast, "standard");
    assert.equal(document.documentElement.dataset.sidebarTranslucency, "off");
    assert.equal(appearanceModeRadio("system")?.checked, true);
  } finally {
    await unmount(harness);
  }
});

test("every Settings tab remains keyboard reachable after narrow-screen reflow", async () => {
  const harness = await mountSettings("appearance");
  try {
    await waitFor(() => exactButton("Appearance"));
    const tabs = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '.settings-nav [role="tab"]',
      ),
    );
    assert.deepEqual(
      tabs.map((tab) => tab.textContent?.trim()),
      [
        "Account",
        "Models & provider",
        "Plugins",
        "Appearance",
        "General",
        "Archived threads",
      ],
    );

    tabs[0]?.focus();
    await act(async () => {
      tabs[0]?.dispatchEvent(
        new harness.dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "End",
        }),
      );
      await Promise.resolve();
    });
    assert.equal(
      document.activeElement?.textContent?.trim(),
      "Archived threads",
    );
    assert.equal(tabs[5]?.getAttribute("aria-selected"), "true");

    await act(async () => {
      tabs[5]?.dispatchEvent(
        new harness.dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Home",
        }),
      );
      await Promise.resolve();
    });
    assert.equal(document.activeElement?.textContent?.trim(), "Account");
    assert.equal(tabs[0]?.getAttribute("aria-selected"), "true");
  } finally {
    await unmount(harness);
  }
});

test("General exposes an optional maximum tool round setting", async () => {
  const saved: ZenXSettingsUpdate[] = [];
  const harness = await mountSettings("general", {
    save: async (profile) => {
      saved.push(profile);
      return { ...settings, profile: { ...settings.profile, ...profile } };
    },
  });
  try {
    const maximum = await waitFor(() => requiredInput("Maximum tool rounds"));
    assert.equal(maximum.type, "number");
    assert.equal(maximum.value, "");
    assert.equal(maximum.min, "1");
    assert.equal(maximum.step, "1");
    assert.match(
      document.getElementById("max-tool-rounds-help")?.textContent ?? "",
      /blank for unlimited/u,
    );

    await changeControl(maximum, "0");
    await act(async () => {
      maximum.dispatchEvent(new window.Event("focusout", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(maximum.getAttribute("aria-invalid"), "true");
    assert.match(
      document.getElementById("max-tool-rounds-error")?.textContent ?? "",
      /whole number of 1 or more/u,
    );
    assert.equal(exactButtonRequired("Apply & restart").disabled, true);

    await changeControl(maximum, "12");
    assert.equal(maximum.hasAttribute("aria-invalid"), false);
    const apply = exactButtonRequired("Apply & restart");
    assert.equal(apply.disabled, false);
    await click(apply);

    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.maxToolRounds, 12);
  } finally {
    await unmount(harness);
  }
});

test("General exposes and saves the Host-owned tool presentation mode", async () => {
  const saved: ZenXSettingsUpdate[] = [];
  const harness = await mountSettings("general", {
    save: async (profile) => {
      saved.push(profile);
      return { ...settings, profile: { ...settings.profile, ...profile } };
    },
  });
  try {
    const presentation = await waitFor(() =>
      labeledSelect("Tool presentation"),
    );
    assert.equal(presentation.value, "both");
    assert.deepEqual(
      Array.from(presentation.options).map((option) => [
        option.value,
        option.textContent?.trim(),
      ]),
      [
        ["both", "Direct and code (recommended)"],
        ["direct", "Direct tools only"],
        ["code", "Code only"],
      ],
    );
    assert.match(
      document.getElementById("tool-presentation-help")?.textContent ?? "",
      /Direct is the rollback path and does not delete providers or rewrite existing Threads/u,
    );

    await changeControl(presentation, "direct");
    await click(exactButtonRequired("Apply & restart"));
    assert.equal(saved[0]?.toolPresentation, "direct");
  } finally {
    await unmount(harness);
  }
});

test("General requires an explicit risk-labeled opt-in for foreground computer takeover", async () => {
  const saved: ZenXSettingsUpdate[] = [];
  const harness = await mountSettings("general", {
    save: async (profile) => {
      saved.push(profile);
      return { ...settings, profile: { ...settings.profile, ...profile } };
    },
  });
  try {
    const control = await waitFor(() =>
      document.querySelector<HTMLButtonElement>(
        '[role="switch"][aria-label="Allow foreground computer control"]',
      ),
    );
    assert.equal(control.getAttribute("aria-checked"), "false");
    assert.match(
      document.body.textContent ?? "",
      /move the pointer, type keys, change focus, or scroll the app you are currently using/u,
    );
    assert.match(
      document.body.textContent ?? "",
      /Browser automation and background-safe Computer tools do not need this permission/u,
    );

    await click(control);
    assert.equal(control.getAttribute("aria-checked"), "true");
    await click(exactButtonRequired("Apply & restart"));
    assert.equal(saved[0]?.computerForegroundControlEnabled, true);

    await click(control);
    await click(exactButtonRequired("Apply & restart"));
    assert.equal(saved[1]?.computerForegroundControlEnabled, false);
  } finally {
    await unmount(harness);
  }
});

interface Harness {
  dom: JSDOM;
  root: Root;
  previous: Record<string, unknown>;
}

async function mountSettings(
  initialTab: SettingsTab,
  options: {
    initialSettings?: PublicHostSettings;
    get?(): Promise<PublicHostSettings>;
    save?(
      profile: ZenXSettingsUpdate,
      apiKey?: string,
    ): Promise<PublicHostSettings>;
    addProvider?(
      provider: ZenXProviderProfile,
      apiKey?: string,
    ): Promise<PublicHostSettings>;
    editProvider?(
      providerProfileId: string,
      provider: ZenXProviderProfile,
      options?: ZenXProviderEditOptions,
    ): Promise<PublicHostSettings>;
    deleteProvider?(
      providerProfileId: string,
      replacements?: ZenXProviderDeleteReplacements,
    ): Promise<PublicHostSettings>;
    discoverProvider?(
      providerProfileId: string,
    ): Promise<ZenXProviderCatalogSnapshot>;
    probeProviderImage?(
      providerProfileId: string,
      modelId: string,
    ): Promise<ZenXImageCapabilityProbeResult>;
    archivedThreads?: NativeThreadSummary[];
    onUnarchive?(thread: NativeThreadSummary): Promise<void>;
  } = {},
): Promise<Harness> {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    { url: "http://localhost" },
  );
  const previous = {
    document: globalThis.document,
    Event: globalThis.Event,
    HTMLElement: globalThis.HTMLElement,
    localStorage: globalThis.localStorage,
    matchMedia: globalThis.matchMedia,
    Node: globalThis.Node,
    window: globalThis.window,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
    Node: dom.window.Node,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const initialSettings = options.initialSettings ?? settings;
  const zenx = {
    settings: {
      get: options.get ?? (async () => initialSettings),
      save:
        options.save ??
        (async (profile: ZenXSettingsUpdate) => ({
          ...initialSettings,
          profile: { ...initialSettings.profile, ...profile },
        })),
      addProvider:
        options.addProvider ??
        (async () => {
          throw new Error("Unexpected addProvider call");
        }),
      editProvider:
        options.editProvider ??
        (async () => {
          throw new Error("Unexpected editProvider call");
        }),
      deleteProvider:
        options.deleteProvider ??
        (async () => {
          throw new Error("Unexpected deleteProvider call");
        }),
      discoverProvider:
        options.discoverProvider ??
        (async () => {
          throw new Error("Unexpected discoverProvider call");
        }),
      probeProviderImage:
        options.probeProviderImage ??
        (async () => {
          throw new Error("Unexpected probeProviderImage call");
        }),
      onManualCodeRequested: () => () => undefined,
    },
  } as unknown as Window["zenx"];
  Object.defineProperty(dom.window, "zenx", { value: zenx });
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(SettingsHarness, {
        archivedThreads: options.archivedThreads ?? [],
        initialTab,
        onUnarchive: options.onUnarchive ?? (async () => undefined),
      }),
    );
  });
  return { dom, previous, root };
}

function SettingsHarness({
  archivedThreads,
  initialTab,
  onUnarchive,
}: {
  archivedThreads: NativeThreadSummary[];
  initialTab: SettingsTab;
  onUnarchive(thread: NativeThreadSummary): Promise<void>;
}) {
  const [tab, setTab] = useState(initialTab);
  return createElement(SettingsView, {
    archivedError: null,
    archivedLoading: false,
    archivedThreads,
    onRetryArchived: () => undefined,
    onTabChange: setTab,
    onUnarchive,
    tab,
  });
}

async function unmount(harness: Harness): Promise<void> {
  await act(async () => harness.root.unmount());
  Object.assign(globalThis, harness.previous, {
    IS_REACT_ACT_ENVIRONMENT: undefined,
  });
  harness.dom.window.close();
}

function exactButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label,
  );
}

function exactButtonRequired(label: string): HTMLButtonElement {
  const button = exactButton(label);
  assert.ok(button, `Missing button: ${label}`);
  return button;
}

function labeledButton(label: string): HTMLButtonElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((button) => button.getAttribute("aria-label") === label);
}

function labeledButtonRequired(label: string): HTMLButtonElement {
  const button = labeledButton(label);
  assert.ok(button, `Missing button with accessible name: ${label}`);
  return button;
}

function labelControl<T extends HTMLInputElement | HTMLSelectElement>(
  label: string,
  selector: string,
): T | undefined {
  return (
    Array.from(document.querySelectorAll<HTMLLabelElement>("label"))
      .find(
        (candidate) =>
          candidate.querySelector("span")?.textContent?.trim() === label,
      )
      ?.querySelector<T>(selector) ?? undefined
  );
}

function requiredInput(label: string): HTMLInputElement {
  const input = labelControl<HTMLInputElement>(label, "input");
  assert.ok(input, `Missing input: ${label}`);
  return input;
}

function labeledSelect(label: string): HTMLSelectElement | undefined {
  return labelControl<HTMLSelectElement>(label, "select");
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

async function changeControl(
  control: HTMLInputElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  await act(async () => {
    const previous = control.value;
    control.value = value;
    const tracker = (
      control as HTMLInputElement & {
        _valueTracker?: { setValue(value: string): void };
      }
    )._valueTracker;
    tracker?.setValue(previous);
    control.dispatchEvent(new window.Event("input", { bubbles: true }));
    control.dispatchEvent(new window.Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

function appearanceModeRadio(
  value: "system" | "light" | "dark",
): HTMLInputElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'input[name="appearance-mode"]',
    ),
  ).find((input) => input.value === value);
}

function appearanceChoice(
  name: string,
  value: string,
): HTMLInputElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`),
  ).find((input) => input.value === value);
}

async function waitFor<T>(read: () => T | null | undefined): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(
    `Timed out waiting for Settings interaction state: ${document.body.textContent?.replace(/\s+/gu, " ").trim()}`,
  );
}

function archivedSummary(): NativeThreadSummary {
  return {
    threadId: "archived-thread",
    currentMetadata: {
      model: "deepseek-chat",
      provider: "deepseek",
      cwd: "/work/zen",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    archived: true,
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(2_000).toISOString(),
    name: "Archived conversation",
    preview: "",
    status: "idle",
  };
}
