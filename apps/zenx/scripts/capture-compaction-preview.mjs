import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".compaction-status-preview");
process.env.ZENX_PREVIEW_DESKTOP_INPUT = "1";
const evidence = {
  scope: "Actual ThreadView, synthetic records and unavailable-history port",
  scenes: [],
};
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot, errors }) => {
    const activate = async (selector) => {
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).focus()`,
      );
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      await delay(100);
    };
    for (const width of [1280, 390])
      for (const lang of ["en", "zh-CN"])
        for (const theme of ["light", "dark"]) {
          await send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 1800,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await send("Page.navigate", {
            url: `${url}/compaction-status.html?lang=${lang}&theme=${theme}&long=1`,
          });
          for (let i = 0; i < 100; i++) {
            if (
              await evaluate(
                "document.querySelectorAll('.status-scene').length === 3",
              )
            )
              break;
            await delay(50);
          }
          await evaluate("document.fonts.ready");
          assert.equal(
            await evaluate("document.querySelectorAll('.status-scene').length"),
            3,
          );
          const metrics = await evaluate(
            `Array.from(document.querySelectorAll('.context-compaction-toggle, .context-compaction-progress-summary')).map(e=>{const r=e.getBoundingClientRect();return {x:r.x,right:r.right,height:r.height,client:e.clientWidth,scroll:e.scrollWidth}})`,
          );
          assert.equal(metrics.length, 3);
          for (const m of metrics) {
            assert.ok(
              m.height >= 38 && m.scroll <= m.client + 1,
              JSON.stringify(m),
            );
            assert.ok(m.x >= 0 && m.right <= width, JSON.stringify(m));
          }
          const name = `${width}-${lang}-${theme}`;
          await screenshot(`${name}-collapsed.png`);
          await activate(".context-compaction-toggle");
          assert.equal(
            await evaluate(
              "document.querySelector('.context-compaction-toggle').getAttribute('aria-expanded')",
            ),
            "true",
          );
          await activate(".context-compaction-error-detail summary");
          assert.equal(
            await evaluate(
              "document.querySelector('.context-compaction-error-detail').open",
            ),
            true,
          );
          assert.ok(
            await evaluate(
              "document.documentElement.scrollWidth <= innerWidth",
            ),
            "long diagnostic stays within viewport",
          );
          await screenshot(`${name}-expanded.png`);
          await activate(".context-compaction-dismiss");
          assert.equal(
            await evaluate(
              "document.querySelector('.context-compaction-progress.is-error')",
            ),
            null,
          );
          evidence.scenes.push({
            width,
            lang,
            theme,
            metrics,
            keyboardDisclosureAndDismiss: true,
          });
        }
    assert.deepEqual(errors, []);
    await writeFile(
      path.join(directory, "evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
  },
);
