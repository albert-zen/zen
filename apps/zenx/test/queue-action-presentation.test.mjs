import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const source = await readFile(
  new URL("../src/renderer/src/queued-messages.css", import.meta.url),
  "utf8",
);

test("queue action colors distinguish available, disabled and pending without extra dimming", () => {
  // Fixed colors test token selection and CSS precedence, not theme contrast.
  const colors = {
    "--color-text-primary": "rgb(10, 20, 30)",
    "--color-text-secondary": "rgb(40, 50, 60)",
    "--color-text-muted": "rgb(70, 80, 90)",
    "--color-text-disabled": "rgb(100, 110, 120)",
  };
  const css = source.replace(
    /var\((--color-text-(?:primary|secondary|muted|disabled))\)/gu,
    (_, name) => colors[name],
  );
  const dom = new JSDOM(`<style>${css}</style><section class="queue-shelf" />`);
  try {
    const shelf = dom.window.document.querySelector("section");
    for (const action of ["edit", "cancel", "move", "steer"]) {
      for (const disabled of [false, true]) {
        const button = dom.window.document.createElement("button");
        button.className = `queue-row-${action}`;
        button.disabled = disabled;
        shelf.append(button);
        const style = dom.window.getComputedStyle(button);
        assert.equal(
          style.color,
          disabled
            ? colors["--color-text-disabled"]
            : colors[
                action === "steer"
                  ? "--color-text-primary"
                  : "--color-text-muted"
              ],
          `${action}, disabled=${disabled}`,
        );
        assert.equal(style.minWidth, "44px");
        assert.equal(style.minHeight, "44px");
        button.remove();
      }
    }
    for (const action of ["edit", "cancel"]) {
      const button = dom.window.document.createElement("button");
      button.className = `queue-row-${action} is-pending`;
      button.disabled = true;
      shelf.append(button);
      assert.equal(
        dom.window.getComputedStyle(button).color,
        colors["--color-text-secondary"],
        `${action}: pending status stays readable despite its disabled action`,
      );
    }
    // JSDOM does not evaluate pointer media conditions. Guard the removed idle
    // opacity separately; actual browser capture covers fine-pointer rendering.
    assert.doesNotMatch(
      source,
      /\.queue-row-(?:edit|cancel)[^{]*\{[^}]*opacity:\s*(?:0?\.)/u,
    );
    assert.match(source, /\.queue-shelf button:focus-visible/u);
  } finally {
    dom.window.close();
  }
});
