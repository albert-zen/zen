import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rendererRoot = new URL("../src/renderer/src/", import.meta.url);

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
    /sidebarCollapsed \? "Expand sidebar" : "Collapse sidebar"/u,
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
