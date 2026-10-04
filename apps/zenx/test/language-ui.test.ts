import "./dom-primitives.js";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import {
  initializeLanguage,
  getLanguageController,
} from "../src/renderer/src/language.js";
import { LanguageSettings } from "../src/renderer/src/LanguageSettings.js";
import { LANGUAGE_STORAGE_KEY } from "../src/renderer/src/language-preference.js";
import { i18n } from "../src/renderer/src/i18n.js";

const { act, createElement: h } = React;

function ConversationProbe() {
  const { t } = useTranslation("common");
  const [draft, setDraft] = React.useState("Keep my <draft> 原文");
  return h(
    "div",
    {},
    h("span", {}, t("language")),
    h("textarea", {
      value: draft,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
        setDraft(event.target.value),
    }),
  );
}

test("live language selection preserves the mounted draft, accessibility language, and saved choice on reopen", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='root'></div></body></html>",
    { url: "https://zenx.test" },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const nativeLanguages: string[] = [];
  Object.assign(dom.window, {
    zenx: {
      locale: {
        getSystemLanguages: async () => ["zh-Hans-CN"],
        setLanguage: async (locale: string) => {
          nativeLanguages.push(locale);
        },
      },
    },
  });
  let dispose = await initializeLanguage(dom.window as unknown as Window);
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () =>
      root.render(
        h(React.Fragment, {}, h(LanguageSettings), h(ConversationProbe)),
      ),
    );
    assert.equal(document.documentElement.lang, "zh-CN");
    assert.equal(document.documentElement.dir, "ltr");
    assert.ok(document.querySelector('button[aria-label="语言"]'));
    assert.match(document.body.textContent!, /跟随系统/);
    const draft = document.querySelector("textarea")!;
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('button[role="combobox"]')!
        .click();
    });
    const english = document.querySelector<HTMLElement>(
      '[role="option"][data-value="en"]',
    )!;
    assert.ok(english);
    await act(async () => english.click());
    assert.equal(document.documentElement.lang, "en");
    assert.ok(document.querySelector('button[aria-label="Language"]'));
    assert.equal(dom.window.localStorage.getItem(LANGUAGE_STORAGE_KEY), "en");
    assert.equal(
      document.querySelector("textarea"),
      draft,
      "language switching must not remount the conversation",
    );
    assert.equal(draft.value, "Keep my <draft> 原文");
    await act(async () => root.unmount());
    dispose();
    dispose = await initializeLanguage(dom.window as unknown as Window);
    assert.equal(getLanguageController().getPreference(), "en");
    assert.equal(document.documentElement.lang, "en");
    await act(async () => getLanguageController().setPreference("system"));
    assert.equal(document.documentElement.lang, "zh-CN");
    assert.ok(nativeLanguages.includes("zh-CN"));
    assert.ok(nativeLanguages.includes("en"));
  } finally {
    dispose();
    await i18n.changeLanguage("en");
    dom.window.close();
  }
});
