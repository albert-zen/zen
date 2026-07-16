import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("static Web UI shell", () => {
  it("provides a React, Tailwind, and shadcn-style Web UI entry", () => {
    const html = readFileSync(join(process.cwd(), "web", "index.html"), "utf8");
    const workspace = readFileSync(
      join(process.cwd(), "web", "src", "workspace.tsx"),
      "utf8"
    );
    const styles = readFileSync(join(process.cwd(), "web", "src", "styles.css"), "utf8");
    const button = readFileSync(
      join(process.cwd(), "web", "src", "components", "ui", "button.tsx"),
      "utf8"
    );
    const utils = readFileSync(
      join(process.cwd(), "web", "src", "lib", "utils.ts"),
      "utf8"
    );

    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('type="module" src="/web/src/main.tsx"');
    expect(styles).toContain('@import "tailwindcss"');
    expect(button).toContain("class-variance-authority");
    expect(utils).toContain("tailwind-merge");
    expect(workspace).toContain("BrowserAppServerTransportClient");
    expect(workspace).toContain("WebUiClient");
    expect(workspace).toContain("createBrowserDemoAppServer");
    expect(workspace).toContain('id="composer"');
    expect(workspace).toContain('id="timeline"');
    expect(workspace).toContain('id="runtime-mode"');
    expect(workspace).toContain("Real transport");
    expect(workspace).toContain("Demo mode");
  });

  it("does not expose direct App Server configuration to browser code", () => {
    const workspace = readFileSync(
      join(process.cwd(), "web", "src", "workspace.tsx"),
      "utf8"
    );

    expect(workspace).not.toContain("DEFAULT_SERVER_URL");
    expect(workspace).not.toContain("zen-app-server-url");
    expect(workspace).not.toContain('params.get("server")');
    expect(workspace).not.toContain('id="server-url"');
    expect(workspace).not.toContain("baseUrl:");
  });
});
