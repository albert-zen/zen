import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rendererRoot = new URL("../src/renderer/src/", import.meta.url);

test("integrated title bar keeps controls while macOS moves ZenX branding into the Sidebar", async () => {
  const [app, sidebar, styles, main] = await Promise.all([
    readFile(new URL("App.tsx", rendererRoot), "utf8"),
    readFile(new URL("Sidebar.tsx", rendererRoot), "utf8"),
    readFile(new URL("styles.css", rendererRoot), "utf8"),
    readFile(new URL("../src/main/index.ts", import.meta.url), "utf8"),
  ]);

  assert.match(app, /className="window-titlebar"/u);
  assert.match(app, /className="window-titlebar-actions"/u);
  assert.match(app, /aria-pressed=\{mode === "inbox"\}/u);
  assert.match(app, /aria-controls="primary-sidebar"/u);
  assert.match(app, /aria-expanded=\{!sidebarCollapsed\}/u);
  assert.match(
    app,
    /sidebarCollapsed \? "Expand sidebar" : "Collapse sidebar"/u,
  );
  assert.match(sidebar, /id="primary-sidebar"/u);
  assert.match(sidebar, /className="sidebar-platform-brand"/u);
  assert.match(sidebar, /<ZenXBrand \/>/u);
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
    /:root\[data-platform="darwin"\] \.window-titlebar-brand > \.brand\s*\{[^}]*display: none;/su,
  );
  assert.match(
    styles,
    /:root\[data-platform="darwin"\] \.sidebar-platform-brand\s*\{[^}]*display: flex;/su,
  );
  assert.match(main, /titleBarStyle: "hidden"/u);
  assert.match(main, /titleBarOverlay:/u);
});

test("macOS keeps traffic lights compact and places branding on the Sidebar row", async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL("App.tsx", rendererRoot), "utf8"),
    readFile(new URL("styles.css", rendererRoot), "utf8"),
  ]);

  assert.match(app, /className="sidebar-brand-row"/u);
  assert.match(styles, /:root\[data-platform="darwin"\] \.window-titlebar/u);
  assert.match(styles, /:root\[data-platform="darwin"\] \.sidebar-brand-row/u);
});
