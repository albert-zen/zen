import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, withPreviewBrowser } from "./preview-browser.mjs";
assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "Capture uses CI's existing Chrome only.",
);
const directory = path.resolve(process.argv[2] ?? ".sidebar-state-preview");
const cases = [];
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot, errors }) => {
    const waitFor = async (expression) => {
      for (let i = 0; i < 200; i++) {
        assert.deepEqual(errors, [], "Sidebar renderer exceptions");
        if (await evaluate(expression)) return;
        await delay(50);
      }
      throw Error(`Timed out: ${expression}`);
    };
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url: `${url}/sidebar-state.html` });
    await waitFor(
      "!!window.__sidebarFixture && !!document.querySelector('[data-owner=thread-b]')",
    );
    await evaluate("window.__sidebarFixture.background()");
    await delay(100);
    let evidence = await evaluate("window.__sidebarFixture.measure()");
    assert.equal(evidence.owner.id, "thread-b");
    assert.ok(
      !evidence.calls.some(
        (call) =>
          call.method === "read" ||
          call.method === "materialize" ||
          call.method === "new",
      ),
    );
    await screenshot("01-background-a-foreground-b.png");
    cases.push(evidence);
    await evaluate("document.querySelector('[data-owner=thread-a]').click()");
    await waitFor(
      "window.__sidebarFixture.measure().calls.some(call => call.method === 'read') && !!document.querySelector('.cm-editor')",
    );
    await screenshot("02-thread-a-restored.png");
    evidence = await evaluate("window.__sidebarFixture.measure()");
    assert.equal(evidence.owner.id, "thread-a");
    cases.push(evidence);
    await evaluate("window.__sidebarFixture.room()");
    await evaluate(
      "document.querySelector('[data-owner=room-shared]').click()",
    );
    await waitFor(
      "!!document.getElementById('aux-tab-file:@thread-b:README.md') && !!document.querySelector('.cm-editor')",
    );
    await screenshot("03-shared-room-owned-resources.png");
    evidence = await evaluate("window.__sidebarFixture.measure()");
    assert.equal(evidence.owner.kind, "room");
    cases.push(evidence);
  },
);
await writeFile(
  path.join(directory, "evidence.json"),
  JSON.stringify(
    {
      scope:
        "Actual production components/controller, synthetic ports only. No native Electron or production data.",
      cases,
    },
    null,
    2,
  ),
);
