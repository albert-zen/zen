import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rendererRoot = new URL("../src/renderer/src/", import.meta.url);

test("Windows and Linux share one full-width separator beneath the native caption row", async () => {
  const styles = await readFile(new URL("styles.css", rendererRoot), "utf8");
  assert.match(
    styles,
    /:root:is\(\[data-platform="linux"\], \[data-platform="win32"\]\)\s*\.window-titlebar::after\s*\{[^}]*top:\s*calc\(var\(--native-titlebar-height\) - 1px\);[^}]*right:\s*0;[^}]*left:\s*0;[^}]*height:\s*1px;[^}]*background:\s*var\(--color-border-subtle\);[^}]*pointer-events:\s*none;/su,
  );
});

test("integrated title bar aligns the product controls and conversation row around native chrome", async () => {
  const [app, sidebar, styles, main] = await Promise.all([
    readFile(new URL("App.tsx", rendererRoot), "utf8"),
    readFile(new URL("Sidebar.tsx", rendererRoot), "utf8"),
    readFile(new URL("styles.css", rendererRoot), "utf8"),
    readFile(new URL("../src/main/index.ts", import.meta.url), "utf8"),
  ]);

  assert.match(app, /className="window-titlebar"/u);
  assert.match(app, /className="window-titlebar-product"/u);
  assert.match(app, /className="window-titlebar-inbox"/u);
  assert.match(app, /className="window-titlebar-native-actions"/u);
  assert.match(app, /className="window-titlebar-session"/u);
  assert.match(
    app,
    /className="window-titlebar-product"[\s\S]*<ZenXBrand \/>[\s\S]*className="icon-button inbox-button"[\s\S]*className="window-titlebar-native-actions"[\s\S]*className="icon-button sidebar-collapse-button"/u,
  );
  assert.match(app, /aria-pressed=\{mode === "inbox"\}/u);
  assert.match(app, /aria-controls="primary-sidebar"/u);
  assert.match(app, /aria-expanded=\{!sidebarCollapsed\}/u);
  assert.match(
    app,
    /sidebarCollapsed\s*\? i18n\.t\("shell:expandSidebar"\)\s*: i18n\.t\("shell:collapseSidebar"\)/u,
  );
  assert.match(sidebar, /id="primary-sidebar"/u);
  assert.doesNotMatch(sidebar, /className="sidebar-platform-brand"/u);
  assert.doesNotMatch(sidebar, /<ZenXBrand \/>/u);
  assert.doesNotMatch(sidebar, /className="icon-button inbox-button"/u);
  assert.match(styles, /-webkit-app-region: drag;/u);
  assert.match(
    styles,
    /\.window-titlebar button\s*\{[^}]*-webkit-app-region: no-drag;/su,
  );
  assert.match(
    styles,
    /\.app-shell\.sidebar-collapsed\s*\{[^}]*--sidebar-track: 0px;/su,
  );
  assert.match(
    styles,
    /:root\[data-platform="darwin"\] \.window-titlebar-product\s*\{[^}]*top:\s*var\(--native-titlebar-height\);/su,
  );
  assert.match(
    styles,
    /:root\[data-platform="darwin"\] \.window-titlebar-native-actions\s*\{[^}]*left:\s*84px;/su,
  );
  assert.match(
    styles,
    /:root\[data-platform="darwin"\] \.sidebar\s*\{[^}]*padding-top:\s*var\(--product-row-height\);/su,
  );
  assert.match(main, /titleBarStyle: "hidden"/u);
  assert.match(main, /titleBarOverlay:/u);
  assert.match(
    styles,
    /:root\[data-platform="darwin"\] \.window-titlebar-session\s*\{[^}]*grid-column:\s*2;/su,
  );
  assert.match(
    styles,
    /:root\[data-platform="win32"\] \.window-titlebar\s*\{[^}]*padding-right:\s*var\(--windows-control-region\);/su,
  );
  assert.match(
    styles,
    /\.window-titlebar-product\s*\{[^}]*background:\s*var\(--color-surface-sidebar\)/su,
  );
  assert.match(
    styles,
    /\.window-titlebar-session\s*\{[^}]*border-bottom:\s*1px solid var\(--color-border-subtle\);[^}]*background:\s*var\(--color-surface-main\)/su,
  );
  assert.match(
    styles,
    /\.sidebar\s*\{[^}]*background:\s*var\(--color-surface-sidebar\)/su,
  );
  assert.match(
    styles,
    /\.window-titlebar\s*\{[^}]*background:\s*linear-gradient\([^}]*var\(--color-surface-sidebar\)[^}]*var\(--color-surface-main\)/su,
  );
  assert.match(
    styles,
    /\.app-shell::after\s*\{[^}]*top:\s*0;[^}]*bottom:\s*0;[^}]*left:\s*var\(--sidebar-divider-x\);[^}]*width:\s*1px;[^}]*background:\s*var\(--color-border-subtle\)/su,
  );
  assert.match(
    styles,
    /\.window-titlebar-product\s*\{[^}]*border-right:\s*0;/su,
  );
  assert.match(styles, /\.sidebar\s*\{[^}]*border-right:\s*0;/su);
  assert.match(
    styles,
    /\.workspace\s*\{[^}]*background:\s*var\(--color-surface-main\)/su,
  );
  assert.match(styles, /\.workspace-header\s*\{[^}]*border-bottom:\s*0;/su);
});

test("macOS leading controls reserve one shared safe area outside workspace tabs", async () => {
  const styles = await readFile(new URL("styles.css", rendererRoot), "utf8");
  assert.match(styles, /--native-leading-safe-area:\s*128px/u);
  assert.match(styles, /min-width:\s*var\(--native-leading-safe-area\)/u);
  assert.match(
    styles,
    /padding-inline-start:\s*max\(\s*8px,\s*calc\(var\(--native-leading-safe-area\) - 100vw \+ 100%\)\s*\)/u,
  );
});

test("global New thread excludes its hit target from the overlapping native caption drag region", async () => {
  const styles = await readFile(new URL("styles.css", rendererRoot), "utf8");
  // Windows/Linux's transparent two-row titlebar overlaps the first Sidebar
  // action. DOM pointer-events:none does not subtract Electron drag regions;
  // programmatic button.click() (including Ctrl+N) cannot cover this regression.
  assert.match(
    styles,
    /:root:is\(\[data-platform="linux"\], \[data-platform="win32"\]\)\s*\.window-titlebar\s*\{[^}]*grid-row:\s*1 \/ 3;[^}]*pointer-events:\s*none;/su,
    "the non-mac titlebar still spans both native/conversation rows",
  );
  assert.match(
    styles,
    /:root:is\(\[data-platform="linux"\], \[data-platform="win32"\]\)\s*\.sidebar\s*\{[^}]*grid-row:\s*2 \/ -1;/su,
    "the Sidebar retains its established second-row start",
  );
  assert.match(
    styles,
    /\.new-thread-action\s*\{[^}]*-webkit-app-region:\s*no-drag;/su,
    "New thread needs a native no-drag rectangle, not only DOM pointer handling",
  );
  assert.match(
    styles,
    /\.window-titlebar-drag\s*\{[^}]*-webkit-app-region:\s*drag;/su,
    "ordinary window dragging outside interactive controls remains available",
  );
});

test("macOS expanded workspace hides the complete padded conversation surface, not just its title", async () => {
  const [styles, preview] = await Promise.all([
    readFile(new URL("styles.css", rendererRoot), "utf8"),
    readFile(
      new URL("../scripts/titlebar-safe-area-preview.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(
    styles,
    /:root\[data-platform="darwin"\]\s*\.app-shell:has\(\.auxiliary-panel\[data-open="true"\]\[data-expanded="true"\]\)\s*\.window-titlebar-session\s*\{\s*visibility:\s*hidden;/su,
    "the obsolete session surface must not paint or receive hits over full-width workspace tabs",
  );
  assert.doesNotMatch(
    styles,
    /:root\[data-platform="darwin"\]\s*\.app-shell:has\(\.auxiliary-panel\[data-open="true"\]\[data-expanded="true"\]\)\s*\.thread-heading\s*\{/su,
    "hiding only the title leaves the padded header surface visible",
  );
  assert.match(
    preview,
    /className="workspace-header"\s*>\s*<div className="workspace-heading-row">\s*<div className="thread-heading">/su,
    "the browser fixture must include the real padded ConversationTitleBar wrappers",
  );
});
