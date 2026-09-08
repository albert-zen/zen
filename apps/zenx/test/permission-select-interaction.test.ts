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
  const render = async (switching = false, error: string | null = null) =>
    React.act(async () =>
      root.render(
        React.createElement(PermissionSelect, {
          value: "danger-full-access",
          disabled: false,
          switching,
          error,
          onChange: (mode) => changes.push(mode),
        }),
      ),
    );
  try {
    await render();
    const select = container.querySelector("select")!;
    assert.equal(select.value, "danger-full-access");
    assert.deepEqual(
      [...select.options].map((option) => option.value),
      ["read-only", "workspace-write", "danger-full-access"],
    );
    select.focus();
    assert.equal(document.activeElement, select);
    await React.act(async () => {
      select.value = "read-only";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.deepEqual(changes, ["read-only"]);
    await render(true);
    assert.equal(select.disabled, true);
    assert.ok(container.querySelector('[role="status"]'));
    await render(false, "Wait for the running tools to finish");
    assert.equal(select.value, "danger-full-access");
    assert.match(
      container.querySelector('[role="alert"]')!.textContent!,
      /running tools/,
    );
    assert.equal(
      select.getAttribute("aria-describedby"),
      "composer-permission-error",
    );
  } finally {
    await React.act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
