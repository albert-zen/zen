import assert from "node:assert/strict";
import test from "node:test";
import {
  createLanguageController,
  LANGUAGE_STORAGE_KEY,
  resolveLanguage,
} from "../src/renderer/src/language-preference.js";

test("matches ordered system language preferences without treating Traditional Chinese as Simplified", () => {
  assert.equal(
    resolveLanguage("system", ["fr-FR", "zh-Hans-SG", "en-US"]),
    "zh-CN",
  );
  assert.equal(resolveLanguage("system", ["en-GB", "zh-CN"]), "en");
  assert.equal(resolveLanguage("system", ["zh-TW", "zh-Hant-HK"]), "en");
  assert.equal(resolveLanguage("system", ["zh", "en"]), "zh-CN");
  assert.equal(resolveLanguage("system", ["bad_tag", "zh-SG"]), "zh-CN");
  assert.equal(resolveLanguage("zh-CN", ["en"]), "zh-CN");
  assert.equal(resolveLanguage("en", ["zh-CN"]), "en");
  assert.equal(resolveLanguage("system", []), "en");
});

test("explicit language survives recreation; following system remains a preference, not a saved resolved locale", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const applied: string[] = [];
  const first = createLanguageController({
    storage,
    systemLanguages: ["zh-CN"],
    apply: (locale) => applied.push(locale),
  });
  assert.equal(first.getPreference(), "system");
  assert.equal(first.getLocale(), "zh-CN");
  assert.equal(first.setPreference("en"), true);
  first.setSystemLanguages(["zh-Hans"]);
  assert.equal(first.getLocale(), "en");
  const reopened = createLanguageController({
    storage,
    systemLanguages: ["zh-CN"],
    apply: (locale) => applied.push(locale),
  });
  assert.equal(reopened.getPreference(), "en");
  reopened.setPreference("system");
  assert.equal(values.get(LANGUAGE_STORAGE_KEY), "system");
  reopened.setSystemLanguages(["en-GB"]);
  assert.equal(reopened.getLocale(), "en");
  assert.ok(applied.includes("zh-CN"));
});

test("invalid/unavailable storage falls back safely and failed persistence is observable", () => {
  const controller = createLanguageController({
    storage: {
      getItem: () => "unsupported",
      setItem: () => {
        throw new Error("denied");
      },
    },
    systemLanguages: ["zh-CN"],
    apply: () => {},
  });
  assert.equal(controller.getPreference(), "system");
  assert.equal(controller.setPreference("en"), false);
  assert.equal(controller.getLocale(), "en");
  controller.receivePreference(null);
  assert.equal(controller.getPreference(), "system");
  assert.equal(controller.getLocale(), "zh-CN");
});

test("cross-window preferences notify observers without writing them back", () => {
  let writes = 0;
  let notifications = 0;
  const controller = createLanguageController({
    storage: {
      getItem: () => null,
      setItem: () => {
        writes++;
      },
    },
    systemLanguages: ["en"],
    apply: () => {},
  });
  const dispose = controller.subscribe(() => notifications++);
  controller.receivePreference("zh-CN");
  assert.equal(controller.getLocale(), "zh-CN");
  assert.equal(writes, 0);
  assert.equal(notifications, 1);
  dispose();
  controller.receivePreference("en");
  assert.equal(notifications, 1);
});
