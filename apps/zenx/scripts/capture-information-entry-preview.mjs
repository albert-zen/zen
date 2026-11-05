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
    return {heading:box('.auxiliary-heading'), slot:box('.auxiliary-information-slot'), button:box('.information-toolbar button'), titlebar:box('.window-titlebar-session'), toolbarHidden:document.querySelector('.information-toolbar').hidden, chat:box('.agent-surface'), dock:box('.information-dock'), overlay:box('.information-popover'), draft:document.querySelector('#synthetic-composer').value, identity:window.__entryComposer===document.querySelector('#synthetic-composer'), order:!!(document.querySelector('.information-toolbar').compareDocumentPosition(document.querySelector('.auxiliary-panel')) & Node.DOCUMENT_POSITION_FOLLOWING)};
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
        `location.href===${JSON.stringify(destination)}&&document.body.dataset.previewReady==='true'&&!!document.querySelector('.information-toolbar button')`,
      );
      await evaluate(
        "window.__entryComposer=document.querySelector('#synthetic-composer');true",
      );
      await click(".information-toolbar button");
      await wait("!!document.querySelector('.information-dock')");
      const normal = await measure();
      assert.ok(normal.chat.right <= normal.dock.x);
      await evaluate("window.__titlebarPreview.setOpen(true)");
      await wait(
        "document.querySelector('.auxiliary-panel').dataset.open==='true' && document.querySelector('.information-toolbar button').getAttribute('aria-pressed')==='false'",
      );
      await delay(250);
      for (let repeat = 0; repeat < 2; repeat++) {
        await click(".information-toolbar button");
        await wait("!!document.querySelector('.information-popover')");
        const split = await measure();
        verifySlot(split, "split");
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
      for (let repeat = 0; repeat < 2; repeat++) {
        await click(".information-toolbar button");
        await wait("!!document.querySelector('.information-dock')");
        const full = await measure();
        verifySlot(full, "maximized-main");
        assert.ok(
          full.chat.right <= full.dock.x,
          "full main docks without covering conversation",
        );
        evidence.cases.push({
          platform,
          mode: "maximized-main",
          repeat,
          ...full,
        });
        if (repeat === 0)
          await screenshot(`information-entry-${platform}-main.png`);
        await click(".information-toolbar button");
        await wait("!document.querySelector('.information-dock')");
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
