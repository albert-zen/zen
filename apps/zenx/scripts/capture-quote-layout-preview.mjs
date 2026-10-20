import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".quote-layout-preview");
process.env.ZENX_PREVIEW_DESKTOP_INPUT = "1";
const observations = [];
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot }) => {
    for (const scene of [
      {
        name: "quote-layout-comparison-light",
        width: 1360,
        height: 900,
        query: "",
      },
      {
        name: "quote-layout-comparison-dark",
        width: 1360,
        height: 900,
        query: "?theme=dark",
      },
      {
        name: "quote-layout-comparison-narrow",
        width: 420,
        height: 1600,
        query: "",
      },
      {
        name: "quote-layout-comparison-long",
        width: 1360,
        height: 1050,
        query: "?long",
      },
    ]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: scene.width,
        height: scene.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Page.navigate", {
        url: `${url}/quote-layout.html${scene.query}`,
      });
      for (let count = 0; count < 100; count++) {
        if (
          await evaluate(
            "document.querySelectorAll('.layout-option').length === 2",
          )
        )
          break;
        await delay(50);
      }
      await evaluate("document.fonts.ready.then(() => true)");
      await delay(100);
      const state = await evaluate(`(() => {
      const all = (selector) => [...document.querySelectorAll(selector)];
      const media = Object.fromEntries(['(hover: hover)', '(pointer: fine)', '(any-hover: hover)', '(any-pointer: fine)', '(hover: none)', '(pointer: coarse)'].map(q => [q, matchMedia(q).matches]));
      return { media, overflow: document.documentElement.scrollWidth > innerWidth,
        externalDraftInside: all('.layout-external .comparison-composer [data-adjunct], .layout-external .comparison-composer .message-quote-card').length,
        externalSentInside: all('.layout-external .user-bubble [data-adjunct], .layout-external .user-bubble .message-quote-card').length,
        inlineDraft: all('.layout-inline .comparison-composer [data-adjunct], .layout-inline .comparison-composer .message-quote-card').length,
        inlineSent: all('.layout-inline .user-bubble [data-adjunct], .layout-inline .user-bubble .message-quote-card').length,
        pillHeights: all('.message-quote-pill').map(e => e.getBoundingClientRect().height),
        payloads: all('.payload-details pre').map(e => e.textContent),
        contentHeight: document.documentElement.scrollHeight
      };
    })()`);
      for (const query of [
        "(hover: hover)",
        "(pointer: fine)",
        "(any-hover: hover)",
        "(any-pointer: fine)",
      ])
        assert.equal(state.media[query], true);
      assert.equal(state.media["(hover: none)"], false);
      assert.equal(state.media["(pointer: coarse)"], false);
      assert.equal(state.overflow, false);
      assert.equal(state.externalDraftInside, 0);
      assert.equal(state.externalSentInside, 0);
      assert.equal(state.inlineDraft, 3);
      assert.equal(state.inlineSent, 3);
      assert.deepEqual(state.pillHeights, [28, 28, 28, 28]);
      assert.equal(
        state.payloads[0],
        state.payloads[1],
        "layout choice does not change payload",
      );
      assert.ok(
        state.contentHeight <= scene.height,
        `full comparison must fit capture: ${state.contentHeight}`,
      );
      await screenshot(`${scene.name}.png`);
      // Real component source and removal controls, never a provider/send callback.
      await evaluate(
        "document.querySelector('.layout-external .message-quote-source').click()",
      );
      assert.equal(
        await evaluate(
          "document.querySelector('.source-preview pre').textContent === document.querySelector('.message-quote-excerpt').textContent",
        ),
        true,
      );
      await evaluate(
        "document.querySelector('.source-preview button').click(); document.querySelector('.layout-inline .draft-stage .message-quote-remove').click()",
      );
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.layout-inline .message-quote-card').length",
        ),
        0,
      );
      await evaluate(
        "document.querySelector('.layout-inline .restore-sample').click()",
      );
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.layout-inline .message-quote-card').length",
        ),
        2,
      );
      observations.push({ scene, ...state });
    }
  },
);
await writeFile(
  path.join(directory, "measurements.json"),
  JSON.stringify(
    {
      environment:
        "Ubuntu Chrome desktop-input capability emulation, synthetic layout comparison (not a send implementation)",
      observations,
    },
    null,
    2,
  ),
);
