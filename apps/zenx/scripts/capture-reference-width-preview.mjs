import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".reference-width-preview");
process.env.ZENX_PREVIEW_DESKTOP_INPUT = "1";
const evidence = {
  source:
    "Production InlineReferenceContent, Markdown, ReferenceToken and CSS; synthetic identities, supplied visible excerpt; no Provider or user computer access.",
  scenes: [],
};
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot, errors }) => {
    for (const width of [1280, 420]) {
      for (const experiment of [false, true]) {
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await send("Page.navigate", { url: url + "/index.html" });
        for (let i = 0; i < 100; i++) {
          if (await evaluate("!!window.layoutMetrics")) break;
          await delay(50);
        }
        await evaluate("document.fonts.ready");
        if (experiment)
          await evaluate(
            `(() => { const style=document.createElement("style"); style.textContent=".reference-token{max-width:300px}"; document.head.append(style); })()`,
          );
        await evaluate("document.querySelector('#measure').click()");
        const metrics = await evaluate("window.layoutMetrics");
        assert.equal(
          metrics?.length,
          3,
          "all three real-component cases mounted",
        );
        assert.equal(
          await evaluate(
            "document.querySelectorAll('.reference-token').length",
          ),
          3,
          "canonical references parsed into production tokens",
        );
        assert.ok(
          metrics.every((c) =>
            c.boxes.every((b) => Number.isFinite(b.width) && b.width > 0),
          ),
          "capture valid layout, without pre-judging expected width",
        );
        const scene = {
          width,
          experiment: experiment
            ? "FIXTURE ONLY: max-width 300px"
            : "production baseline",
          metrics,
        };
        evidence.scenes.push(scene);
        await screenshot(
          `reference-width-${width}${experiment ? "-experiment" : ""}.png`,
        );
        console.log("REFERENCE_WIDTH_MEASUREMENTS " + JSON.stringify(scene));
      }
    }
    assert.deepEqual(errors, [], "no browser exceptions");
  },
);
await writeFile(
  path.join(directory, "measurements.json"),
  JSON.stringify(evidence, null, 2),
);
