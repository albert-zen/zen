import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".quote-bubble-preview");
process.env.ZENX_PREVIEW_DESKTOP_INPUT = "1";
const excerpt =
  "选中文字后，复制不会改变输入框；引用则作为上下文，问题仍写在原来的输入框。";
const evidence = {
  source:
    "Actual production ThreadView and ReferenceToken, synthetic transcript only. No Provider calls or personal data.",
  scenes: [],
};
for (const scene of [
  { theme: "light", width: 1280, height: 900 },
  { theme: "dark", width: 1280, height: 900 },
  { theme: "light", width: 390, height: 700 },
]) {
  await withPreviewBrowser(
    directory,
    async ({ send, evaluate, url, screenshot }) => {
      await send("Emulation.setDeviceMetricsOverride", {
        width: scene.width,
        height: scene.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Page.navigate", {
        url: `${url}/quote-frame.html?quote-bubble&theme=${scene.theme}`,
      });
      for (
        let i = 0;
        i < 100 &&
        !(await evaluate(
          "!!document.querySelector('.user-bubble .reference-token-details')",
        ));
        i++
      )
        await delay(50);
      const bounds = await evaluate(
        `(() => { const r = document.querySelector('.user-bubble .reference-token-details').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...bounds });
      await delay(300);
      assert.equal(
        await evaluate(
          "document.querySelector('.reference-exact-excerpt')?.textContent",
        ),
        excerpt,
      );
      assert.equal(
        await evaluate("!!document.querySelector('.reference-content-policy')"),
        false,
      );
      await screenshot(`quote-hover-${scene.theme}-${scene.width}.png`);
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        clickCount: 1,
        ...bounds,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        clickCount: 1,
        ...bounds,
      });
      await delay(150);
      assert.equal(
        await evaluate(
          "!!document.querySelector('.reference-details-popover')",
        ),
        false,
      );
      const target = await evaluate(
        `(() => { const ranges = [...CSS.highlights.get('zenx-quote-source') ?? []]; const range = ranges[0]; const rect = range?.getBoundingClientRect(); const viewport = document.querySelector('.messages'); const bounds = viewport.getBoundingClientRect(); return { excerpt: range?.toString(), item: document.activeElement?.dataset.quoteItemId, centerDelta: rect ? Math.abs(rect.top + rect.height / 2 - (bounds.top + viewport.clientHeight / 2)) : null, atBoundary: viewport.scrollTop < 1 || viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1 }; })()`,
      );
      assert.equal(target.excerpt, excerpt);
      assert.equal(target.item, "synthetic-answer");
      assert.ok(
        target.centerDelta < 3 || target.atBoundary,
        JSON.stringify(target),
      );
      await screenshot(`quote-source-${scene.theme}-${scene.width}.png`);
      await delay(1700);
      assert.equal(
        await evaluate("CSS.highlights.has('zenx-quote-source')"),
        false,
      );
      evidence.scenes.push({ ...scene, ...target, highlightCleared: true });
    },
  );
}
await writeFile(
  path.join(directory, "quote-bubble-evidence.json"),
  JSON.stringify(evidence, null, 2),
);
console.log(JSON.stringify(evidence));
