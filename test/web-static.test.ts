import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("static Web UI shell", () => {
  it("provides a usable first screen and browser adapter", () => {
    const html = readFileSync(join(process.cwd(), "web", "index.html"), "utf8");
    const js = readFileSync(join(process.cwd(), "web", "app.js"), "utf8");

    expect(html).toContain('<form id="composer"');
    expect(html).toContain('id="timeline"');
    expect(html).toContain('id="new-thread"');
    expect(html).toContain('type="module" src="./app.js"');
    expect(js).toContain("createBrowserFakeAppServer");
    expect(js).toContain("applyNotification");
    expect(js).toContain("renderTimelineRow");
    expect(js).toContain("resolveApproval");
  });
});
