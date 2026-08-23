import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";

import type { ZenXProviderProfile } from "../src/main/host-profile.js";
import type { ModelSummary } from "../src/protocol-client/index.js";
import { encodeModelKey } from "../../../src/protocol/codex/model-key.js";

const { act, createElement } = React;
Object.assign(globalThis, { React });
const { ComposerModelMenu } =
  await import("../src/renderer/src/ComposerModelMenu.js");

test("Composer model menu groups Providers and manages keyboard focus", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><main id=outside></main><div id=root></div></body></html>",
    { url: "http://localhost" },
  );
  const previousGlobals = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    window: globalThis.window,
  };
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const selected = key("alpha", "alpha-text");
  const modelChanges: string[] = [];
  const reasoningChanges: string[] = [];

  try {
    await act(async () =>
      root.render(
        createElement(ComposerModelMenu, {
          disabled: false,
          modelError: null,
          models: [
            model(selected, "Alpha Text", ["low", "medium"], true),
            model(key("beta", "beta-vision"), "Beta Vision", ["high"]),
            model(key("alpha", "hidden"), "Hidden", ["medium"], false, true),
          ],
          onModelChange: (value: string) => modelChanges.push(value),
          onReasoningChange: (value: string) => reasoningChanges.push(value),
          providerProfiles: [
            provider("alpha", "Alpha Cloud", ["alpha-text", "hidden"]),
            provider("beta", "Beta Local", ["beta-vision"]),
          ],
          selectedModel: selected,
          selectedReasoningEffort: "medium",
          switching: false,
        }),
      ),
    );
    const trigger = requiredButton(".composer-model-trigger");
    await act(async () => trigger.click());
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.equal(
      document.activeElement?.textContent?.trim(),
      "ModelAlpha Text",
    );

    await act(async () =>
      document.activeElement?.dispatchEvent(keydown(dom, "ArrowDown")),
    );
    assert.equal(
      document.activeElement?.textContent?.trim(),
      "Reasoningmedium",
    );
    await act(async () =>
      document.activeElement?.dispatchEvent(keydown(dom, "ArrowUp")),
    );
    await act(async () =>
      (document.activeElement as HTMLButtonElement | null)?.click(),
    );
    assert.equal(
      requiredElement('[role="menu"]').getAttribute("aria-label"),
      "Choose model",
    );
    assert.deepEqual(
      Array.from(document.querySelectorAll('[role="group"]')).map((group) =>
        group.getAttribute("aria-label"),
      ),
      ["Alpha Cloud", "Beta Local"],
    );
    assert.equal(document.body.textContent?.includes("Hidden"), false);

    const beta = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ).find((button) => button.textContent?.includes("Beta Vision"));
    assert.ok(beta);
    await act(async () => beta.click());
    assert.deepEqual(modelChanges, [key("beta", "beta-vision")]);
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, trigger);

    const reasoningTrigger = requiredButton(".composer-reasoning-trigger");
    assert.match(reasoningTrigger.getAttribute("aria-label") ?? "", /medium/);
    await act(async () => reasoningTrigger.click());
    assert.deepEqual(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      ).map((button) => button.textContent?.trim()),
      ["low", "medium"],
    );
    await act(async () =>
      (
        document.querySelector('[role="menuitemradio"]') as HTMLButtonElement
      ).click(),
    );
    assert.deepEqual(reasoningChanges, ["low"]);
    assert.equal(document.activeElement, reasoningTrigger);

    await act(async () => trigger.click());
    const reasoning = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.includes("Reasoning"));
    assert.ok(reasoning);
    await act(async () => reasoning.click());
    assert.deepEqual(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      ).map((button) => button.textContent?.trim()),
      ["low", "medium"],
    );
    await act(async () =>
      document.activeElement?.dispatchEvent(keydown(dom, "Escape")),
    );
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, trigger);

    await act(async () => trigger.click());
    await act(async () => {
      document
        .getElementById("outside")
        ?.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
    });
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, trigger);

    await act(async () =>
      root.render(
        createElement(ComposerModelMenu, {
          disabled: false,
          modelError: null,
          models: [],
          onModelChange: () => undefined,
          onReasoningChange: () => undefined,
          providerProfiles: [],
          selectedModel: key("removed", "old-model"),
          selectedReasoningEffort: "medium",
          switching: false,
        }),
      ),
    );
    const unknownReasoning = requiredButton(".composer-reasoning-trigger");
    assert.equal(unknownReasoning.disabled, true);
    assert.equal(
      unknownReasoning.getAttribute("aria-label"),
      "Reasoning effort: Unknown",
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previousGlobals, {
      IS_REACT_ACT_ENVIRONMENT: undefined,
    });
    dom.window.close();
  }
});

function requiredElement<T extends Element = Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  assert.ok(value, `Missing ${selector}`);
  return value;
}

function requiredButton(selector: string): HTMLButtonElement {
  return requiredElement<HTMLButtonElement>(selector);
}

function keydown(dom: JSDOM, key: string): KeyboardEvent {
  return new dom.window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
  }) as unknown as KeyboardEvent;
}

function key(providerProfileId: string, modelId: string): string {
  return encodeModelKey({ providerProfileId, modelId });
}

function model(
  id: string,
  displayName: string,
  efforts: string[],
  isDefault = false,
  hidden = false,
): ModelSummary {
  return {
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName,
    description: `${displayName} description`,
    hidden,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
    defaultReasoningEffort: efforts[0]!,
    inputModalities: displayName.includes("Vision")
      ? ["text", "image"]
      : ["text"],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault,
  };
}

function provider(
  providerProfileId: string,
  displayName: string,
  modelIds: string[],
): ZenXProviderProfile {
  return {
    type: "fake",
    providerProfileId,
    displayName,
    models: modelIds.map((id) => ({
      id,
      source: "manual",
      displayName: id,
      description: id,
      hidden: false,
      contextWindow: null,
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
      inputModalities: ["text"],
    })),
  };
}
