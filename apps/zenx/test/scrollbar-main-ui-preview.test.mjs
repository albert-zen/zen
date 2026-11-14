import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { observeScrollbar } from "../scripts/scrollbar-main-ui-preview.mjs";
import { readingPathsChanged } from "../scripts/reading-main-ui-preview.mjs";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
test("observer reports production state without creating controls or changing scroll", () => {
  const dom = new JSDOM(
    '<div class="messages" data-scrollbar-active><button aria-label="Copy">Copy</button></div>',
    { runScripts: "outside-only" },
  );
  try {
    const e = dom.window.document.querySelector(".messages");
    Object.defineProperties(e, {
      scrollHeight: { value: 900 },
      clientHeight: { value: 400 },
    });
    dom.window.document.documentElement.setAttribute(
      "data-scrollbar-autohide",
      "",
    );
    dom.window.getComputedStyle = () => ({ backgroundColor: "transparent" });
    const html = dom.window.document.body.innerHTML;
    const state = dom.window.eval(`(${observeScrollbar.toString()})()`);
    assert.equal(state.active, true);
    assert.equal(state.autohide, true);
    assert.equal(state.scrollHeight, 900);
    assert.equal(state.clientHeight, 400);
    assert.equal(state.focusInside, false);
    assert.equal(state.rect.width, 0, "JSDOM is not visual proof");
    assert.equal(dom.window.document.body.innerHTML, html);
  } finally {
    dom.window.close();
  }
});
test("state probes use native inputs and preserve the actual production scroller", async () => {
  const s = await read("../scripts/scrollbar-main-ui-preview.mjs");
  for (const state of [
    "idle",
    "edge-hover-held",
    "wheel",
    "wheel-settled",
    "keyboard-focus-held",
    "keyboard-focus-exit",
    "native-thumb-drag",
    "drag-released",
  ])
    assert(s.includes(`save("${state}")`), state);
  assert(s.includes("Input.dispatchMouseEvent"));
  assert(s.includes('dispatchNavigationKey(send, "Tab"'));
  assert(
    !/\.focus\(|\.dispatchEvent\(|\.scrollTop\s*=/.test(
      s.replace(/\/\*[^]*?\*\//g, ""),
    ),
  );
});
test("probe files and production lifecycle select the existing short workflow", async () => {
  const paths = [
    "apps/zenx/scripts/scrollbar-main-ui-preview.mjs",
    "apps/zenx/test/scrollbar-main-ui-preview.test.mjs",
    "apps/zenx/src/renderer/src/scrollbar-visibility.ts",
  ];
  const yaml = await read("../../../.github/workflows/desktop-reading-ui.yml");
  for (const p of paths) {
    assert(readingPathsChanged([p]));
    assert(yaml.includes(`      - ${p}\n`));
  }
});
