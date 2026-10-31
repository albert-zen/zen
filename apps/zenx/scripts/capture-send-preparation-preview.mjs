/** Cloud Chromium capture: synthetic data, production components; no native Host acceptance. */
import path from "node:path";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".send-preparation-preview");
const cases = [];
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot, errors }) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1120,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const theme of ["light", "dark"]) {
      await send("Page.navigate", {
        url: `${url}/send-preparation-preview.html?theme=${theme}`,
      });
      for (let i = 0; i < 100; i++) {
        if (await evaluate("!!document.querySelector('.turn-running-label')"))
          break;
        await delay(50);
      }
      await evaluate("document.fonts.ready");
      const label = () =>
        evaluate(
          "document.querySelector('.turn-running-label .turn-work-label')?.textContent",
        );
      assert.equal(await label(), "Preparing for 12s");
      assert.equal(
        await evaluate(
          "document.querySelector('.turn-running-label [role=status]').textContent",
        ),
        "Preparing",
      );
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.context-compaction-progress').length",
        ),
        1,
      );
      await screenshot(`${theme}-preparing.png`);
      await evaluate("window.__preparationPreview.resume()");
      await delay(80);
      assert.equal(await label(), "Working for 12s");
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.context-compaction-progress').length",
        ),
        0,
      );
      assert.equal(
        await evaluate("document.documentElement.scrollWidth <= innerWidth"),
        true,
      );
      await screenshot(`${theme}-resumed.png`);
      cases.push({
        theme,
        width: 1120,
        height: 800,
        preparing: "Preparing for 12s",
        resumed: "Working for 12s",
        elapsedReset: false,
      });
    }
    assert.deepEqual(errors, []);
  },
);
await writeFile(
  `${directory}/evidence.json`,
  JSON.stringify(
    {
      scope:
        "Actual production ThreadView rendered in cloud Chromium, synthetic input/status and fixed clock. No Host/model/device calls. Transition simulates observation clearing, not proof of live core event delivery.",
      cases,
    },
    null,
    2,
  ),
);
