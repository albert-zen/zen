import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, withPreviewBrowser } from "./preview-browser.mjs";

const directory = path.resolve(process.argv[2] ?? ".workspace-tab-overflow");
const evidence = {
  scope:
    "Actual production AuxiliaryPanel and WindowTitleBar, synthetic English/CJK labels and native-control markers only. No user files, profile, Host, or network; browser input and platform CSS, not native OS acceptance.",
  cases: [],
};
const measure = `(() => {
  const rect = e => { const r=e.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
  const rail=document.querySelector('.auxiliary-heading [role=tablist]');
  const r=rect(rail);
  const tabs=[...rail.querySelectorAll('.workspace-content-tab')].map(item=>{
    const tab=item.querySelector('[role=tab]'), icon=rect(tab.querySelector('svg')), bounds=rect(item);
    return {id:tab.id,active:tab.getAttribute('aria-selected')==='true',bounds,icon,iconlessLeading:bounds.left<r.left-1 && bounds.right>r.left+12 && icon.right<=r.left};
  });
  return {rail:r,scrollLeft:rail.scrollLeft,scrollWidth:rail.scrollWidth,clientWidth:rail.clientWidth,tabs,expanded:document.querySelector('.auxiliary-panel').dataset.expanded,focused:document.activeElement.id,pageWidth:document.documentElement.scrollWidth,controls:rect(document.querySelector('.window-titlebar-native-actions'))};
})()`;
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot }) => {
    const wait = async (expression) => {
      for (let n = 0; n < 200; n++) {
        if (await evaluate(expression)) return;
        await delay(50);
      }
      throw new Error("Timed out: " + expression);
    };
    const stable = () =>
      evaluate(
        `new Promise((resolve,reject)=>{let old='',count=0;const deadline=performance.now()+3000;const tick=()=>{if(performance.now()>deadline){reject(new Error('Tab rail did not settle within 3 seconds'));return;}const now=JSON.stringify(${measure});count=now===old?count+1:0;old=now;if(count>=4)resolve(true);else requestAnimationFrame(tick)};requestAnimationFrame(tick)})`,
      );
    try {
      for (const platform of ["darwin", "win32", "linux"])
        for (const width of [600, 760, 1440])
          for (const sidebar of ["closed", "open"]) {
            const name = `${platform}-${width}-${sidebar}`;
            const item = { name, states: [] };
            evidence.cases.push(item);
            await send("Emulation.setDeviceMetricsOverride", {
              width,
              height: 820,
              deviceScaleFactor: 1,
              mobile: false,
            });
            const destination = `${url}/titlebar-safe-area.html?${new URLSearchParams({ platform, sidebar, tabs: "overflow", lang: sidebar === "open" ? "zh-CN" : "en", theme: sidebar === "open" ? "dark" : "light" })}`;
            await send("Page.navigate", { url: destination });
            await wait(
              `location.href===${JSON.stringify(destination)} && document.body?.dataset.previewReady==='true'`,
            );
            for (const expanded of [false, true]) {
              if (expanded)
                await evaluate(
                  `document.querySelector('.auxiliary-heading > .icon-button[aria-pressed]').click()`,
                );
              for (let index = 0; index < 12; index++) {
                await evaluate(
                  `window.__titlebarPreview.setSelected('custom:synthetic-${index}')`,
                );
                await stable();
                const m = await evaluate(measure);
                assert.ok(m.pageWidth <= width, "no document overflow");
                if (platform === "darwin" && m.rail.top < 44) {
                  assert.ok(m.rail.left >= 127);
                  assert.ok(m.controls.right <= m.rail.left + 1);
                }
                assert.ok(
                  m.tabs.some(
                    (tab) =>
                      tab.active && tab.id.endsWith("synthetic-" + index),
                  ),
                );
                item.states.push({ index, expanded, ...m });
                if (
                  !item.fragment &&
                  m.tabs.some((tab) => tab.iconlessLeading)
                ) {
                  item.fragment = {
                    index,
                    expanded,
                    filename: `${name}-before.png`,
                  };
                  await screenshot(item.fragment.filename);
                }
              }
            }
            item.status = "observed";
          }
      const reproduced = evidence.cases.filter((item) => item.fragment);
      assert.ok(
        reproduced.length > 0,
        "current production component must reproduce an iconless leading fragment",
      );
      evidence.reproducedCases = reproduced.length;
      evidence.status = "baseline-reproduced";
    } catch (error) {
      evidence.status = "failed";
      evidence.failure = String(error);
      await screenshot("failure.png").catch((captureError) => {
        evidence.failureScreenshotError = String(captureError);
      });
      throw error;
    } finally {
      await writeFile(
        path.join(directory, "tab-overflow-measurements.json"),
        JSON.stringify(evidence, null, 2) + "\n",
      );
    }
  },
);
