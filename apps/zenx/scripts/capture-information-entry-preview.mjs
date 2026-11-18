import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, withPreviewBrowser } from "./preview-browser.mjs";

const directory = path.resolve(
  process.argv[2] ?? ".titlebar-safe-area-preview",
);
const evidence = {
  scope:
    "Production titlebar, information host and auxiliary panel in production DOM order. Synthetic content only. Chromium pointer and computed native exclusion geometry; not macOS OS hit testing.",
  cases: [],
};
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot }) => {
    const wait = async (expression) => {
      for (let n = 0; n < 160; n++) {
        if (await evaluate(expression)) return;
        await delay(25);
      }
      throw Error(`Timed out: ${expression}`);
    };
    const click = async (selector) => {
      const point = await evaluate(`(() => {
      const e=document.querySelector(${JSON.stringify(selector)}), r=e.getBoundingClientRect(), x=r.x+r.width/2,y=r.y+r.height/2;
      if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('Obscured target');
      return {x,y};
    })()`);
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", {
          type,
          ...point,
          button: "left",
          clickCount: 1,
        });
      await delay(100);
    };
    const measure = async () =>
      evaluate(`(() => {
    const box=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,region:getComputedStyle(e).webkitAppRegion}};
    return {heading:box('.auxiliary-heading'), slot:box('.auxiliary-information-slot'), button:box('.information-toolbar button'), titlebar:box('.window-titlebar-session'), toolbarHidden:document.querySelector('.information-toolbar').hidden, chat:box('.agent-surface'), composer:box('#synthetic-composer'), overlay:box('.information-popover'), draft:document.querySelector('#synthetic-composer').value, identity:window.__entryComposer===document.querySelector('#synthetic-composer'), order:!!(document.querySelector('.information-toolbar').compareDocumentPosition(document.querySelector('.auxiliary-panel')) & Node.DOCUMENT_POSITION_FOLLOWING)};
  })()`);
    const verifySlot = (geometry, mode) => {
      assert.equal(
        geometry.order,
        true,
        "fixture matches App's information-before-resource DOM order",
      );
      assert.equal(geometry.heading.region, "drag");
      assert.equal(geometry.slot.region, "no-drag");
      assert.equal(geometry.toolbarHidden, false);
      const { slot, button, heading, titlebar } = geometry;
      assert.equal(button.region, "no-drag");
      if (mode === "split") {
        assert.equal(
          slot.width,
          0,
          "resource controls reserve no information slot in split mode",
        );
        assert.ok(
          Math.abs(button.right - (heading.x - 8)) <= 1,
          "entry sits at the main conversation's trailing edge before the divider",
        );
        assert.ok(
          button.x >= titlebar.x &&
            button.right <= titlebar.right &&
            button.y >= titlebar.y &&
            button.bottom <= titlebar.bottom,
          "entry stays in its own main-conversation title row",
        );
      } else {
        assert.ok(slot.width > 0);
        assert.ok(
          slot.x <= button.x + 1 &&
            slot.right >= button.right - 1 &&
            slot.y <= button.y + 1 &&
            slot.bottom >= button.bottom - 1,
          "maximized main heading excludes the complete information button: " +
            JSON.stringify({ slot, button }),
        );
      }
      assert.equal(geometry.identity, true);
      assert.equal(
        geometry.draft,
        "Keep this unsent draft through all panel states.",
      );
    };
    const verifyFloating = (open, closed, mode) => {
      assert.deepEqual(open.chat, closed.chat, "card does not resize chat");
      assert.deepEqual(
        open.composer,
        closed.composer,
        "card does not resize Composer",
      );
      const { overlay, chat, button, titlebar, heading } = open;
      assert.ok(
        overlay.width > 0 && overlay.height > 0,
        "visible floating card",
      );
      assert.ok(
        overlay.x >= chat.x - 1 && overlay.right <= chat.right + 1,
        "card stays entirely on the conversation side",
      );
      assert.ok(
        overlay.y >= Math.max(button.bottom, titlebar.bottom) - 1,
        "floating card stays below conversation controls",
      );
      if (mode === "split")
        assert.ok(
          overlay.right <= heading.x + 1,
          "card leaves workspace unobstructed",
        );
      assert.equal(open.identity, true);
      assert.equal(open.draft, closed.draft, "draft survives opening the card");
    };
    for (const platform of ["darwin", "win32", "linux"]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const destination = `${url}/titlebar-safe-area.html?${new URLSearchParams({ platform, sidebar: "open", count: "short", information: "true", resource: "closed" })}`;
      await send("Page.navigate", { url: destination });
      await wait(
        `location.href===${JSON.stringify(destination)}&&document.body?.dataset.previewReady==='true'&&!!document.querySelector('.information-toolbar button')`,
      );
      await evaluate(
        "window.__entryComposer=document.querySelector('#synthetic-composer');true",
      );
      const normalClosed = await measure();
      await click(".information-toolbar button");
      await wait("!!document.querySelector('.information-popover')");
      const normal = await measure();
      verifyFloating(normal, normalClosed, "workspace-closed");
      evidence.cases.push({ platform, mode: "workspace-closed", ...normal });
      await screenshot(`information-entry-${platform}-workspace-closed.png`);
      await evaluate("window.__titlebarPreview.setOpen(true)");
      await wait(
        "document.querySelector('.auxiliary-panel').dataset.open==='true' && document.querySelector('.information-toolbar button').getAttribute('aria-pressed')==='false'",
      );
      await delay(250);
      const splitClosed = await measure();
      for (let repeat = 0; repeat < 2; repeat++) {
        await click(".information-toolbar button");
        await wait("!!document.querySelector('.information-popover')");
        const split = await measure();
        verifySlot(split, "split");
        verifyFloating(split, splitClosed, "split");
        evidence.cases.push({ platform, mode: "split", repeat, ...split });
        if (repeat === 0)
          await screenshot(`information-entry-${platform}-split.png`);
        await click(".information-toolbar button");
        await wait("!document.querySelector('.information-popover')");
      }
      await click('.auxiliary-heading button[aria-label="Expand side panel"]');
      await wait("document.querySelector('.information-toolbar').hidden");
      await click('[data-tab-id="primary-conversation"] [role="tab"]');
      await wait("!document.querySelector('.information-toolbar').hidden");
      const fullClosed = await measure();
      for (let repeat = 0; repeat < 2; repeat++) {
        await click(".information-toolbar button");
        await wait("!!document.querySelector('.information-popover')");
        const full = await measure();
        verifySlot(full, "maximized-main");
        verifyFloating(full, fullClosed, "maximized-main");
        evidence.cases.push({
          platform,
          mode: "maximized-main",
          repeat,
          ...full,
        });
        if (repeat === 0)
          await screenshot(`information-entry-${platform}-main.png`);
        await click(".information-toolbar button");
        await wait("!document.querySelector('.information-popover')");
      }
      await click('[data-tab-id="custom:synthetic-0"] [role="tab"]');
      await wait("document.querySelector('.information-toolbar').hidden");
      assert.equal(
        await evaluate(
          "document.querySelector('.information-toolbar button').getAttribute('aria-pressed')",
        ),
        "false",
      );
    }
  },
);
await writeFile(
  path.join(directory, "information-entry-result.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(`Verified ${evidence.cases.length} information entry states`);
