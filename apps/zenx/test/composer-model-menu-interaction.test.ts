import "./dom-primitives.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";

import type { ZenXProviderProfile } from "../src/main/host-profile.js";
import type { ModelSummary } from "../src/protocol-client/index.js";
import { encodeModelKey } from "../../../src/protocol/model-key.js";

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
    "<!doctype html><html><body><button id=outside>Outside target</button><div id=root></div></body></html>",
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
              model(key("beta", "vendor/beta-vision-v2"), "Beta Vision", [
                "high",
              ]),
              model(key("alpha", "hidden"), "Hidden", ["medium"], false, true),
            ],
            onModelChange: (value: string) => modelChanges.push(value),
            onReasoningChange: (value: string) => reasoningChanges.push(value),
            providerProfiles: [
              provider("alpha", "Alpha Cloud", ["alpha-text", "hidden"]),
              provider("beta", "Beta Local", ["vendor/beta-vision-v2"]),
            ],
            selectedModel: selected,
            selectedReasoningEffort: "medium",
            switching: false,
          }),
        ),
      ),
    );
    const trigger = requiredButton(".composer-model-trigger");
    assert.equal(trigger.textContent?.trim(), "Alpha Text Medium");
    await act(async () => trigger.click());
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.match(
      document.body.textContent ?? "",
      /Changes apply to the next turn\./u,
    );
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

    const search = requiredElement<HTMLInputElement>(".composer-model-search");
    const setSearch = async (value: string) => {
      const propsKey = Object.keys(search).find((key) =>
        key.startsWith("__reactProps$"),
      );
      assert.ok(propsKey);
      const props = Reflect.get(search, propsKey) as {
        onChange(event: { target: { value: string } }): void;
      };
      await act(async () => props.onChange({ target: { value } }));
      assert.equal(search.value, value);
      assert.equal(document.activeElement, search);
    };
    const matchingModels = () =>
      Array.from(
        document.querySelectorAll('[role="menuitemradio"] strong'),
      ).map((label) => label.textContent);
    for (const query of [
      "vendor/beta-vision-v2",
      "BETA-VISION-V2",
      "Beta Vision",
      "Beta Local",
    ]) {
      await setSearch(query);
      assert.deepEqual(matchingModels(), ["Beta Vision"], query);
    }
    for (const query of ["hidden", key("beta", "vendor/beta-vision-v2")]) {
      await setSearch(query);
      assert.deepEqual(matchingModels(), [], query);
    }
    assert.deepEqual(modelChanges, []);
    await setSearch("");

    const beta = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ).find((button) => button.textContent?.includes("Beta Vision"));
    assert.ok(beta);
    await act(async () => beta.click());
    assert.deepEqual(modelChanges, [key("beta", "vendor/beta-vision-v2")]);
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(
      document.activeElement === trigger,
      true,
      `Focus: ${document.activeElement?.outerHTML.slice(0, 180)}`,
    );

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
    assert.equal(
      document.activeElement === trigger,
      true,
      `Focus: ${document.activeElement?.outerHTML.slice(0, 180)}`,
    );

    await act(async () => trigger.click());
    const reasoningForEscape = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.includes("Reasoning"));
    assert.ok(reasoningForEscape);
    await act(async () => reasoningForEscape.click());
    await act(async () =>
      document.activeElement?.dispatchEvent(keydown(dom, "Escape")),
    );
    assert.equal(
      document.activeElement === trigger,
      true,
      `Focus: ${document.activeElement?.outerHTML.slice(0, 180)}`,
    );

    trigger.focus();
    await act(async () => trigger.dispatchEvent(keydown(dom, "ArrowDown")));
    await act(async () =>
      document.activeElement?.dispatchEvent(keydown(dom, "Escape")),
    );
    assert.equal(
      document.activeElement === trigger,
      true,
      `Focus: ${document.activeElement?.outerHTML.slice(0, 180)}`,
    );

    trigger.focus();
    await act(async () => trigger.dispatchEvent(keydown(dom, "ArrowUp")));
    await act(async () =>
      document.activeElement?.dispatchEvent(keydown(dom, "Escape")),
    );
    assert.equal(
      document.activeElement === trigger,
      true,
      `Focus: ${document.activeElement?.outerHTML.slice(0, 180)}`,
    );

    await act(async () => trigger.click());
    await act(async () => {
      document
        .getElementById("outside")
        ?.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      document.getElementById("outside")?.focus();
    });
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(
      document.activeElement?.id,
      "outside",
      "Outside clicks must not steal focus back to the menu trigger",
    );

    const textOnly = key("alpha", "alpha-text-only");
    await act(async () =>
      root.render(
        createElement(
          "div",
          { className: "composer-tools" },
          createElement(ComposerModelMenu, {
            disabled: false,
            modelError: null,
            models: [model(textOnly, "Alpha Text Only", [], true)],
            onModelChange: () => undefined,
            onReasoningChange: () => undefined,
            providerProfiles: [
              provider("alpha", "Alpha Cloud", ["alpha-text-only"]),
            ],
            selectedModel: textOnly,
            selectedReasoningEffort: null,
            switching: false,
          }),
        ),
      ),
    );
    const textOnlyTrigger = requiredButton(".composer-model-trigger");
    assert.equal(
      textOnlyTrigger.getAttribute("aria-label"),
      "Model and reasoning: Alpha Text Only",
    );
    await act(async () => textOnlyTrigger.click());
    const textOnlyReasoning = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.includes("Text only"));
    assert.ok(textOnlyReasoning);
    assert.equal(textOnlyReasoning.disabled, true);
    assert.match(
      document.body.textContent ?? "",
      /sends text without a Provider-specific reasoning control/u,
    );

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

test("same-name versions expose their provider IDs without changing model selection", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const previous = {
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
  const root = createRoot(requiredElement("#root"));
  const versions = [
    "vendor/text-stable-2026-10-01",
    "vendor/text-stable-2026-11-15",
  ];
  const [first, second] = versions.map((id) => key("alpha", id));
  assert.ok(first && second);
  const changes: string[] = [];
  try {
    await act(async () =>
      root.render(
        createElement(ComposerModelMenu, {
          disabled: false,
          modelError: null,
          models: [
            model(first, "Example", [], false),
            model(second, "Example", [], false),
            model(key("alpha", "unique"), "Unique", [], false),
            model(key("alpha", "hidden"), "Unique", [], false, true),
            model(key("beta", "example"), "Example", [], false),
          ],
          providerProfiles: [
            provider("alpha", "Alpha Cloud", [...versions, "unique", "hidden"]),
            provider("beta", "Beta Local", ["example"]),
          ],
          onModelChange: (value: string) => changes.push(value),
          onReasoningChange: () => undefined,
          selectedModel: first,
          selectedReasoningEffort: null,
          switching: false,
        }),
      ),
    );
    const trigger = requiredButton(".composer-model-trigger");
    await act(async () => trigger.click());
    await act(async () => requiredButton('[role="menuitem"]').click());
    const rows = () =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      );
    const versionsInRows = () =>
      rows().map(
        (row) =>
          row.querySelector(".composer-model-version")?.textContent ?? null,
      );
    assert.deepEqual(versionsInRows(), [...versions, null, null]);
    assert.deepEqual(
      rows().map((row) => row.getAttribute("aria-checked")),
      ["true", "false", "false", "false"],
    );
    const search = requiredElement<HTMLInputElement>(".composer-model-search");
    assert.equal(document.activeElement, search);
    await act(async () => search.dispatchEvent(keydown(dom, "ArrowDown")));
    const back = requiredButton(".composer-menu-back");
    assert.equal(document.activeElement, back);
    await act(async () => back.dispatchEvent(keydown(dom, "ArrowDown")));
    const firstVersion = rows()[0];
    assert.equal(document.activeElement, firstVersion);
    await act(async () =>
      firstVersion?.dispatchEvent(keydown(dom, "ArrowDown")),
    );
    assert.equal(document.activeElement, rows()[1]);
    assert.deepEqual(
      changes,
      [],
      "keyboard browsing must not select a version",
    );
    await act(async () => search.focus());
    const propsKey = Object.keys(search).find((key) =>
      key.startsWith("__reactProps$"),
    );
    assert.ok(propsKey);
    const props = Reflect.get(search, propsKey) as {
      onChange(event: { target: { value: string } }): void;
    };
    await act(async () =>
      props.onChange({ target: { value: versions[1] ?? "" } }),
    );
    assert.deepEqual(versionsInRows(), [versions[1]]);
    const match = rows()[0];
    assert.ok(match);
    assert.deepEqual(changes, [], "filtering must not change the selection");
    await act(async () => match.click());
    assert.deepEqual(changes, [second]);
    assert.equal(document.activeElement, trigger);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, previous);
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
    defaultReasoningEffort: efforts[0] ?? null,
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
