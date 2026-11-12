import "./dom-primitives.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
Object.assign(globalThis, { React });
const { PermissionSelect } =
  await import("../src/renderer/src/PermissionSelect.js");

test("fixed inherited permissions remain readable, named and noninteractive for every mode", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  const changes: string[] = [];
  try {
    for (const [value, label, legacyApproval] of [
      ["read-only", "Read only", false],
      ["workspace-write", "Workspace write", false],
      ["danger-full-access", "Full access", false],
      ["danger-full-access", "Approval required", true],
    ] as const) {
      await React.act(async () =>
        root.render(
          React.createElement(PermissionSelect, {
            value,
            legacyApproval,
            disabled: false,
            displayOnly: true,
            onChange: (mode) => changes.push(mode),
          }),
        ),
      );
      const button = document.querySelector<HTMLButtonElement>(
        '[aria-label="File permissions"]',
      )!;
      assert.equal(button.textContent, label);
      assert.equal(button.disabled, true);
      assert.ok(button.classList.contains("permission-readonly"));
      assert.equal(button.querySelector("svg"), null);
      assert.equal(button.getAttribute("aria-haspopup"), null);
      assert.equal(button.getAttribute("aria-expanded"), null);
      await React.act(async () => {
        button.click();
        button.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "ArrowDown",
            bubbles: true,
          }),
        );
      });
      assert.equal(document.querySelector('[role="menu"]'), null);
      assert.deepEqual(changes, []);
    }
    // Ordinary unavailable editors retain their existing treatment.
    await React.act(async () =>
      root.render(
        React.createElement(PermissionSelect, {
          value: "read-only",
          disabled: true,
        }),
      ),
    );
    const button = document.querySelector<HTMLButtonElement>(
      '[aria-label="File permissions"]',
    )!;
    assert.equal(button.disabled, true);
    assert.equal(button.classList.contains("permission-readonly"), false);
    assert.ok(button.querySelector("svg"));
    assert.equal(button.getAttribute("aria-haspopup"), "menu");
  } finally {
    await React.act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test("preview contrast uses shared secondary tokens without changing global disabled controls or type size", () => {
  const css = readFileSync(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const rule = (selector: string) =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].find(
      (match) => match[1]?.trim() === selector,
    )?.[2] ?? "";
  const permission = rule(".permission-trigger.permission-readonly:disabled");
  assert.match(permission, /color: var\(--color-text-secondary\)/u);
  assert.match(permission, /opacity: 1/u);
  assert.match(permission, /cursor: default/u);
  const note = rule(".side-chat-context-note");
  assert.match(note, /color: var\(--color-text-secondary\)/u);
  assert.match(note, /font-size: 12px/u);
  assert.match(rule("button:disabled"), /opacity: 0.45/u);
});
