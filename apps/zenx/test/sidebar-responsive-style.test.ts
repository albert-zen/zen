import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { SIDEBAR_DEFAULT_WIDTH } from "../src/renderer/src/sidebar-width.js";

test("Thread rows reserve factual status space and reveal actions over a surface fade", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /padding-inline-end: calc\(10px \+ var\(--thread-state-space, 0px\)\);/u,
  );
  assert.match(
    styles,
    /background: linear-gradient\(\s*to right,\s*transparent,[^;]*var\(--thread-row-surface\) 32px\s*\);/u,
  );
  assert.match(styles, /@media \(hover: none\), \(pointer: coarse\)/u);
  // Other controls have their own coarse-pointer blocks; inspect the block
  // containing Thread actions rather than relying on its position in the file.
  const touchStyles = [
    ...styles.matchAll(
      /@media \(hover: none\), \(pointer: coarse\)\s*\{(?:[^{}]|\{[^{}]*\})*\}/gu,
    ),
  ].find(([block]) => block.includes(".thread-menu-trigger"))?.[0];
  assert.ok(touchStyles, "Thread actions retain their coarse-pointer rules");
  assert.match(
    touchStyles,
    /\.thread-menu-trigger\s*\{[^}]*width: 44px;[^}]*height: 44px;[^}]*pointer-events: auto;/u,
  );

  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[^{]*\{\s*\.thread-running-spinner\s*\{[^}]*animation: none;/u,
  );
  assert.doesNotMatch(styles, /padding: 10px 46px|padding-right: 52px/u);
});

test("Thread status and actions share icon size and spacing with a full-height rounded fade", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    styles,
    /\.thread-status-rail\s*\{[^}]*inset-block: 0;[^}]*inset-inline-end: 0;[^}]*gap: 0;[^}]*border-radius: inherit;[^}]*border-start-start-radius: 32px 50%;[^}]*border-end-start-radius: 32px 50%;/u,
  );
  assert.doesNotMatch(
    styles.match(/\.thread-status-rail\s*\{[^}]*\}/u)?.[0] ?? "",
    /radius: 999px/u,
    "oversized capsule radii must not flatten the opposite row corners",
  );
  assert.match(
    styles,
    /\.thread-status-slot\s*\{[^}]*flex: 0 0 28px;[^}]*width: 28px;[^}]*height: 28px;/u,
  );
  assert.match(
    styles,
    /\.thread-status-slot > svg,\s*\.thread-status-rail \.thread-menu-trigger > svg\s*\{[^}]*width: 16px;[^}]*height: 16px;/u,
  );
  assert.match(
    styles,
    /\.thread-status-rail\s+\.thread-menu-trigger\s*\{[^}]*width: 28px;/u,
  );
  assert.match(
    styles,
    /\.thread-status-rail \.thread-menu-trigger\s*\{[^}]*height: 28px;[^}]*border-radius: 50%;/u,
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

test("non-mac narrow startup opener clears the second native titlebar row", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const narrowBlocks = [
    ...styles.matchAll(
      /@media \(max-width: 720px\)\s*\{(?:[^{}]|\{[^{}]*\})*\}/gu,
    ),
  ];
  assert.ok(
    narrowBlocks.some(([block]) =>
      /:root:is\(\[data-platform="linux"\], \[data-platform="win32"\]\)\s+\.new-thread-draft-mobile\s*\{\s*top: calc\(var\(--native-titlebar-height\) \+ 8px\);\s*\}/u.test(
        block,
      ),
    ),
    "the absolute opener must include the surface's native titlebar inset",
  );
  assert.match(
    styles,
    /\.new-thread-draft-mobile\s*\{[^}]*top: 8px;/u,
    "macOS retains the original opener offset",
  );
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

test("shell owns the sidebar width default before and after the resizer mounts", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/styles.css", import.meta.url),
    "utf8",
  );
  const shell = styles.match(/\.app-shell\s*\{([^}]+)\}/su)?.[1];
  assert.ok(shell);
  const defaultWidth = shell.match(/--sidebar-width:\s*(\d+)px;/u)?.[1];
  assert.equal(Number(defaultWidth), SIDEBAR_DEFAULT_WIDTH);
  assert.match(shell, /--sidebar-track:\s*var\(--sidebar-width\);/u);
});

test("Room unread numbers center their cap box without font-leading bias", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/room-conversations.css", import.meta.url),
    "utf8",
  );
  const badge = styles.match(/\.room-unread-count\s*\{[^}]*\}/u)?.[0] ?? "";
  assert.match(badge, /display: inline-grid;/u);
  assert.match(badge, /place-items: center;/u);
  assert.match(badge, /text-align: center;/u);
  assert.match(badge, /text-indent: 0;/u);
  assert.match(badge, /line-height: 1;/u);
  const value = styles.match(/\.room-unread-value\s*\{[^}]*\}/u)?.[0] ?? "";
  assert.match(value, /text-box-trim: trim-both;/u);
  assert.match(value, /text-box-edge: cap alphabetic;/u);
});

test("Subagents row and per-thread visibility switch retain coarse-pointer targets and focus styling", async () => {
  const styles = await readFile(
    new URL("../src/renderer/src/subagents.css", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(
    '<style></style><div class="subagent-tree-entry"><button class="subagent-tree-row">Child</button><div class="subagent-sidebar-control"><button class="subagent-sidebar-visibility" role="switch">Hidden</button></div></div>',
  );
  try {
    const style = dom.window.document.querySelector("style")!;
    style.textContent = styles;
    const rules = [...style.sheet!.cssRules];
    const coarse = rules.filter(
      (rule): rule is CSSMediaRule =>
        rule.type === dom.window.CSSRule.MEDIA_RULE &&
        (rule as CSSMediaRule).conditionText === "(pointer: coarse)",
    );
    assert.ok(coarse.length > 0);
    // JSDOM cannot evaluate pointer media features. Expand every matching block
    // in its original cascade position, retaining later normal-rule overrides.
    style.textContent = rules
      .flatMap((rule) =>
        rule.type === dom.window.CSSRule.STYLE_RULE
          ? [rule.cssText]
          : coarse.includes(rule as CSSMediaRule)
            ? [...(rule as CSSMediaRule).cssRules].map((child) => child.cssText)
            : [],
      )
      .join("\n");
    for (const selector of [
      ".subagent-tree-row",
      ".subagent-sidebar-visibility",
    ]) {
      const computed = dom.window.getComputedStyle(
        dom.window.document.querySelector(selector)!,
      );
      assert.equal(computed.minHeight, "44px", selector);
      assert.equal(computed.minWidth, "44px", selector);
    }
    assert.match(styles, /\.subagent-sidebar-visibility:focus-visible/);
    assert.doesNotMatch(
      styles,
      /\.subagent-sidebar-visibility[^}]*opacity:\s*0[;\s]/,
    );
  } finally {
    dom.window.close();
  }
});
