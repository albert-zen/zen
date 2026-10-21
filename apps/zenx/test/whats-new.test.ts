import "./dom-primitives.js";
import { waitForFocus } from "./wait-for-focus.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { WhatsNew } from "../src/renderer/src/WhatsNew.js";
import { RELEASE_NOTES } from "../src/renderer/src/release-notes.js";
import { i18n } from "../src/renderer/src/i18n.js";

test("bundled notes have stable unique identities, descending calendar dates and both languages", () => {
  const ids = RELEASE_NOTES.flatMap((release) => [
    release.id,
    ...release.items.map((item) => item.id),
  ]);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    RELEASE_NOTES.map((r) => r.date),
    RELEASE_NOTES.map((r) => r.date)
      .sort()
      .reverse(),
  );
  for (const release of RELEASE_NOTES) {
    assert.match(release.date, /^\d{4}-\d{2}-\d{2}$/);
    for (const item of release.items) {
      assert.ok(item.en.length > 0);
      assert.ok(item.zh.length > 0);
    }
  }
});

test("notes open only on request, close by Escape and button, restore focus and localize", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => {
      await i18n.changeLanguage("en");
      root.render(React.createElement(WhatsNew));
    });
    assert.ok(
      document.querySelector('[role="dialog"]') === null,
      "Dialog is closed",
    );
    const trigger =
      document.querySelector<HTMLButtonElement>(".whats-new-trigger")!;
    trigger.focus();
    await act(async () => trigger.click());
    assert.equal(
      document.querySelector('[role="dialog"]')?.getAttribute("data-state"),
      "open",
    );
    assert.match(document.body.textContent!, /Thread names stay consistent/);
    assert.ok(
      document
        .querySelector('[role="dialog"]')
        ?.contains(document.activeElement),
    );
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await act(async () => waitForFocus(trigger));
    assert.ok(
      document.querySelector('[role="dialog"]') === null,
      "Dialog is closed",
    );
    assert.ok(
      document.activeElement === trigger,
      "Focus returns to notes entry",
    );
    await act(async () => {
      await i18n.changeLanguage("zh-CN");
      trigger.click();
    });
    assert.match(document.body.textContent!, /更新内容/);
    assert.match(document.body.textContent!, /侧边栏、会话和引用选择器/);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="关闭更新内容"]')!
        .click(),
    );
    await act(async () => waitForFocus(trigger));
    assert.ok(
      document.querySelector('[role="dialog"]') === null,
      "Dialog is closed",
    );
    assert.ok(
      document.activeElement === trigger,
      "Focus returns to notes entry",
    );
  } finally {
    await act(async () => root.unmount());
    await i18n.changeLanguage("en");
    dom.window.close();
  }
});

test("shell Escape respects a dialog-consumed event before closing the narrow sidebar", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../src/renderer/src/App.tsx", import.meta.url),
    "utf8",
  );
  // Source contract for the App integration; dialog keyboard/focus behavior is
  // separately exercised above and by the actual-component browser fixture.
  assert.match(
    source,
    /const close = \(event: KeyboardEvent\) => \{\s*if \(event\.key !== "Escape" \|\| event\.defaultPrevented\) return;\s*if \(projectPickerIntent !== null\) closeProjectPicker\(\);\s*else if \(sidebarOpen\) setSidebarOpen\(false\);/,
  );
});
