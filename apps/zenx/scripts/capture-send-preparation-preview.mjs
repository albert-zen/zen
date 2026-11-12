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
      const sceneUrl = `${url}/send-preparation-preview.html?theme=${theme}`;
      await send("Page.navigate", { url: sceneUrl });
      // CDP navigation can return while the previous document is still live.
      // Its existing Turn must not satisfy readiness for this new theme.
      // The new document can also exist before its root element is available.
      const sceneReady = () =>
        evaluate(
          `location.href === ${JSON.stringify(sceneUrl)} && document.documentElement?.dataset.appearance === ${JSON.stringify(theme)} && document.querySelector('.turn-running-label .turn-work-label')?.textContent === 'Preparing for 12s'`,
        );
      for (let i = 0; i < 100; i++) {
        if (await sceneReady()) break;
        await delay(50);
      }
      assert.equal(await sceneReady(), true, `${theme}: new scene is ready`);
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
