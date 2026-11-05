import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".answered-question-preview");
process.env.ZENX_PREVIEW_DESKTOP_INPUT = "1";
const evidence = {
  source:
    "Production ThreadView and AnsweredQuestionBubble in the existing Sidebar fixture. All question history and responses are synthetic. No model calls or personal data.",
  scenes: [],
};
for (const scene of [
  { theme: "light", width: 1280, height: 900, lang: "zh-CN" },
  { theme: "dark", width: 1280, height: 900, lang: "en" },
  { theme: "light", width: 390, height: 700, lang: "zh-CN" },
]) {
  await withPreviewBrowser(
    directory,
    async ({ send, evaluate, url, screenshot }) => {
      await send("Emulation.setDeviceMetricsOverride", {
        ...scene,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const entry = `${url}/quote-frame.html?questions&empty&theme=${scene.theme}&lang=${scene.lang}${scene.width < 600 ? "&narrow" : ""}`;
      await send("Page.navigate", { url: entry });
      for (
        let i = 0;
        i < 100 &&
        !(await evaluate(
          "!!document.querySelector('.answered-question-trigger')",
        ));
        i++
      )
        await delay(50);
      const answer = await evaluate(
        "document.querySelector('.answered-question-answer')?.textContent",
      );
      assert.match(answer, /一页摘要完整明细请保留重点案例/);
      assert.match(answer, /\*\*标记\*\*/);
      assert.doesNotMatch(answer, /Reply to|scope:/);
      const point = await evaluate(
        `(() => { const element = document.querySelector('.answered-question-trigger'); element.scrollIntoView({block: 'center'}); const r = element.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`,
      );
      await screenshot(`question-answer-${scene.theme}-${scene.width}.png`);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      await delay(250);
      assert.match(
        await evaluate(
          "document.querySelector('.answered-question-popover')?.textContent",
        ),
        /暂不整理/,
      );
      await screenshot(`question-hover-${scene.theme}-${scene.width}.png`);
      const click = async () => {
        await send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          clickCount: 1,
          ...point,
        });
        await send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: "left",
          clickCount: 1,
          ...point,
        });
      };
      await click();
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 10,
        y: 10,
      });
      await delay(250);
      assert.equal(
        await evaluate(
          "!!document.querySelector('.answered-question-popover')",
        ),
        true,
        "Click keeps the original question open after pointer leaves",
      );
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      await delay(100);
      assert.equal(
        await evaluate(
          "!!document.querySelector('.answered-question-popover')",
        ),
        false,
      );
      assert.equal(
        await evaluate(
          "document.activeElement?.classList.contains('answered-question-trigger')",
        ),
        true,
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
      assert.equal(
        await evaluate(
          "!!document.querySelector('.answered-question-popover')",
        ),
        true,
      );
      await evaluate("window.quoteFixture.navigate()");
      await delay(100);
      assert.equal(
        await evaluate(
          "!!document.querySelector('.answered-question-popover')",
        ),
        false,
      );
      await send("Page.navigate", { url: `${entry}&missing-question` });
      for (
        let i = 0;
        i < 100 &&
        !(await evaluate(
          "!!document.querySelector('.answered-question-trigger')",
        ));
        i++
      )
        await delay(50);
      await evaluate(
        "document.querySelector('.answered-question-trigger').click()",
      );
      await delay(100);
      assert.match(
        await evaluate(
          "document.querySelector('.answered-question-popover')?.textContent",
        ),
        /不可用|unavailable/,
      );
      assert.match(
        await evaluate(
          "document.querySelector('.answered-question-answer')?.textContent",
        ),
        /scope:/,
      );
      await screenshot(
        `question-unavailable-${scene.theme}-${scene.width}.png`,
      );
      evidence.scenes.push({
        ...scene,
        hover: true,
        clickPinned: true,
        escape: true,
        keyboard: true,
        navigationRetired: true,
        missingOriginalPreserved: true,
      });
    },
  );
}
await writeFile(
  path.join(directory, "answered-question-evidence.json"),
  JSON.stringify(evidence, null, 2),
);
console.log(JSON.stringify(evidence));
