import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { ComposerModelMenu } from "../src/renderer/src/ComposerModelMenu.js";
import { AgentProviderModelScope } from "../src/renderer/src/agent-provider-selection.js";
import type { ModelSummary } from "../src/protocol-client/types.js";
const { act, createElement: h } = React;
Object.assign(globalThis, { React });
const instances = [
  { id: "zen", kind: "zen" as const, name: "Zen" },
  { id: "codex-work", kind: "codex" as const, name: "Codex work" },
];
const model = {
  id: "native-one",
  model: "native-one",
  displayName: "Native One",
  description: "",
  hidden: false,
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: null,
  inputModalities: ["text"],
  supportsPersonality: false,
  additionalSpeedTiers: [],
  serviceTiers: [],
  defaultServiceTier: null,
  isDefault: true,
} as ModelSummary;

test("one compact picker keeps engine selection usable while its model catalog is unavailable", async () => {
  const dom = new JSDOM("<div id=root></div>", { url: "http://localhost" });
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const changes: string[] = [];
  try {
    await act(async () =>
      root.render(
        h(
          AgentProviderModelScope,
          {
            selection: {
              instances,
              value: "codex-work",
              onChange: (id: string) => changes.push(id),
            },
          },
          h(ComposerModelMenu, {
            disabled: false,
            switching: false,
            selectedModel: "native-one",
            selectedReasoningEffort: null,
            providerProfiles: [],
            models: [],
            loading: true,
            modelError: "Catalog unavailable",
            showReasoning: false,
            onModelChange: () => assert.fail("must not choose stale model"),
            onReasoningChange: () => assert.fail(),
          }),
        ),
      ),
    );
    const trigger = document.querySelector<HTMLButtonElement>(
      ".composer-model-trigger",
    )!;
    assert.equal(
      document.querySelectorAll(".composer-model-trigger").length,
      1,
    );
    assert.equal(document.querySelectorAll(".agent-provider-select").length, 0);
    assert.match(trigger.title, /Codex work/);
    assert.equal(trigger.disabled, false);
    await act(async () => trigger.click());
    const engine = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((button) => button.textContent?.startsWith("Agent Provider"))!;
    await act(async () => engine.click());
    assert.equal(
      document.querySelector('[role="menu"]')?.getAttribute("aria-label"),
      "Choose Agent Provider",
    );
    const zen = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ].find((button) => button.textContent === "Zen")!;
    await act(async () => zen.click());
    assert.deepEqual(changes, ["zen"]);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, trigger);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, saved);
    dom.window.close();
  }
});

test("existing native conversation locks its exact instance while allowing supported model selection", async () => {
  const dom = new JSDOM("<div id=root></div>", { url: "http://localhost" });
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const changes: string[] = [];
  try {
    await act(async () =>
      root.render(
        h(
          AgentProviderModelScope,
          { selection: { instances: [instances[1]!], value: "codex-work" } },
          h(ComposerModelMenu, {
            disabled: false,
            switching: false,
            selectedModel: "native-one",
            selectedReasoningEffort: null,
            providerProfiles: [],
            models: [model],
            modelError: null,
            showReasoning: false,
            onModelChange: (id: string) => changes.push(id),
            onReasoningChange: () => assert.fail(),
          }),
        ),
      ),
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".composer-model-trigger")!
        .click(),
    );
    const entries = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ];
    assert.equal(
      entries.find((button) =>
        button.textContent?.startsWith("Agent Provider"),
      )!.disabled,
      true,
    );
    await act(async () =>
      entries
        .find((button) => button.textContent?.startsWith("Model"))!
        .click(),
    );
    assert.equal(
      document.querySelector('[role="menu"]')?.getAttribute("aria-label"),
      "Choose model",
    );
    assert.doesNotMatch(document.body.textContent!, /reasoning levels/);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[role="menuitemradio"]')!
        .click(),
    );
    assert.deepEqual(changes, ["native-one"]);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, saved);
    dom.window.close();
  }
});
