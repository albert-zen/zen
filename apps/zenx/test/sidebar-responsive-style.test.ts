import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

test("narrow desktop Thread rows reserve the overflow menu column", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const mediumStart = styles.indexOf("@media (max-width: 820px)");
  const mobileStart = styles.indexOf("@media (max-width: 640px)");
  assert.notEqual(mediumStart, -1);
  assert.ok(mobileStart > mediumStart);
  assert.match(
    styles.slice(mediumStart, mobileStart),
    /\.thread-row\s*\{\s*padding: 10px 46px 10px 10px;/u,
  );
  assert.match(
    styles.slice(mobileStart),
    /\.thread-row\s*\{\s*padding-right: 52px;/u,
  );
});

test("Thread overflow stays inert until hover, focus, or an open menu", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /\.thread-menu-trigger\s*\{[^}]*opacity: 0;[^}]*visibility: hidden;[^}]*pointer-events: none;/su,
  );
  assert.match(styles, /\.thread-row-shell:hover \.thread-menu-trigger/u);
  assert.match(
    styles,
    /\.thread-row-shell:focus-within \.thread-menu-trigger/u,
  );
  assert.match(
    styles,
    /\.thread-menu-trigger\[aria-expanded="true"\]\s*\{[^}]*opacity: 1;[^}]*visibility: visible;[^}]*pointer-events: auto;/su,
  );
  assert.doesNotMatch(
    styles,
    /\.thread-row\.selected[^}]*\.thread-menu-trigger/su,
  );
});

test("whole rows expose drag affordance without visible reorder handles", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(styles, /\.reorder-handle/u);
  assert.match(
    styles,
    /\.project-header\.reorderable > \.project-toggle,[\s\S]*\.thread-row-shell\.reorderable > \.thread-row\s*\{[^}]*cursor:\s*grab;/u,
  );
});

test("Settings footer hugs its single navigation row", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /\.sidebar-footer\s*\{[^}]*min-height:\s*50px;[^}]*padding:\s*5px 8px;/su,
  );
});

test("side panel keeps stable corner controls and an interruptible width transition", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /\.thread-panel-toggle\s*\{[^}]*position:\s*fixed;[^}]*right:\s*8px;/su,
  );
  assert.match(
    styles,
    /\.workspace:has\(> \.auxiliary-panel\)\s*\{[^}]*display:\s*flex;/su,
  );
  assert.match(
    styles,
    /\.auxiliary-panel\[data-open="false"\]\s*\{[^}]*flex-basis:\s*0;[^}]*width:\s*0;[^}]*min-width:\s*0;/su,
  );
  assert.doesNotMatch(
    styles,
    /\.auxiliary-heading \.auxiliary-close-button\s*\{[^}]*display:\s*none;/su,
  );
  assert.match(
    styles,
    /:root\[data-platform="win32"\] \.thread-panel-toggle\s*\{[^}]*right:\s*calc\(var\(--windows-control-region\) \+ 4px\);/su,
  );
  const narrow = styles.slice(styles.indexOf("@media (max-width: 720px)"));
  assert.match(
    narrow,
    /\.workspace:has\(> \.auxiliary-panel\)\s*\{[^}]*display:\s*block;/su,
  );
  assert.match(
    narrow,
    /:root\[data-platform="win32"\] \.thread-panel-toggle\s*\{[^}]*top:\s*calc\(var\(--native-titlebar-height\) \+ 4px\);[^}]*right:\s*8px;/su,
  );
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*:root\s*\{[^}]*--motion-layout:\s*0ms;/su,
  );
});

test("plugin page and panel collapse to one usable narrow desktop column", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const narrow = styles.slice(styles.indexOf("@media (max-width: 760px)"));
  assert.match(
    narrow,
    /\.plugin-page-scroll\s*\{\s*grid-template-columns: minmax\(0, 1fr\);\s*padding: 14px;/su,
  );
});

test("592px Settings reflows tabs and moves the sidebar off canvas", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const medium = styles.slice(
    styles.indexOf("@media (max-width: 820px)"),
    styles.indexOf("@media (max-width: 720px)"),
  );
  const narrow = styles.slice(
    styles.indexOf("@media (max-width: 720px)"),
    styles.indexOf("@media (max-width: 640px)"),
  );
  const mobile = styles.slice(
    styles.indexOf("@media (max-width: 640px)"),
    styles.indexOf("@media (max-width: 380px)"),
  );

  assert.match(
    medium,
    /\.settings-layout\s*\{[^}]*display:\s*block;[^}]*min-height:\s*0;/su,
  );
  assert.match(
    medium,
    /\.settings-nav\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/su,
  );
  assert.doesNotMatch(medium, /\.settings-nav\s*\{[^}]*overflow-x:/su);
  assert.match(
    narrow,
    /\.app-shell\s*\{[^}]*--sidebar-track:\s*0px;[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/su,
  );
  assert.match(
    narrow,
    /\.sidebar\s*\{[^}]*position:\s*absolute;[^}]*transform:\s*translateX\(-102%\);[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/su,
  );
  assert.match(
    narrow,
    /\.sidebar\.open\s*\{[^}]*visibility:\s*visible;[^}]*pointer-events:\s*auto;/su,
  );
  assert.match(
    narrow,
    /\.workspace\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*2;/su,
  );
  assert.match(
    mobile,
    /\.settings-nav\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/su,
  );
});

test("narrow global notices wrap long errors and keep recovery controls usable", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /\.app-notice span\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/su,
  );
  assert.match(
    styles,
    /@media \(max-width: 420px\)\s*\{[^}]*\.app-notice\s*\{[^}]*flex-wrap:\s*wrap;/su,
  );
  assert.match(styles, /\.app-notice button\s*\{[^}]*min-height:\s*44px;/su);
});

test("mobile sidebar opening clears a persisted desktop collapse", async () => {
  const app = await readFile(
    new URL("../src/renderer/src/App.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    app,
    /const openSidebar = \(\) => \{\s*setSidebarCollapsed\(false\);\s*setSidebarOpen\(true\);/su,
  );
  assert.doesNotMatch(app, /onOpenSidebar=\{\(\) => setSidebarOpen\(true\)\}/u);
});

test("200% text zoom keeps Settings copy and Appearance controls reflowable", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const medium = styles.slice(
    styles.indexOf("@media (max-width: 820px)"),
    styles.indexOf("@media (max-width: 720px)"),
  );
  const mobile = styles.slice(
    styles.indexOf("@media (max-width: 640px)"),
    styles.indexOf("@media (max-width: 380px)"),
  );
  const zoomed = styles.slice(
    styles.indexOf("@media (max-width: 380px)"),
    styles.indexOf(
      "@media (prefers-reduced-motion: reduce)",
      styles.indexOf("@media (max-width: 380px)"),
    ),
  );

  assert.match(
    medium,
    /\.settings-nav button\s*\{[^}]*min-height:\s*44px;[^}]*height:\s*auto;[^}]*line-height:\s*1\.35;/su,
  );
  assert.match(
    mobile,
    /\.product-page\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/su,
  );
  assert.match(
    mobile,
    /\.page-title h1,\s*\.page-title p\s*\{[^}]*overflow:\s*visible;[^}]*white-space:\s*normal;/su,
  );
  assert.match(
    mobile,
    /\.appearance-editor-grid\s*\{[^}]*grid-template-columns:\s*1fr;/su,
  );
  assert.match(
    mobile,
    /\.appearance-control-row\s*\{[^}]*grid-template-columns:\s*1fr;/su,
  );
  assert.match(
    zoomed,
    /\.settings-nav,\s*\.appearance-options,\s*\.appearance-preset-options,\s*\.appearance-accent-options\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/su,
  );
});

test("Linux overlay controls reserve space for the workspace toggle", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /:root\[data-platform="linux"\] \.window-titlebar,\s*:root\[data-platform="win32"\] \.window-titlebar\s*\{[^}]*padding-right:\s*var\(--windows-control-region\);/su,
  );
  assert.match(
    styles,
    /:root\[data-platform="linux"\] \.thread-panel-toggle,\s*:root\[data-platform="win32"\] \.thread-panel-toggle\s*\{[^}]*right:\s*calc\(var\(--windows-control-region\) \+ 4px\);/su,
  );
});

test("Linux workspace heading and narrow toggle stay clear of native window controls", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /:root:is\(\[data-platform="linux"\], \[data-platform="win32"\]\) \.auxiliary-heading\s*\{[^}]*padding-right:\s*8px;/su,
  );
  const lastToggle = styles.lastIndexOf(
    ':root[data-platform="linux"] .thread-panel-toggle',
  );
  assert.ok(lastToggle > styles.indexOf("/* Rooms:"));
  assert.match(
    styles.slice(lastToggle),
    /top:\s*calc\(var\(--native-titlebar-height\) \+ 4px\);\s*right:\s*8px;/u,
  );
});

test("coarse-pointer child row and actions keep 44px minimum targets after the base cascade", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/subagents.css", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(
    '<style></style><div class="subagent-tree-entry"><button class="subagent-tree-row">Child</button><button class="subagent-sidebar-pin">Pin</button></div><button class="subagent-create-button">Side chat</button>',
  );
  try {
    const style = dom.window.document.querySelector("style")!;
    style.textContent = styles;
    const rules = [...style.sheet!.cssRules];
    const coarse = rules.find(
      (rule): rule is CSSMediaRule =>
        rule.type === dom.window.CSSRule.MEDIA_RULE &&
        (rule as CSSMediaRule).conditionText === "(pointer: coarse)",
    );
    assert.ok(coarse);
    const targets = [...coarse.cssRules].find(
      (rule): rule is CSSStyleRule =>
        rule.type === dom.window.CSSRule.STYLE_RULE &&
        (rule as CSSStyleRule).style.getPropertyValue("min-height") === "44px",
    );
    assert.ok(targets);
    assert.ok(
      targets.selectorText
        .split(",")
        .map((selector) => selector.trim())
        .includes(".subagent-tree-entry > .subagent-tree-row"),
      "touch rule must match the base row selector specificity",
    );
    // JSDOM does not evaluate pointer media features: materialize that matched
    // media block after its real base rules, then inspect the computed cascade.
    style.textContent =
      rules
        .filter((rule) => rule.type === dom.window.CSSRule.STYLE_RULE)
        .map((rule) => rule.cssText)
        .join("\n") +
      "\n" +
      [...coarse.cssRules].map((rule) => rule.cssText).join("\n");
    for (const selector of [
      ".subagent-tree-row",
      ".subagent-sidebar-pin",
      ".subagent-create-button",
    ]) {
      assert.equal(
        dom.window.getComputedStyle(
          dom.window.document.querySelector(selector)!,
        ).minHeight,
        "44px",
        selector,
      );
    }
  } finally {
    dom.window.close();
  }
});
