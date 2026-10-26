import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".reference-width-preview");
process.env.ZENX_PREVIEW_DESKTOP_INPUT = "1";
const evidence = {
  source:
    "Production responsive ReferenceToken wrapper, Markdown and CSS; synthetic identities, supplied visible excerpt. No Provider or user computer access.",
  scenes: [],
};
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot, errors }) => {
    for (const width of [1280, 420, 320]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 1500,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Page.navigate", { url: url + "/index.html" });
      for (let i = 0; i < 100; i++) {
        if (await evaluate("!!window.layoutMetrics")) break;
        await delay(50);
      }
      await evaluate("document.fonts.ready");
      await evaluate("document.querySelector('#measure').click()");
      const metrics = await evaluate("window.layoutMetrics");
      assert.equal(metrics?.length, 5, "all real-component cases mounted");
      assert.equal(
        await evaluate("document.querySelectorAll('.reference-token').length"),
        6,
        "canonical references parsed into production tokens",
      );
      for (const c of metrics) {
        const content = c.boxes.find(
          (b) => b.class === "inline-reference-content",
        );
        assert.ok(
          content.scrollWidth <= content.clientWidth + 1,
          `no horizontal overflow at ${width}: ${JSON.stringify(c)}`,
        );
        for (const token of c.boxes.filter(
          (b) => b.class === "reference-token",
        )) {
          assert.ok(token.width <= 300.1, "token retains desktop cap");
          assert.ok(
            token.x >= content.x - 1 && token.right <= content.right + 1,
            `token contained at ${width}: ${JSON.stringify(c)}`,
          );
        }
      }
      if (width === 1280) {
        for (const i of [0, 2, 4])
          assert.ok(
            metrics[i].boxes[0].width < 400,
            "long hidden excerpt does not inflate bubble",
          );
        assert.ok(
          metrics[1].boxes[0].width < 180,
          "short reference remains content-sized",
        );
      }
      await screenshot(`reference-width-${width}-fixed.png`);
      await evaluate(
        "document.querySelector('.reference-token-details').click()",
      );
      await delay(200);
      assert.equal(
        await evaluate(
          "document.querySelector('.reference-exact-excerpt')?.textContent",
        ),
        await evaluate("window.referenceExcerpt"),
        "expanded reference preserves exact full excerpt",
      );
      await screenshot(`reference-width-${width}-expanded.png`);
      await evaluate(
        "document.querySelector('.reference-details-popover header button').click()",
      );
      await delay(200);
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.reference-details-popover').length",
        ),
        0,
        "close removes the detail popover",
      );
      await evaluate("document.querySelector('#measure').click()");
      assert.deepEqual(
        await evaluate("window.layoutMetrics"),
        metrics,
        "opening/closing detail never changes inline bubble geometry",
      );
      const scene = { width, metrics };
      evidence.scenes.push(scene);
      console.log("REFERENCE_WIDTH_MEASUREMENTS " + JSON.stringify(scene));
    }
    assert.deepEqual(errors, [], "no browser exceptions");
  },
);
await writeFile(
  path.join(directory, "measurements.json"),
  JSON.stringify(evidence, null, 2),
);
