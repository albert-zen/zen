import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
const rendererStyles = await readFile(
  new URL("../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

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
  installComposerToolsStyles(dom);
  const root = createRoot(container);
  const selected = key("alpha", "alpha-text");
  const modelChanges: string[] = [];
  const reasoningChanges: string[] = [];

  try {
    await act(async () =>
      root.render(
        createElement(
          "div",
          { className: "composer-tools" },
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
      ),
    );
    const trigger = requiredButton(".composer-model-trigger");
    assert.equal(trigger.textContent?.trim(), "◇Alpha Text Medium");
    await act(async () => trigger.click());
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    const tools = requiredElement<HTMLElement>(".composer-tools");
    const menu = requiredElement<HTMLElement>(".composer-selection-menu");
    installRect(tools, { left: 0, top: 100, width: 300, height: 40 });
    installRect(menu, { left: 0, top: 20, width: 300, height: 72 });
    assert.ok(
      visibleAreaWithinClippingAncestors(menu, dom.window) > 0,
      "The upward-opening menu must have a visible area outside the toolbar",
    );
    assert.equal(
      document.activeElement?.textContent?.trim(),
      "ModelAlpha Text",
    );

    await act(async () =>
      document.activeElement?.dispatchEvent(keydown(dom, "ArrowDown")),
    );
    assert.equal(
      document.activeElement?.textContent?.trim(),
      "ReasoningMedium",
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

    await act(async () => trigger.click());
    const reasoningEntry = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.includes("Reasoning"));
    assert.ok(reasoningEntry);
    await act(async () => reasoningEntry.click());
    assert.deepEqual(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      ).map((button) => button.textContent?.trim()),
      ["Low", "Medium"],
    );
    await act(async () =>
      (
        document.querySelector('[role="menuitemradio"]') as HTMLButtonElement
      ).click(),
    );
    assert.deepEqual(reasoningChanges, ["low"]);
    assert.equal(document.activeElement, trigger);

    await act(async () => trigger.click());
    const reasoningForEscape = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.includes("Reasoning"));
    assert.ok(reasoningForEscape);
    await act(async () => reasoningForEscape.click());
    await act(async () =>
      document.activeElement?.dispatchEvent(keydown(dom, "Escape")),
    );
    assert.equal(document.activeElement, trigger);

    trigger.focus();
    await act(async () => trigger.dispatchEvent(keydown(dom, "ArrowDown")));
    await act(async () =>
      document.activeElement?.dispatchEvent(keydown(dom, "Escape")),
    );
    assert.equal(document.activeElement, trigger);

    trigger.focus();
    await act(async () => trigger.dispatchEvent(keydown(dom, "ArrowUp")));
    await act(async () =>
      document.activeElement?.dispatchEvent(keydown(dom, "Escape")),
    );
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
        createElement(
          "div",
          { className: "composer-tools" },
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
      ),
    );
    const unavailableTrigger = requiredButton(".composer-model-trigger");
    assert.equal(
      unavailableTrigger.getAttribute("aria-label"),
      "Model and reasoning: Unavailable model",
    );
    assert.equal(document.querySelector(".composer-reasoning-trigger"), null);
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

function installComposerToolsStyles(dom: JSDOM): void {
  const rule = rendererStyles.match(/\.composer-tools\s*\{[^}]*\}/u)?.[0];
  assert.ok(rule, "Missing .composer-tools CSS rule");
  const style = dom.window.document.createElement("style");
  style.textContent = rule;
  dom.window.document.head.append(style);
}

type Rect = { left: number; top: number; width: number; height: number };

function installRect(element: Element, rect: Rect): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      ...rect,
      bottom: rect.top + rect.height,
      right: rect.left + rect.width,
      x: rect.left,
      y: rect.top,
      toJSON: () => undefined,
    }),
  });
}

function visibleAreaWithinClippingAncestors(
  element: Element,
  window: { getComputedStyle(element: Element): CSSStyleDeclaration },
): number {
  let visible = element.getBoundingClientRect();
  for (
    let ancestor = element.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    const style = window.getComputedStyle(ancestor);
    if (!clipsOverflow(style.overflow, style.overflowX, style.overflowY)) {
      continue;
    }
    const bounds = ancestor.getBoundingClientRect();
    const left = Math.max(visible.left, bounds.left);
    const top = Math.max(visible.top, bounds.top);
    const right = Math.min(visible.right, bounds.right);
    const bottom = Math.min(visible.bottom, bounds.bottom);
    visible = {
      ...visible,
      left,
      top,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }
  return Math.max(0, visible.width) * Math.max(0, visible.height);
}

function clipsOverflow(...values: string[]): boolean {
  return values.some((value) => /^(auto|clip|hidden|scroll)$/u.test(value));
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
