import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_APP_SERVER_HOST,
  DEFAULT_APP_SERVER_PORT
} from "../src/app-server-config.js";

describe("static Web UI shell", () => {
  it("provides a usable first screen and browser adapter", () => {
    const html = readFileSync(join(process.cwd(), "web", "index.html"), "utf8");
    const js = readFileSync(join(process.cwd(), "web", "app.js"), "utf8");

    expect(html).toContain('<form id="composer"');
    expect(html).toContain('id="timeline"');
    expect(html).toContain('id="new-thread"');
    expect(html).toContain('id="connect"');
    expect(html).toContain('id="runtime-mode"');
    expect(html).toContain('Real transport');
    expect(html).toContain('Demo mode');
    expect(html).toContain('type="module" src="./app.js"');
    expect(js).toContain("BrowserAppServerTransportClient");
    expect(js).toContain("WebUiClient");
    expect(js).toContain('params.get("mode") === "demo"');
    expect(js).toContain("createBrowserDemoAppServer");
    expect(js).toContain("renderTimelineRow");
    expect(js).toContain("renderShellRow");
    expect(js).toContain("renderShellCommand");
    expect(js).toContain("renderShellResult");
  });

  it("defaults to the same local endpoint as the App Server CLI", () => {
    const html = readFileSync(join(process.cwd(), "web", "index.html"), "utf8");
    const js = readFileSync(join(process.cwd(), "web", "app.js"), "utf8");
    const url = `http://${DEFAULT_APP_SERVER_HOST}:${DEFAULT_APP_SERVER_PORT}`;

    expect(html).toContain(`value="${url}"`);
    expect(js).toContain(`const DEFAULT_SERVER_URL = "${url}"`);
  });
});
