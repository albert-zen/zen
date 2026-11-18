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
      // The token can mount before CJK fonts and transcript follow-bottom settle.
      // Wait for its actual hit target to stay in place before one native hover.
      await evaluate("document.fonts.ready.then(() => true)");
      let previousBounds;
      let stableFrames = 0;
      for (let i = 0; i < 100 && stableFrames < 3; i++) {
        const current = await evaluate(
          `(() => { const el = document.querySelector('.user-bubble .reference-token-details'); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, hit: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }; })()`,
        );
        stableFrames =
          current.hit &&
          JSON.stringify(current) === JSON.stringify(previousBounds)
            ? stableFrames + 1
            : 0;
        previousBounds = current;
        await delay(50);
      }
      assert.equal(
        stableFrames,
        3,
        "quote token must be stable and hit-testable",
      );
      const bounds = await evaluate(
        `(() => { const r = document.querySelector('.user-bubble .reference-token-details').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...bounds });
      for (let i = 0; i < 60; i++) {
        if (
          await evaluate("!!document.querySelector('.reference-exact-excerpt')")
        )
          break;
        await delay(50);
      }
      if (
        !(await evaluate(
          "!!document.querySelector('.reference-exact-excerpt')",
        ))
      ) {
        await screenshot(
          `quote-hover-failed-${scene.theme}-${scene.width}.png`,
        );
      }
      assert.equal(
        await evaluate(
          "document.querySelector('.reference-exact-excerpt')?.textContent",
        ),
        excerpt,
      );
      assert.equal(
        await evaluate(
          "!!document.querySelector('.reference-details-popover dl, .reference-content-policy')",
        ),
        false,
      );
      // DOM presence precedes the popover's entrance animation. Capture its
      // settled state rather than a translucent frame.
      await evaluate(
        "Promise.all(document.querySelector('.reference-details-popover').getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))).then(() => true)",
      );
      await screenshot(`quote-hover-${scene.theme}-${scene.width}.png`);
      // Read-only diagnostics retain the original click coordinates and dispatch count.
      const readClickState = () =>
        evaluate(`(() => {
        const point = ${JSON.stringify(bounds)};
        const token = document.querySelector('.user-bubble .reference-token-details');
        const popover = document.querySelector('.reference-details-popover');
        const describe = e => {
          if (!e) return null;
          const r=e.getBoundingClientRect(), style=getComputedStyle(e);
          return { tag:e.tagName, id:e.id, className:e.className,
            quoteItemId:e.dataset?.quoteItemId ?? null,
            rect:{x:r.x,y:r.y,width:r.width,height:r.height},
            display:style.display, visibility:style.visibility,
            expanded:e.getAttribute('aria-expanded'), state:e.getAttribute('data-state') };
        };
        const hit=document.elementFromPoint(point.x,point.y);
        const range=[...CSS.highlights.get('zenx-quote-source') ?? []][0];
        const r=range?.getBoundingClientRect(), viewport=document.querySelector('.messages');
        return { point, token:describe(token), hit:describe(hit),
          tokenOwnsHit:!!token && !!hit && (token===hit || token.contains(hit)),
          activeElement:describe(document.activeElement), popover:describe(popover),
          animations:popover?.getAnimations({subtree:true}).map(a=>({playState:a.playState,currentTime:a.currentTime})) ?? [],
          sourceHighlight:range ? {excerpt:range.toString(),rect:{x:r.x,y:r.y,width:r.width,height:r.height}} : null,
          scroll:viewport ? {top:viewport.scrollTop,height:viewport.scrollHeight,clientHeight:viewport.clientHeight} : null };
      })()`);
      let beforeClick;
      let target;
      try {
        beforeClick = await readClickState();
      } catch (error) {
        beforeClick = { diagnosticError: String(error) };
      }
      try {
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
        target = await evaluate(
          `(() => { const ranges = [...CSS.highlights.get('zenx-quote-source') ?? []]; const range = ranges[0]; const rect = range?.getBoundingClientRect(); const viewport = document.querySelector('.messages'); const bounds = viewport.getBoundingClientRect(); return { excerpt: range?.toString(), item: document.activeElement?.dataset.quoteItemId, centerDelta: rect ? Math.abs(rect.top + rect.height / 2 - (bounds.top + viewport.clientHeight / 2)) : null, atBoundary: viewport.scrollTop < 1 || viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1 }; })()`,
        );
        assert.equal(target.excerpt, excerpt);
        assert.equal(target.item, "synthetic-answer");
        assert.ok(target.centerDelta < 3, JSON.stringify(target));
        await screenshot(`quote-source-${scene.theme}-${scene.width}.png`);
        await delay(1700);
        assert.equal(
          await evaluate("CSS.highlights.has('zenx-quote-source')"),
          false,
        );
      } catch (error) {
        const failure = {
          ...scene,
          beforeClick,
          error: String(error.stack ?? error),
        };
        try {
          failure.afterClick = await readClickState();
        } catch (diagnosticError) {
          failure.snapshotError = String(diagnosticError);
        }
        const prefix = `quote-click-failed-${scene.theme}-${scene.width}`;
        try {
          await writeFile(
            path.join(directory, `${prefix}-evidence.json`),
            JSON.stringify(failure, null, 2) + "\n",
          );
        } catch (diagnosticError) {
          console.error(
            "Quote failure diagnostics could not be saved",
            diagnosticError,
          );
        }
        try {
          await screenshot(`${prefix}.png`);
        } catch (diagnosticError) {
          console.error(
            "Quote failure screenshot could not be saved",
            diagnosticError,
          );
        }
        throw error;
      }
      evidence.scenes.push({ ...scene, ...target, highlightCleared: true });
    },
  );
}
await writeFile(
  path.join(directory, "quote-bubble-evidence.json"),
  JSON.stringify(evidence, null, 2),
);
console.log(JSON.stringify(evidence));
