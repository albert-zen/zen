import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, withPreviewBrowser } from "./preview-browser.mjs";
import {
  assertWorkspaceTabIconVisible,
  measureWorkspaceTabIcon,
} from "./workspace-tab-icon-visibility.mjs";
const directory = path.resolve(
  process.argv[2] ?? ".titlebar-safe-area-preview",
);
const evidence = {
  scope:
    "Real WindowTitleBar and AuxiliaryPanel; synthetic tabs/native dots. Darwin CSS in Linux Chrome, not native macOS window drag acceptance.",
  cases: [],
};
const measure = `(() => {
 const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
 const heading=document.querySelector('.auxiliary-heading'), rail=heading.querySelector('[role=tablist]'), button=document.querySelector('.sidebar-collapse-button');
 return {selectedIcon:(${measureWorkspaceTabIcon.toString()})(),heading:rect(heading),rail:rect(rail),titlebar:rect(document.querySelector('.window-titlebar')),controls:rect(document.querySelector('.window-titlebar-native-actions')),toggle:rect(button),toggleVisible:getComputedStyle(button).display!=='none',expanded:document.querySelector('.auxiliary-panel').dataset.expanded,collapsed:document.querySelector('.app-shell').classList.contains('sidebar-collapsed'),scrollLeft:rail.scrollLeft,scrollWidth:rail.scrollWidth,clientWidth:rail.clientWidth,headingDrag:getComputedStyle(heading).webkitAppRegion,railDrag:getComputedStyle(rail).webkitAppRegion,buttonDrag:getComputedStyle(button).webkitAppRegion,selected:rail.querySelector('[aria-selected=true]')?.id,pageWidth:document.documentElement.scrollWidth};
})()`;
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot }) => {
    const wait = async (expression) => {
      for (let n = 0; n < 200; n++) {
        if (await evaluate(expression)) return;
        await delay(50);
      }
      throw new Error(`Timed out: ${expression}`);
    };
    const stable = async () => {
      await evaluate(
        `new Promise(resolve=>{let old='',count=0;const tick=()=>{const now=JSON.stringify(${measure});count=now===old?count+1:0;old=now;if(count>=4)resolve(true);else requestAnimationFrame(tick)};requestAnimationFrame(tick)})`,
      );
    };
    const click = async (selector) => {
      const p = await evaluate(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2; if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw new Error('Obscured '+${JSON.stringify(selector)});return{x,y}})()`,
      );
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", {
          type,
          ...p,
          button: "left",
          clickCount: 1,
        });
    };
    const key = async (key, code, windowsVirtualKeyCode) => {
      await send("Input.dispatchKeyEvent", {
        type: key === "Enter" ? "keyDown" : "rawKeyDown",
        key,
        code,
        windowsVirtualKeyCode,
        ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code,
        windowsVirtualKeyCode,
      });
    };
    const safe = (m, platform, width) => {
      assert.ok(m.pageWidth <= width, "no document horizontal overflow");
      assert.equal(m.headingDrag, "drag");
      assert.equal(m.railDrag, "no-drag");
      assert.equal(m.buttonDrag, "no-drag");
      // Narrow Sidebar drawers intentionally cover the resource panel.
      if (width > 720 || m.collapsed)
        assertWorkspaceTabIconVisible(
          m.selectedIcon,
          platform === "darwin" && m.heading.y < 44
            ? m.titlebar.right
            : undefined,
        );
      if (platform === "darwin" && m.heading.y < 44) {
        assert.ok(
          m.rail.x >= 128 - 1,
          `Tab rail enters native leading region: ${JSON.stringify(m)}`,
        );
        assert.ok(m.titlebar.width >= 128);
        assert.ok(m.controls.right <= m.rail.x + 1);
      } else
        assert.ok(
          m.heading.y >= 44,
          "non-integrated workspace has separate native row",
        );
    };
    try {
      for (const platform of ["darwin", "win32", "linux"])
        for (const width of [600, 720, 721, 760, 1000, 1440])
          for (const sidebar of ["open", "closed"]) {
            const name = `${platform}-${width}-${sidebar}`;
            const item = { name, states: [] };
            evidence.cases.push(item);
            await send("Emulation.setDeviceMetricsOverride", {
              width,
              height: 820,
              deviceScaleFactor: 1,
              mobile: false,
            });
            const destination = `${url}/titlebar-safe-area.html?${new URLSearchParams({ platform, sidebar, theme: sidebar === "open" ? "dark" : "light" })}`;
            await send("Page.navigate", { url: destination });
            await wait(
              `location.href===${JSON.stringify(destination)}&&document.body?.dataset.previewReady==='true'`,
            );
            await stable();
            for (const expanded of [false, true, false, true]) {
              let m = await evaluate(measure);
              if ((m.expanded === "true") !== expanded) {
                await evaluate(
                  `window.__expandFrames=[];window.__expandSampling=true;requestAnimationFrame(function tick(){window.__expandFrames.push(${measure});if(window.__expandSampling)requestAnimationFrame(tick)})`,
                );
                await click(".auxiliary-heading > .icon-button[aria-pressed]");
                await stable();
                await evaluate("window.__expandSampling=false");
                const expandFrames = await evaluate("window.__expandFrames");
                assert.ok(
                  expandFrames.length > 0,
                  "expansion transition sampled",
                );
                for (const frame of expandFrames) safe(frame, platform, width);
                item.expansionAnimationFrames =
                  (item.expansionAnimationFrames ?? 0) + expandFrames.length;
                m = await evaluate(measure);
              }
              safe(m, platform, width);
              item.states.push(m);
              // The narrow sidebar is an intentional drawer over the workspace.
              if (width > 720 || sidebar === "closed") {
                await click('[role=tab][aria-selected="false"]');
                await stable();
                assert.ok(
                  (await evaluate(measure)).selected.endsWith("synthetic-1"),
                  "pointer selects another tab",
                );
                await key("End", "End", 35);
                await stable();
                m = await evaluate(measure);
                safe(m, platform, width);
                assert.ok(m.selected.endsWith("synthetic-11"));
                assert.ok(m.scrollLeft > 0, "End reveals overflowing last tab");
                await key("Home", "Home", 36);
                await stable();
                m = await evaluate(measure);
                assert.ok(m.selected.endsWith("synthetic-0"));
                safe(m, platform, width);
              }
              if (platform === "darwin" && (width === 760 || width === 1440))
                await screenshot(
                  `${name}-${expanded ? "expanded" : "normal"}.png`,
                );
            }
            if (width > 720) {
              await evaluate(
                `window.__safeFrames=[];window.__safeSampling=true;requestAnimationFrame(function tick(){window.__safeFrames.push(${measure});if(window.__safeSampling)requestAnimationFrame(tick)})`,
              );
              await click(".sidebar-collapse-button");
              await stable();
              await evaluate("window.__safeSampling=false");
              const frames = await evaluate("window.__safeFrames");
              for (const m of frames) safe(m, platform, width);
              item.animationFrames = frames.length;
              await click(".sidebar-collapse-button");
              await stable();
              safe(await evaluate(measure), platform, width);
            }
            item.status = "passed";
          }
      evidence.status = "passed";
    } catch (error) {
      evidence.status = "failed";
      evidence.failure = String(error);
      evidence.failureState = await evaluate(measure);
      await screenshot("failure.png");
      throw error;
    } finally {
      await writeFile(
        path.join(directory, "measurements.json"),
        JSON.stringify(evidence, null, 2) + "\n",
      );
    }
  },
);
