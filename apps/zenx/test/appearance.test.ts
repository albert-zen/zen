import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import {
  APPEARANCE_STORAGE_KEY,
  applyResolvedAppearance,
  createAppearanceController,
  readAppearancePreference,
  resolveAppearance,
} from "../src/renderer/src/appearance.js";

test("resolves explicit and system appearance preferences", () => {
  assert.equal(resolveAppearance("light", true), "light");
  assert.equal(resolveAppearance("dark", false), "dark");
  assert.equal(resolveAppearance("system", true), "dark");
  assert.equal(resolveAppearance("system", false), "light");
  assert.equal(readAppearancePreference(storageWith("unexpected")), "system");
});

test("applies the root attribute, CSS color-scheme, and native-control meta", () => {
  const dom = new JSDOM(
    '<!doctype html><html><head><meta name="color-scheme" content="dark light"></head></html>',
  );
  applyResolvedAppearance(dom.window.document, "light");
  assert.equal(dom.window.document.documentElement.dataset.appearance, "light");
  assert.equal(dom.window.document.documentElement.style.colorScheme, "light");
  assert.equal(
    dom.window.document
      .querySelector('meta[name="color-scheme"]')
      ?.getAttribute("content"),
    "light",
  );
  dom.window.close();
});

test("persists switches and follows live system changes only in System", () => {
  const dom = new JSDOM("<!doctype html><html></html>");
  const storage = storageWith("system");
  const system = new FakeSystemPreference(false);
  const controller = createAppearanceController({
    document: dom.window.document,
    storage,
    systemPreference: system,
  });
  assert.equal(dom.window.document.documentElement.dataset.appearance, "light");

  system.setDark(true);
  assert.equal(dom.window.document.documentElement.dataset.appearance, "dark");

  controller.setPreference("light");
  assert.equal(storage.getItem(APPEARANCE_STORAGE_KEY), "light");
  assert.equal(dom.window.document.documentElement.dataset.appearance, "light");
  system.setDark(false);
  system.setDark(true);
  assert.equal(dom.window.document.documentElement.dataset.appearance, "light");

  controller.setPreference("system");
  assert.equal(dom.window.document.documentElement.dataset.appearance, "dark");
  controller.dispose();
  system.setDark(false);
  assert.equal(dom.window.document.documentElement.dataset.appearance, "dark");
  dom.window.close();
});

class FakeSystemPreference {
  matches: boolean;
  readonly #listeners = new Set<() => void>();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(_type: "change", listener: () => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: "change", listener: () => void): void {
    this.#listeners.delete(listener);
  }

  setDark(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.#listeners) listener();
  }
}

function storageWith(initial?: string): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(APPEARANCE_STORAGE_KEY, initial);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}
