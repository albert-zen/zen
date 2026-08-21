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
  ZenXProviderDeleteReplacements,
  ZenXProviderEditOptions,
  ZenXProviderProfile,
  ZenXSettingsUpdate,
} from "../src/main/host-profile.js";
import type { AppearancePreference } from "../src/renderer/src/appearance.js";
import type { SettingsTab } from "../src/renderer/src/SettingsView.js";

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
    version: 2,
    onboardingComplete: true,
    providerProfiles: [
      {
        providerProfileId: "fake",
        type: "fake",
        displayName: "Local demo",
        models: ["fake", "gpt-5.6-luna"],
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
        models: ["shared-model", "alpha-only"],
      },
      {
        providerProfileId: "profile-beta",
        type: "openai-compatible",
        name: "beta-api",
        displayName: "Beta",
        baseUrl: "https://beta.example.test/v1",
        models: ["shared-model", "beta-only"],
      },
      {
        providerProfileId: "profile-local",
        type: "fake",
        displayName: "Local demo",
        models: ["fake"],
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
    await click(exactButtonRequired("Add model"));
    await changeControl(requiredInput("Model 2"), "acme-large");
    await click(exactButtonRequired("Add provider"));
    await waitFor(() => added);

    assert.equal(added?.apiKey, "secret-replacement");
    assert.equal(added?.provider.type, "openai-compatible");
    assert.equal(added?.provider.displayName, "Acme AI");
    assert.deepEqual(added?.provider.models, ["shared-model", "acme-large"]);
    assert.notEqual(added?.provider.providerProfileId, "Acme AI");
    assert.notEqual(added?.provider.providerProfileId, "acme");
    assert.match(added?.provider.providerProfileId ?? "", /^[0-9a-f-]{20,}$/u);
    assert.doesNotMatch(document.body.textContent ?? "", /secret-replacement/u);
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
    await click(labeledButtonRequired("Add Local demo"));
    await click(exactButtonRequired("Add provider"));
    await waitFor(() => added);
    assert.equal(added?.type, "fake");
    assert.deepEqual(added?.models, ["fake"]);
    assert.notEqual(added?.providerProfileId, "fake");
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

test("General switches Appearance immediately without restarting the host", async () => {
  const saved: ZenXSettingsUpdate[] = [];
  const harness = await mountSettings("general", {
    save: async (profile) => {
      saved.push(profile);
      return { ...settings, profile: { ...settings.profile, ...profile } };
    },
  });
  try {
    await waitFor(() => appearanceRadio("light"));
    const system = appearanceRadio("system");
    const light = appearanceRadio("light");
    const dark = appearanceRadio("dark");
    assert.ok(system);
    assert.ok(light);
    assert.ok(dark);
    assert.equal(system.type, "radio");
    assert.equal(light.type, "radio");
    assert.equal(dark.type, "radio");
    assert.equal(system.name, "appearance");
    assert.equal(light.name, system.name);
    assert.equal(dark.name, system.name);
    await act(async () => light.click());
    assert.equal(document.documentElement.dataset.appearance, "light");
    assert.equal(localStorage.getItem("zenx.appearance"), "light");
    assert.equal(light.checked, true);
    assert.equal(system.checked, false);
    assert.equal(dark.checked, false);
    assert.equal(saved.length, 0);
    assert.equal(exactButton("Apply & restart")?.disabled, true);
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
      get: async () => initialSettings,
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

function appearanceRadio(
  value: AppearancePreference,
): HTMLInputElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>('input[name="appearance"]'),
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
