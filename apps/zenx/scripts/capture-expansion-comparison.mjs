import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, withPreviewBrowser } from "./expansion-preview-browser.mjs";
const directory = path.resolve(process.argv[2]);
const version = process.argv[3];
// Page.navigate may return while the previous document or an empty new document is current.
function readinessExpression(expectedUrl) {
  return `location.href === ${JSON.stringify(expectedUrl)} && document.body?.dataset.previewReady === "true" && Boolean(document.querySelector('.auxiliary-panel[data-open="true"][data-expanded="false"] .auxiliary-heading [role="tablist"]'))`;
}

const measure = `(() => {
 const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
 const describe=e=>{if(!e)return null;const s=getComputedStyle(e);return {tag:e.tagName,id:e.id,className:typeof e.className==='string'?e.className:e.className.baseVal,bounds:rect(e),visibility:s.visibility,display:s.display,zIndex:s.zIndex,pointerEvents:s.pointerEvents,overflowX:s.overflowX}};
 const rail=document.querySelector('.auxiliary-heading [role=tablist]'),rr=rect(rail),p=document.querySelector('.auxiliary-panel');
 const tabs=[...document.querySelectorAll('.workspace-content-tab')].map(item=>{const tab=item.querySelector('[role=tab]'),svg=tab.querySelector('svg'),ir=rect(svg),b=rect(item),x=ir.left+ir.width/2,y=ir.top+ir.height/2;return {id:item.dataset.tabId,active:tab.getAttribute('aria-selected')==='true',bounds:b,icon:ir,iconInsideRail:ir.left>=rr.left&&ir.right<=rr.right,iconHit:svg.contains(document.elementFromPoint(x,y)),hitInTab:tab.contains(document.elementFromPoint(x,y)),iconPartialRailOverlap:ir.right>rr.left&&ir.left<rr.right&&(ir.left<rr.left||ir.right>rr.right),hitStack:document.elementsFromPoint(x,y).slice(0,7).map(describe)}});
 return {time:performance.now(),expanded:p.dataset.expanded,panel:rect(p),rail:rr,scrollLeft:rail.scrollLeft,scrollWidth:rail.scrollWidth,clientWidth:rail.clientWidth,endGap:rail.style.getPropertyValue('--workspace-tab-end-gap'),tabs,firstVisibleTab:tabs.find(t=>t.bounds.right>rr.left&&t.bounds.left<rr.right)?.id,firstResourceTab:tabs.find(t=>t.id!=='primary-conversation')?.id,chrome:['.window-titlebar','.window-titlebar-session','.window-titlebar-drag'].map(s=>({selector:s,...describe(document.querySelector(s))}))};
})()`;
const evidence = {
  version,
  scope:
    "Actual version-specific components and CSS, real CDP mouse click; synthetic data and platform markers, NOT native Electron/OS or user installation. Geometry sampled every animation frame; PNG timestamps are actual capture timing, not guaranteed exact frame targets.",
  cases: [],
};
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot }) => {
    const wait = async (expression) => {
      for (let n = 0; n < 100; n++) {
        if (await evaluate(expression)) return;
        await delay(30);
      }
      throw Error("Timed out " + expression);
    };
    // Bounded cases: all three platform styles, one resource at two widths; one 3-resource supplement.
    const cases = [
      ...["darwin", "win32", "linux"].flatMap((platform) =>
        [1440, 1100].map((width) => ({ platform, width, resources: 1 })),
      ),
      { platform: "darwin", width: 1100, resources: 3 },
    ];
    for (const c of cases) {
      const name = `${version}-${c.platform}-${c.width}-${c.resources}resource`;
      await send("Emulation.setDeviceMetricsOverride", {
        width: c.width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const targetUrl = `${url}/titlebar-safe-area.html?platform=${c.platform}&subject=plugin&resources=${c.resources}&state=durable&sidebar=open&lang=en`;
      await send("Page.navigate", { url: targetUrl });
      await wait(readinessExpression(targetUrl));
      await delay(350);
      const before = await evaluate(measure);
      assert.equal(before.expanded, "false");
      assert.equal(before.tabs.length, c.resources);
      assert.ok(before.firstResourceTab.startsWith("plugin:"));
      await screenshot(`${name}-before.png`);
      const point = await evaluate(
        `(()=>{const e=document.querySelector('.auxiliary-heading > button[aria-pressed="false"]'),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Expand button obscured');return {x,y}})()`,
      );
      await evaluate(
        `(()=>{window.__expandFrames=[];window.__expandStarted=performance.now();const tick=()=>{window.__expandFrames.push(${measure});if(performance.now()-window.__expandStarted<750)requestAnimationFrame(tick)};requestAnimationFrame(tick)})()`,
      );
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...point,
        button: "left",
        clickCount: 1,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button: "left",
        clickCount: 1,
      });
      const images = [];
      for (const target of [0, 70, 160]) {
        const elapsed = await evaluate(
          "performance.now()-window.__expandStarted",
        );
        if (elapsed < target) await delay(target - elapsed);
        const sample = await evaluate(measure);
        const file = `${name}-transition-${target}.png`;
        await screenshot(file);
        images.push({
          file,
          targetMs: target,
          measuredElapsedMs:
            sample.time - (await evaluate("window.__expandStarted")),
          sample,
          captureFinishedElapsedMs: await evaluate(
            "performance.now()-window.__expandStarted",
          ),
        });
      }
      await wait("performance.now()-window.__expandStarted >= 800");
      const settled = await evaluate(measure);
      await screenshot(`${name}-settled.png`);
      assert.equal(settled.expanded, "true");
      assert.equal(
        settled.tabs.length,
        c.resources + (version === "current" ? 1 : 0),
      );
      assert.equal(
        settled.tabs.some((t) => t.id === "primary-conversation"),
        version === "current",
      );
      const frames = await evaluate("window.__expandFrames");
      evidence.cases.push({ ...c, name, before, images, settled, frames });
      await writeFile(
        path.join(directory, "measurements.json"),
        JSON.stringify(evidence, null, 2) + "\n",
      );
    }
  },
);
