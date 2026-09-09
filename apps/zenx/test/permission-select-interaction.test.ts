import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
Object.assign(globalThis, { React });
const { PermissionSelect } =
  await import("../src/renderer/src/PermissionSelect.js");

test("permission selector exposes three modes, waits for confirmed state and shows failures", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const changes: string[] = [];
  const render = async (
    switching = false,
    error: string | null = null,
    legacyApproval = false,
  ) =>
    React.act(async () =>
      root.render(
        React.createElement(PermissionSelect, {
          value: "danger-full-access",
          disabled: false,
          switching,
          error,
          legacyApproval,
          onChange: (mode) => changes.push(mode),
        }),
      ),
    );
  try {
    await render();
    const select = container.querySelector<HTMLButtonElement>(
      '[aria-label="File permissions"]',
    )!;
    assert.equal(select.textContent, "Full access");
    await React.act(async () => select.click());
    const options = [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"]',
      ),
    ];
    assert.deepEqual(
      options.map((option) => option.querySelector("strong")?.textContent),
      ["Read only", "Workspace write", "Full access"],
    );
    assert.equal(options[2]?.getAttribute("aria-checked"), "true");
    assert.equal(document.activeElement, options[2]);
    await React.act(async () =>
      options[2]?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      ),
    );
    assert.equal(document.activeElement, options[0]);
    await React.act(async () => options[0]?.click());
    assert.deepEqual(changes, ["read-only"]);
    assert.equal(select.textContent, "Full access");
    assert.equal(document.activeElement, select);
    assert.equal(container.querySelector('[role="menu"]'), null);
    await render(true);
    assert.equal(select.disabled, true);
    assert.ok(container.querySelector('[role="status"]'));
    await render(false, "Wait for the running tools to finish");
    assert.equal(select.textContent, "Full access");
    assert.match(
      container.querySelector('[role="alert"]')!.textContent!,
      /running tools/,
    );
    assert.equal(
      select.getAttribute("aria-describedby"),
      "composer-permission-error",
    );
    await React.act(async () => select.click());
    await React.act(async () =>
      document.activeElement?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    assert.equal(container.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, select);
    await React.act(async () => select.click());
    await React.act(async () =>
      document.body.dispatchEvent(
        new dom.window.Event("pointerdown", { bubbles: true }),
      ),
    );
    assert.equal(container.querySelector('[role="menu"]'), null);
    assert.deepEqual(changes, ["read-only"]);
    await render(false, null, true);
    assert.equal(select.textContent, "Approval required");
    await React.act(async () => select.click());
    assert.equal(container.querySelector('[aria-checked="true"]'), null);
    await render(true);
    assert.equal(container.querySelector('[role="menu"]'), null);
  } finally {
    await React.act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
