import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".quote-preview");
const evidence = {
  source:
    "Production components with synthetic native-message projection; no Provider or Host calls.",
  scenes: [],
};
for (const entry of [
  { inputMode: "desktop", theme: "light", width: 1280, height: 1000 },
  { inputMode: "desktop", theme: "dark", width: 1280, height: 1000 },
  { inputMode: "desktop", theme: "light", width: 420, height: 900 },
  { inputMode: "touch", theme: "light", width: 420, height: 900 },
]) {
  if (entry.inputMode === "desktop")
    process.env.ZENX_PREVIEW_DESKTOP_INPUT = "1";
  else delete process.env.ZENX_PREVIEW_DESKTOP_INPUT;
  await withPreviewBrowser(
    directory,
    async ({ send, evaluate, url, screenshot }) => {
      const waitFor = async (expression) => {
        for (let i = 0; i < 200; i++) {
          if (await evaluate(expression)) return;
          await delay(50);
        }
        throw new Error(`Fixture condition timed out: ${expression}`);
      };
      const settle = () =>
        evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
      const name = `quote-${entry.inputMode}-${entry.theme}-${entry.width}`;
      if (entry.inputMode === "touch") {
        await send("Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints: 1,
        });
      }
      await send("Emulation.setDeviceMetricsOverride", {
        width: entry.width,
        height: entry.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Page.navigate", {
        url: `${url}/quote-frame.html?theme=${entry.theme}${entry.width < 600 ? "&narrow" : ""}`,
      });
      await waitFor(
        `Boolean(window.quoteFixture && document.querySelector('[data-sent-message-id="message-synthetic-example"]') && document.documentElement.dataset.appearance === '${entry.theme}')`,
      );
      const capabilities = await evaluate(`({
        fine: matchMedia('(pointer: fine)').matches,
        hover: matchMedia('(hover: hover)').matches,
        anyFine: matchMedia('(any-pointer: fine)').matches,
        anyHover: matchMedia('(any-hover: hover)').matches,
        coarse: matchMedia('(pointer: coarse)').matches,
        noHover: matchMedia('(hover: none)').matches
      })`);
      const desktop = entry.inputMode === "desktop";
      assert.deepEqual(
        capabilities,
        {
          fine: desktop,
          hover: desktop,
          anyFine: desktop,
          anyHover: desktop,
          coarse: !desktop,
          noHover: !desktop,
        },
        "Input capabilities must match the screenshot label",
      );
      await evaluate("document.fonts.ready");
      await settle();
      assert.equal(
        await evaluate("document.querySelector('.turn-outcome') === null"),
        true,
        "Synthetic completed turns have an explicit final acknowledgment",
      );
      await screenshot(`${name}-initial-sent.png`);
      // Use an actual DOM Range; the production selectionchange listener owns the toolbar.
      await evaluate(
        `(() => {const body=document.querySelector('[data-quote-item-id="synthetic-answer"] p');if(!body)throw new Error('Source absent');body.scrollIntoView({block:'center'});const range=document.createRange();range.setStart(body.firstChild,0);range.setEnd(body.firstChild,3);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));})()`,
      );
      await waitFor(
        "document.querySelector('.message-selection-actions') !== null",
      );
      await settle();
      await screenshot(`${name}-selection-toolbar.png`);
      const quoteAction = await evaluate(
        "(() => {const button=[...document.querySelectorAll('.message-selection-actions button')].find(button=>button.textContent==='引用');const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()",
      );
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...quoteAction,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        clickCount: 1,
        ...quoteAction,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        clickCount: 1,
        ...quoteAction,
      });
      await waitFor("window.quoteFixture.getDraft().references.length === 1");
      assert.equal(
        await evaluate("window.quoteFixture.getSent().length"),
        0,
        "Quote never sends",
      );
      await send("Input.insertText", { text: "请解释这三个字。" });
      await waitFor(
        "window.quoteFixture.getDraft().text === '请解释这三个字。'",
      );
      await evaluate(
        "document.querySelector('#thread-composer').scrollIntoView({block:'end'})",
      );
      await settle();
      const draft = await evaluate(
        `(() => {const pill=document.querySelector('.composer-reference-rail .reference-token');const rect=pill.getBoundingClientRect();return {height:rect.height,radius:getComputedStyle(pill).borderRadius,excerpt:document.querySelector('.composer-reference-rail .reference-token-details > span').textContent,disclosure:!!document.querySelector('.composer-reference-rail .message-quote-expand'),overflow:document.documentElement.scrollWidth>innerWidth};})()`,
      );
      assert.equal(draft.radius, "999px");
      assert.equal(draft.height, desktop ? 28 : 48);
      assert.equal(draft.disclosure, false);
      assert.equal(draft.overflow, false);
      await screenshot(`${name}-draft.png`);
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
      await waitFor(
        "window.quoteFixture.getSent().length === 1 && document.querySelector('[data-sent-message-id=\"message-synthetic-send-1\"]') !== null",
      );
      await evaluate(
        "document.querySelector('[data-sent-message-id=\"message-synthetic-send-1\"]').scrollIntoView({block:'center'})",
      );
      await settle();
      const sent = await evaluate(
        `(() => {const row=document.querySelector('[data-sent-message-id="message-synthetic-send-1"]');return {height:row.querySelector('.reference-token').getBoundingClientRect().height,radius:getComputedStyle(row.querySelector('.reference-token')).borderRadius,text:row.textContent,excerpt:row.querySelector('.reference-token-details > span').textContent,remove:!!row.querySelector('.reference-token-remove'),draft:window.quoteFixture.getDraft(),raw:window.quoteFixture.getSent()[0],overflow:document.documentElement.scrollWidth>innerWidth};})()`,
      );
      assert.equal(sent.height, draft.height);
      assert.equal(sent.radius, "999px");
      assert.equal(sent.excerpt, draft.excerpt);
      assert.match(sent.text, /请解释这三个字/);
      assert.equal(sent.remove, false);
      assert.equal(
        await evaluate(
          "document.querySelector('.user-bubble .reference-token') === null && document.querySelector('.composer .reference-token') === null",
        ),
        true,
      );
      assert.equal(sent.draft.references.length, 0);
      assert.equal(sent.draft.text, "");
      assert.equal(sent.overflow, false);
      assert.deepEqual(
        await evaluate(
          "window.quoteFixture.getThread().canonicalItems.filter(item=>item.turnId==='turn-synthetic-send-1').map(item=>item.type)",
        ),
        ["turn_started", "user_message", "agent_message", "turn_completed"],
      );
      assert.equal(
        await evaluate("document.querySelector('.turn-outcome') === null"),
        true,
        "Local preview must not imply a failed backend send",
      );
      await screenshot(`${name}-sent.png`);
      evidence.scenes.push({ ...entry, capabilities, draft, sent });
      if (desktop) {
        await send("Page.navigate", {
          url: `${url}/quote-frame.html?references&theme=${entry.theme}${entry.width < 600 ? "&narrow" : ""}`,
        });
        await waitFor(
          "window.quoteFixture && document.querySelectorAll('.composer-reference-rail .reference-token').length === 5",
        );
        await evaluate("document.fonts.ready");
        await settle();
        assert.equal(await evaluate("window.quoteFixture.getSent().length"), 0);
        assert.equal(
          await evaluate(
            "document.querySelector('.composer .reference-token') === null",
          ),
          true,
        );
        assert.equal(
          await evaluate("document.documentElement.scrollWidth > innerWidth"),
          false,
        );
        await screenshot(`unified-${entry.theme}-${entry.width}-draft.png`);
        await evaluate("document.querySelector('#thread-composer').focus()");
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
        await waitFor(
          "window.quoteFixture.getSent().length === 1 && document.querySelectorAll('.sent-reference-rail .reference-token').length === 5",
        );
        assert.equal(
          await evaluate(
            "window.quoteFixture.getSent()[0] === window.quoteFixture.expectedPayload",
          ),
          true,
          "visible five-reference send exactly matches actual provider capture",
        );
        assert.equal(
          await evaluate(
            "document.querySelector('.user-bubble .reference-token') === null",
          ),
          true,
        );
        await evaluate(
          "document.querySelector('.sent-reference-rail').scrollIntoView({block:'center'})",
        );
        await settle();
        await screenshot(`unified-${entry.theme}-${entry.width}-sent.png`);
        if (entry.width === 420) {
          await send("Emulation.setDeviceMetricsOverride", {
            width: 420,
            height: 480,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await send("Page.navigate", {
            url: `${url}/quote-frame.html?references&stress&narrow`,
          });
          await waitFor(
            "Boolean(window.quoteFixture && document.querySelectorAll('.composer-reference-rail .reference-token').length === 15 && document.querySelectorAll('.composer-images img').length === 6 && document.querySelector('.queue-shelf'))",
          );
          await evaluate("document.fonts.ready");
          await settle();
          const reachability = await evaluate(`(async () => {
            const zone = document.querySelector('.bottom-zone');
            const targets = [...document.querySelectorAll('.composer-reference-rail .reference-token-details, .composer-images .remove-draft-image'), document.querySelector('#thread-composer')];
            const checks = [];
            for (const target of targets) {
              target.scrollIntoView({ block: 'center', inline: 'nearest' });
              await new Promise(resolve => requestAnimationFrame(resolve));
              const r = target.getBoundingClientRect(), z = zone.getBoundingClientRect();
              const x = r.x + r.width / 2, y = r.y + r.height / 2;
              checks.push({ visible: y >= z.top && y <= z.bottom && y >= 0 && y <= innerHeight, hit: target.contains(document.elementFromPoint(x, y)) });
            }
            return { checks, overflowY: getComputedStyle(zone).overflowY, scrollHeight: zone.scrollHeight, clientHeight: zone.clientHeight, horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
          })()`);
          assert.equal(reachability.horizontalOverflow, false);
          assert.equal(reachability.overflowY, "auto");
          assert.ok(
            reachability.checks.every((check) => check.visible && check.hit),
            "Every reference, image remove target and Composer must be reachable without clipping",
          );
          await screenshot("unified-short-queue-composer.png");
          await evaluate(
            "document.querySelector('.composer-reference-rail .reference-token-details').scrollIntoView({block:'center'})",
          );
          await settle();
          await screenshot("unified-short-queue-references.png");
          evidence.scenes.push({
            name: "short-queue-references-images",
            width: 420,
            height: 480,
            reachability,
          });
        }
      }
    },
  );
}
await writeFile(
  path.join(directory, "measurements.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(
  "Captured real-browser selection, compact desktop draft/sent states and separate touch-capability sizing with verified media queries.",
);
