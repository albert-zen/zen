/** Only synthetic production-component UI; no real Host/model/tools. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".fork-feedback-preview");
const cases = [];
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot, errors }) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1120,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const lang of ["en", "zh-CN"]) {
      await send("Page.navigate", {
        url: `${url}/fork-feedback-preview.html?lang=${lang}`,
      });
      for (let i = 0; i < 60; i++) {
        if (await evaluate("!!document.querySelector('.message-fork')")) break;
        await delay(50);
      }
      assert.equal(
        await evaluate(
          "document.querySelector('.turn-toggle')?.getAttribute('aria-expanded')",
        ),
        "false",
      );
      assert.equal(
        await evaluate(
          "!!document.querySelector('[data-read-message-id=final]')",
        ),
        true,
      );
      await evaluate(
        "document.querySelector('.message-fork').focus(); document.querySelector('.message-fork').click(); document.querySelector('.message-fork').click()",
      );
      await delay(50);
      const pending = await evaluate(
        "({disabled:document.querySelector('.message-fork').disabled, busy:document.querySelector('.message-fork').getAttribute('aria-busy'), label:document.querySelector('.message-fork').getAttribute('aria-label'), title:document.querySelector('.message-fork').title, spinner:!!document.querySelector('.message-fork .mini-spinner'), requests:document.querySelector('header').textContent})",
      );
      assert.equal(pending.disabled, true);
      assert.equal(pending.busy, "true");
      assert.equal(pending.spinner, true);
      assert.equal(pending.label, pending.title);
      assert.match(pending.requests, /1 fork request/);
      await screenshot(`${lang}-fork-pending.png`);
      await evaluate("window.__forkPreview.fail()");
      await delay(50);
      assert.equal(
        await evaluate("document.querySelector('.message-fork').disabled"),
        false,
      );
      assert.equal(
        await evaluate(
          "!!document.querySelector('.message-fork-error[role=alert]')",
        ),
        true,
      );
      assert.equal(
        await evaluate(
          "!!document.querySelector('[data-read-message-id=final]')",
        ),
        true,
      );
      await screenshot(`${lang}-fork-error.png`);
      await evaluate("document.querySelector('.message-fork').click()");
      await delay(50);
      await evaluate("window.__forkPreview.complete()");
      await delay(100);
      assert.equal(
        await evaluate(
          "document.querySelector('.turn-toggle')?.getAttribute('aria-expanded')",
        ),
        "false",
      );
      assert.equal(
        await evaluate(
          "!!document.querySelector('[data-read-message-id=final]')",
        ),
        true,
      );
      assert.match(
        await evaluate("document.querySelector('header').textContent"),
        /Copied thread/,
      );
      await screenshot(`${lang}-fork-final-visible.png`);
      cases.push({
        lang,
        pending,
        finalVisibleWithCollapsedProcess: true,
        failurePreservesSource: true,
      });
    }
    assert.deepEqual(errors, []);
  },
);
await writeFile(
  path.join(directory, "measurements.json"),
  JSON.stringify(
    {
      scope:
        "Production ThreadView only; synthetic delayed fork. Core semantics covered separately; not full App/IPC/native acceptance.",
      cases,
    },
    null,
    2,
  ),
);
console.log(
  "Synthetic fork spinner, error retention, duplicate guard and visible final verified.",
);
