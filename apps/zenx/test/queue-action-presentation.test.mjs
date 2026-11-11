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

test("pending group timing stays sticky with space reserved for keyboard focus", () => {
  const dom = new JSDOM(
    `<style>${source}</style><div class="pending-tray"><section class="queue-shelf"><div class="queue-shelf-header">After this turn · 2 messages</div></section></div>`,
  );
  try {
    const heading = dom.window.getComputedStyle(
      dom.window.document.querySelector(".queue-shelf-header"),
    );
    assert.equal(heading.position, "sticky");
    assert.equal(heading.top, "0px");
    assert.equal(heading.zIndex, "1");
    const tray = dom.window.getComputedStyle(
      dom.window.document.querySelector(".pending-tray"),
    );
    assert.equal(tray.scrollPaddingBlockStart, "64px");
  } finally {
    dom.window.close();
  }
});

test("desktop queue actions reserve space for visible send text without shrinking targets", () => {
  assert.match(
    source,
    /@media \(pointer: fine\) and \(min-width: 481px\)\s*\{\s*\.pending-tray \.queue-row-actions\s*\{\s*max-width: 192px;/u,
  );

  assert.match(
    source,
    /\.pending-tray \.queue-row-actions\s*\{[^}]*flex-wrap: wrap;/u,
  );
  // Media query matching and resulting row height are browser acceptance, not
  // simulated by JSDOM. The interaction suite covers exact handlers and focus.
});

test("narrow queue separates reading and actions without hiding controls or growing short windows", () => {
  assert.match(
    source,
    /@media \(max-width: 480px\)\s*\{\s*\.pending-tray \.queue-row-main\s*\{\s*flex-direction: column;/u,
  );
  assert.match(
    source,
    /\.pending-tray \.queue-row-content,\s*\.pending-tray \.queue-row-actions\s*\{\s*width: 100%;/u,
  );
  assert.match(
    source,
    /@media \(max-width: 480px\) and \(min-height: 700px\)\s*\{\s*\.pending-tray\s*\{\s*max-height: min\(360px, 40dvh\);/u,
  );
  assert.match(source, /max-height: min\(240px, 30dvh\);/u);
  assert.doesNotMatch(source, /max-width: 88px;/u);
  // Browser capture must check complete action rows, full-width message text,
  // focus visibility, 390px light/dark, and coarse-pointer 44px targets.
});
