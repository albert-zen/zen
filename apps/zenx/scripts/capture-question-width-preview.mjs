import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";

// Build with build-quote-preview.mjs first. Uses production ThreadView, not a CSS mock.
const directory = path.resolve(process.argv[2] ?? ".quote-preview");
const evidence = [];
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot, errors }) => {
    for (const width of [1280, 390, 320]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      for (const example of [
        "short-answer",
        "short-prompt",
        "long-answer",
        "unbroken-answer",
      ]) {
        await send("Page.navigate", {
          url: `${url}/quote-frame.html?questions&empty&question-width=${example}${width < 600 ? "&narrow" : ""}`,
        });
        for (let i = 0; i < 100; i++) {
          if (
            await evaluate(
              "!!document.querySelector('.answered-question-trigger')",
            )
          )
            break;
          await delay(50);
        }
        assert(
          await evaluate(
            "!!document.querySelector('.answered-question-trigger')",
          ),
          `Question fixture did not mount: ${example} at ${width}; ${JSON.stringify(errors)}`,
        );
        await evaluate("document.fonts.ready");
        await delay(250);
        const metrics = await evaluate(`(() => {
        const trigger = document.querySelector('.answered-question-trigger');
        const bubble = trigger.closest('.user-bubble');
        const rect = e => { const r = e.getBoundingClientRect(); return {left:r.left,right:r.right,width:r.width,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth}; };
        return {bubble:rect(bubble), trigger:rect(trigger), row:rect(bubble.parentElement), answer:rect(bubble.querySelector('.answered-question-answer'))};
      })()`);
        evidence.push({ width, example, metrics });
        await writeFile(
          path.join(directory, "question-width-evidence.json"),
          JSON.stringify(evidence, null, 2),
        );
        await screenshot(`question-width-${width}-${example}.png`);
        assert(
          metrics.trigger.width <= 260.1,
          "question chip retains its fixed cap",
        );
        for (const element of [metrics.trigger, metrics.answer]) {
          assert(
            element.left >= metrics.bubble.left - 1 &&
              element.right <= metrics.bubble.right + 1,
            `contained ${example} at ${width}: ${JSON.stringify(metrics)}`,
          );
        }
        assert(
          metrics.bubble.scrollWidth <= metrics.bubble.clientWidth + 1,
          "no horizontal overflow",
        );
        assert(
          metrics.bubble.right <= metrics.row.right + 1,
          "bubble stays within message row",
        );
        if (width === 1280 && example === "short-answer")
          assert(
            metrics.bubble.width < 450,
            "hidden long question must not inflate short reply to the 700px message cap",
          );
        if (width === 1280 && example === "short-prompt")
          assert(
            metrics.bubble.width < 250,
            "short prompt remains content-sized",
          );
      }
    }
    assert.deepEqual(errors, [], "no browser exceptions");
  },
);
await writeFile(
  path.join(directory, "question-width-evidence.json"),
  JSON.stringify(evidence, null, 2),
);
console.log("Question width browser regression passed (12 cases).");
