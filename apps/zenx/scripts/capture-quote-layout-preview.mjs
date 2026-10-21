import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".quote-layout-preview");
process.env.ZENX_PREVIEW_DESKTOP_INPUT = "1";
const observations = [];
const categories = ["thread", "message", "subagent", "selection", "file"];
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot }) => {
    for (const scene of [
      {
        name: "unified-references-a-external",
        width: 1100,
        query: "?layout=external",
        layouts: ["external"],
      },
      {
        name: "unified-references-b-inline",
        width: 1100,
        query: "?layout=inline",
        layouts: ["inline"],
      },
      {
        name: "unified-references-comparison",
        width: 1440,
        query: "",
        layouts: ["external", "inline"],
      },
      {
        name: "unified-references-dark",
        width: 1440,
        query: "?theme=dark",
        layouts: ["external", "inline"],
      },
      {
        name: "unified-references-narrow",
        width: 420,
        query: "",
        layouts: ["external", "inline"],
      },
    ]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: scene.width,
        height: 1200,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Page.navigate", {
        url: `${url}/quote-layout.html${scene.query}`,
      });
      for (let count = 0; count < 100; count++) {
        if (
          await evaluate(
            `document.querySelectorAll('.layout-option').length === ${scene.layouts.length}`,
          )
        )
          break;
        await delay(50);
      }
      await evaluate("document.fonts.ready.then(() => true)");
      await delay(100);
      const state = await evaluate(`(() => {
      const all = selector => [...document.querySelectorAll(selector)];
      return {
        media: Object.fromEntries(['(hover: hover)', '(pointer: fine)', '(any-hover: hover)', '(any-pointer: fine)', '(hover: none)', '(pointer: coarse)'].map(q => [q, matchMedia(q).matches])),
        overflow: document.documentElement.scrollWidth > innerWidth,
        layouts: all('.layout-option').map(option => ({
          name: option.dataset.layout,
          draft: [...option.querySelectorAll('.draft-stage [data-reference-category]')].map(el => el.dataset.referenceCategory),
          sent: [...option.querySelectorAll('.sent-stage [data-reference-category]')].map(el => el.dataset.referenceCategory),
          draftInside: option.querySelectorAll('.comparison-composer .reference-token').length,
          sentInside: option.querySelectorAll('.user-bubble .reference-token').length,
          sentRemove: option.querySelectorAll('.sent-stage .reference-token-remove').length,
        })),
        heights: all('.reference-token').map(el => el.getBoundingClientRect().height),
        payload: document.querySelector('.context-evidence').dataset.currentPayload,
        contentHeight: document.documentElement.scrollHeight,
      };
    })()`);
      for (const q of [
        "(hover: hover)",
        "(pointer: fine)",
        "(any-hover: hover)",
        "(any-pointer: fine)",
      ])
        assert.equal(state.media[q], true);
      for (const q of ["(hover: none)", "(pointer: coarse)"])
        assert.equal(state.media[q], false);
      assert.equal(state.overflow, false);
      assert.equal(state.layouts.length, scene.layouts.length);
      for (const layout of state.layouts) {
        assert.deepEqual(layout.draft, categories);
        assert.deepEqual(layout.sent, categories);
        assert.equal(layout.draftInside, layout.name === "inline" ? 5 : 0);
        assert.equal(layout.sentInside, layout.name === "inline" ? 5 : 0);
        assert.equal(layout.sentRemove, 0);
      }
      assert(
        state.heights.every((height) => height === 28),
        "desktop tokens are exactly 28px",
      );
      // Capture full context, not a cropped fragment, without changing any content CSS.
      assert(state.contentHeight < 3500, "bounded full-page synthetic capture");
      await send("Emulation.setDeviceMetricsOverride", {
        width: scene.width,
        height: state.contentHeight,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await delay(50);
      await screenshot(`${scene.name}.png`);
      // Every kind uses the same inspect/source/close controls; exact excerpt stays available.
      for (const category of categories) {
        await evaluate(
          `document.querySelector('.draft-stage [data-reference-category="${category}"] .reference-token-details').click()`,
        );
        await delay(20);
        assert.equal(
          await evaluate("!!document.querySelector('.reference-inspector')"),
          true,
        );
        if (category === "message")
          assert.equal(
            await evaluate(
              "document.querySelector('.reference-exact-excerpt').textContent",
            ),
            "引用需要保留来源。\n文件和线程默认只提供位置；选中的原文按快照传入。",
          );
        if (category === "selection")
          assert.equal(
            await evaluate(
              "document.querySelector('.reference-exact-excerpt').textContent",
            ),
            "文件和线程默认只提供位置",
          );
        await evaluate(
          "document.querySelector('.reference-source-link').click()",
        );
        await delay(20);
        assert.equal(
          await evaluate("!!document.querySelector('.source-record pre')"),
          true,
        );
        await evaluate(
          "document.querySelector('[aria-label=\"关闭引用详情\"]').click()",
        );
        await delay(20);
      }
      const sentBefore = await evaluate(
        "document.querySelector('.sent-stage').textContent",
      );
      await evaluate(
        "document.querySelector('.reference-token-remove').click()",
      );
      await delay(20);
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.draft-stage')[0].querySelectorAll('.reference-token').length",
        ),
        4,
      );
      assert.equal(
        await evaluate("document.querySelector('.sent-stage').textContent"),
        sentBefore,
        "draft removal never rewrites captured sent instance",
      );
      assert.equal(
        await evaluate(
          "document.querySelector('.context-evidence').dataset.currentPayload",
        ),
        state.payload,
      );
      await evaluate("document.querySelector('.restore-sample').click()");
      await delay(20);
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.draft-stage')[0].querySelectorAll('.reference-token').length",
        ),
        5,
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
        "Ubuntu Chrome desktop-input capability emulation; synthetic five-reference layout proposal, not a production send UI",
      observations,
    },
    null,
    2,
  ),
);
