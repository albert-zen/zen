import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rendererRoot = new URL("../src/renderer/src/", import.meta.url);

test("integrated title bar orders ZenX branding, Inbox, and Sidebar controls", async () => {
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
  assert.doesNotMatch(sidebar, /<ZenXBrand/u);
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
  assert.match(main, /titleBarStyle: "hidden"/u);
  assert.match(main, /titleBarOverlay:/u);
});
