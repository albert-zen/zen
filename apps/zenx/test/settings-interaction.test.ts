/// <reference path="../src/renderer/src/env.d.ts" />

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

import type { NativeThreadSummary } from "../../../src/thread-summary.js";
import type {
  PublicHostSettings,
  ZenXHostProfile,
  ZenXSettingsUpdate,
} from "../src/main/host-profile.js";
import type { AppearancePreference } from "../src/renderer/src/appearance.js";
import type { SettingsTab } from "../src/renderer/src/SettingsView.js";

const { act, createElement, useState } = React;
Object.assign(globalThis, { React });
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
  subscription: { authenticated: false, expired: false },
};

test("Settings keeps restart contextual and enables it only for edits", async () => {
  const saved: ZenXSettingsUpdate[] = [];
  const harness = await mountSettings("models", async (profile) => {
    saved.push(profile);
    return { ...settings, profile: { ...settings.profile, ...profile } };
  });
  try {
    await waitFor(() => exactButton("Apply & restart"));
    assert.equal(document.querySelector(".page-header-actions"), null);
    assert.equal(exactButton("Done"), undefined);
    assert.equal(exactButton("Save and restart host"), undefined);

    const apply = exactButton("Apply & restart");
    assert.ok(apply);
    assert.equal(apply.disabled, true);
    const apiProvider = exactButton("API provider");
    assert.ok(apiProvider);
    await act(async () => apiProvider.click());
    assert.equal(apply.disabled, false);
    await act(async () => {
      apply.click();
      await Promise.resolve();
    });
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.defaultModel.modelId, "gpt-5.4");
    assert.match(document.body.textContent ?? "", /local host restarted/u);
    assert.equal(apply.disabled, true);
  } finally {
    await unmount(harness);
  }
});

test("Archived threads is a Settings section with keyboard-reachable Unarchive", async () => {
  let restored: string | null = null;
  const harness = await mountSettings(
    "account",
    async (profile) => ({
      ...settings,
      profile: { ...settings.profile, ...profile },
    }),
    {
      archivedThreads: [archivedSummary()],
      onUnarchive: async (thread) => {
        restored = thread.threadId;
      },
    },
  );
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
  const harness = await mountSettings("general", async (profile) => {
    saved.push(profile);
    return { ...settings, profile: { ...settings.profile, ...profile } };
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
  save: (
    profile: ZenXSettingsUpdate,
    apiKey?: string,
  ) => Promise<PublicHostSettings>,
  options: {
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
  const zenx = {
    settings: {
      get: async () => settings,
      save,
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
  throw new Error("Timed out waiting for Settings interaction state");
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
