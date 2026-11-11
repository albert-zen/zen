import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const source = await readFile(
  new URL("../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const related = source.slice(
  source.indexOf("/* Current-thread aliases"),
  source.indexOf(".thread-row.inbox"),
);
for (const location of ["project-group", "pinned-thread-group"]) {
  test(`Recent alias is quieter only while ${location} renders the current item`, () => {
    const css = related
      .replaceAll("var(--surface-wash)", "rgb(230, 230, 230)")
      .replaceAll("var(--surface-wash-strong)", "rgb(220, 220, 220)");
    const dom = new JSDOM(
      `<style>.thread-row.selected {background:rgb(200,200,240)} ${css}</style><aside class="sidebar"><section class="${location}"><button class="thread-row selected" aria-current="page">Current</button></section><section class="recent-thread-group"><button class="thread-row selected" aria-current="page">Current</button></section></aside>`,
    );
    try {
      const primary = dom.window.document.querySelector(
        `.${location} .selected`,
      );
      const recent = dom.window.document.querySelector(
        ".recent-thread-group .selected",
      );
      assert.equal(
        dom.window.getComputedStyle(primary).backgroundColor,
        "rgb(200, 200, 240)",
      );
      assert.equal(
        dom.window.getComputedStyle(recent).backgroundColor,
        "rgb(230, 230, 230)",
      );
      primary.remove();
      assert.equal(
        dom.window.getComputedStyle(recent).backgroundColor,
        "rgb(200, 200, 240)",
      );
      assert.equal(recent.getAttribute("aria-current"), "page");
      assert.equal(recent.tabIndex, 0);
    } finally {
      dom.window.close();
    }
  });
}
