import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, withPreviewBrowser } from "./preview-browser.mjs";
import {
  assertWorkspaceTabIconVisible,
  measureWorkspaceTabIcon,
} from "./workspace-tab-icon-visibility.mjs";

const directory = path.resolve(process.argv[2] ?? ".workspace-tab-overflow");
const baseline = process.argv.includes("--baseline");
const evidence = {
  mode: baseline ? "baseline" : "fixed",
  scope:
    "Actual production AuxiliaryPanel and WindowTitleBar, synthetic English/CJK labels and native-control markers only. No user files, profile, Host, or network; browser input and platform CSS, not native OS acceptance.",
  cases: [],
};
const measure = `(() => {
  const rect = e => { const r=e.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
  const rail=document.querySelector('.auxiliary-heading [role=tablist]');
  const r=rect(rail),spacer=getComputedStyle(rail,"::after");
  const tabs=[...rail.querySelectorAll('.workspace-content-tab')].map(item=>{
    const tab=item.querySelector('[role=tab]'), icon=rect(tab.querySelector('svg')), bounds=rect(item);
    return {id:tab.id,active:tab.getAttribute('aria-selected')==='true',bounds,icon,iconlessLeading:bounds.left<r.left-1 && bounds.right>r.left+12 && icon.right<=r.left};
  });
  const chrome=['.window-titlebar','.window-titlebar-session','.window-titlebar-drag'].map(selector=>{const e=document.querySelector(selector);if(!e)return {selector,bounds:null};const s=getComputedStyle(e);return {selector,bounds:rect(e),visibility:s.visibility,pointerEvents:s.pointerEvents,opacity:s.opacity};});
  return {selectedIcon:(${measureWorkspaceTabIcon.toString()})(),sidebarDrawerOpen:document.documentElement.clientWidth<=720&&!document.querySelector(".app-shell").classList.contains("sidebar-collapsed"),platform:document.documentElement.dataset.platform,rail:r,chrome,spacer:{basis:spacer.flexBasis,transitionProperty:spacer.transitionProperty,transitionDuration:spacer.transitionDuration},endGap:rail.style.getPropertyValue("--workspace-tab-end-gap"),scrollLeft:rail.scrollLeft,scrollWidth:rail.scrollWidth,clientWidth:rail.clientWidth,tabs,expanded:document.querySelector('.auxiliary-panel').dataset.expanded,focused:document.activeElement.id,pageWidth:document.documentElement.scrollWidth,controls:rect(document.querySelector('.window-titlebar-native-actions'))};
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
    const click = async (selector) => {
      const p = await evaluate(`(() => {
        const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
        const rail=e.closest('[role=tablist]')?.getBoundingClientRect();
        const left=Math.max(r.left,rail?.left??r.left),right=Math.min(r.right,rail?.right??r.right);
        const x=(left+right)/2,y=r.top+r.height/2;
        if(right<=left||!e.contains(document.elementFromPoint(x,y))){
          const describe=node=>{if(!node)return null;const b=node.getBoundingClientRect(),s=getComputedStyle(node);return {tag:node.tagName,id:node.id,className:String(node.className).slice(0,160),bounds:{left:b.left,right:b.right,top:b.top,bottom:b.bottom},style:{width:s.width,pointerEvents:s.pointerEvents,visibility:s.visibility,opacity:s.opacity,zIndex:s.zIndex,transitionProperty:s.transitionProperty,transitionDuration:s.transitionDuration},animations:node.getAnimations().slice(0,4).map(a=>({playState:a.playState,currentTime:a.currentTime,transitionProperty:a.transitionProperty??null}))};};
          throw new Error('Obscured '+${JSON.stringify(selector)}+' '+JSON.stringify({point:{x,y},target:describe(e),stack:document.elementsFromPoint(x,y).slice(0,6).map(describe),chrome:['.window-titlebar','.window-titlebar-session','.window-titlebar-drag'].map(s=>({selector:s,...describe(document.querySelector(s))}))}));
        }
        return {x,y};
      })()`);
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", {
          type,
          ...p,
          button: "left",
          clickCount: 1,
        });
      await stable();
    };
    const key = async (key, code, windowsVirtualKeyCode) => {
      for (const type of ["rawKeyDown", "keyUp"])
        await send("Input.dispatchKeyEvent", {
          type,
          key,
          code,
          windowsVirtualKeyCode,
        });
      await stable();
    };
    const valid = (m) => {
      if (!m.sidebarDrawerOpen)
        assertWorkspaceTabIconVisible(
          m.selectedIcon,
          m.platform === "darwin" && m.rail.top < 44
            ? m.chrome.find((item) => item.selector === ".window-titlebar")
                ?.bounds?.right
            : undefined,
        );
      assert.equal(
        m.spacer.transitionProperty,
        "none",
        "layout spacer never animates, including reduced motion",
      );
      assert.equal(
        m.rail.height,
        34,
        "overflow keeps the existing single-row height",
      );
      assert.ok(
        m.tabs.every((tab) => tab.bounds.height === 30),
        "tabs never wrap into another row",
      );
      assert.ok(
        !m.tabs.some((tab) => tab.iconlessLeading),
        "automatic reveal must not leave iconless leading titles",
      );
      const active = m.tabs.find((tab) => tab.active);
      assert.ok(active, "an active tab remains available");
      assert.ok(
        active.bounds.left >= m.rail.left - 1,
        "active tab icon remains visible",
      );
      if (active.bounds.width <= m.clientWidth)
        assert.ok(
          active.bounds.right <= m.rail.right + 1,
          "active tab close control remains visible",
        );
    };
    try {
      for (const platform of ["darwin", "win32", "linux"])
        for (const width of [360, 600, 760, 1440])
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
            await send("Emulation.setEmulatedMedia", {
              features: [
                {
                  name: "prefers-reduced-motion",
                  value: sidebar === "open" ? "reduce" : "no-preference",
                },
              ],
            });
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
                if (!baseline) valid(m);
                if (
                  !baseline &&
                  index === 4 &&
                  (width > 720 || sidebar === "closed")
                )
                  await screenshot(
                    `${name}-${expanded ? "expanded" : "normal"}-after.png`,
                  );
                if (
                  baseline &&
                  !item.fragment &&
                  (width > 720 || sidebar === "closed") &&
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
            if (!baseline && (width > 720 || sidebar === "closed")) {
              item.interactionModes = [];
              for (const expanded of [false, true]) {
                if ((await evaluate(measure)).expanded !== String(expanded))
                  await click(
                    ".auxiliary-heading > .icon-button[aria-pressed]",
                  );
                const interaction = { expanded };
                item.interactionModes.push(interaction);
                await evaluate(
                  "window.__titlebarPreview.setTabs(Array.from({length:12},(_,i)=>'custom:synthetic-'+i));window.__titlebarPreview.setSelected('custom:synthetic-0')",
                );
                await stable();
                evidence.phase = `${name}/${expanded ? "expanded" : "normal"}: first pointer`;
                await click('[id="aux-tab-custom:synthetic-1"]');
                assert.ok(
                  (await evaluate(measure)).tabs[1].active,
                  "pointer selects a partially visible trailing tab",
                );
                for (const [k, c, v, index] of [
                  ["End", "End", 35, 11],
                  ["Home", "Home", 36, 0],
                  ["ArrowRight", "ArrowRight", 39, 1],
                  ["ArrowLeft", "ArrowLeft", 37, 0],
                ]) {
                  await key(k, c, v);
                  const m = await evaluate(measure);
                  valid(m);
                  assert.ok(m.tabs[index].active);
                  assert.equal(m.focused, `aux-tab-custom:synthetic-${index}`);
                }
                const r = (await evaluate(measure)).rail;
                await send("Input.dispatchMouseEvent", {
                  type: "mouseWheel",
                  x: r.left + r.width / 2,
                  y: r.top + r.height / 2,
                  deltaX: 87,
                  deltaY: 0,
                });
                await delay(250);
                await stable();
                const manual = await evaluate(measure);
                assert.ok(
                  manual.scrollLeft > 0,
                  "native horizontal wheel remains available",
                );
                assert.ok(
                  manual.tabs[0].active,
                  "manual scrolling does not select another tab",
                );
                interaction.manualScroll = manual.scrollLeft;
                await evaluate(
                  "window.__titlebarPreview.setSelected('custom:synthetic-11')",
                );
                await stable();
                valid(await evaluate(measure));
                // Acceptance must also pass without the independent diagnostic
                // observer/RAF sampler below, whose extra reads can affect timing.
                evidence.phase = `${name}: resize without diagnostic sampling`;
                for (const resizedWidth of [width + 80, width]) {
                  await send("Emulation.setDeviceMetricsOverride", {
                    width: resizedWidth,
                    height: 820,
                    deviceScaleFactor: 1,
                    mobile: false,
                  });
                  await stable();
                  valid(await evaluate(measure));
                }
                interaction.uninstrumentedResize =
                  "wider and back passed without diagnostic sampling";
                evidence.phase = `${name}: resize wider`;
                await evaluate(`(() => {
                window.__tabOverflowResize=[]; let recording=true,raf=0,dropped=0;
                const record=phase=>{if(window.__tabOverflowResize.length<256)window.__tabOverflowResize.push({phase,...${measure}});else dropped++;};
                const observer=new ResizeObserver(()=>record('observer'));
                observer.observe(document.querySelector('.auxiliary-heading [role=tablist]'));
                const tick=()=>{if(recording){record('frame');raf=requestAnimationFrame(tick)}};
                raf=requestAnimationFrame(tick);
                window.__stopTabOverflowResize=()=>{recording=false;cancelAnimationFrame(raf);observer.disconnect();return {samples:window.__tabOverflowResize,dropped,scope:'Read-only independent ResizeObserver/RAF geometry sampling; extra reads may affect layout timing. Diagnostic results are not fix acceptance.'}};
              })()`);
                await send("Emulation.setDeviceMetricsOverride", {
                  width: width + 80,
                  height: 820,
                  deviceScaleFactor: 1,
                  mobile: false,
                });
                await stable();
                valid(await evaluate(measure));
                evidence.phase = `${name}: resize back`;
                await send("Emulation.setDeviceMetricsOverride", {
                  width,
                  height: 820,
                  deviceScaleFactor: 1,
                  mobile: false,
                });
                await stable();
                valid(await evaluate(measure));
                interaction.resizeSamples = await evaluate(
                  "window.__stopTabOverflowResize()",
                );
                evidence.phase = `${name}: owner reorder`;
                await evaluate(
                  "window.__titlebarPreview.setTabs(Array.from({length:12},(_,i)=>'custom:synthetic-'+(11-i)))",
                );
                await stable();
                valid(await evaluate(measure));
                assert.ok(
                  (await evaluate(measure)).tabs[0].active,
                  "owner reorder preserves selection",
                );
                await evaluate(
                  "window.__titlebarPreview.setTabs(Array.from({length:12},(_,i)=>'custom:synthetic-'+i));window.__titlebarPreview.setSelected('custom:synthetic-4')",
                );
                await stable();
                for (let cycle = 0; cycle < 2; cycle++) {
                  await click(
                    '.workspace-content-tab[data-active="true"] .workspace-tab-close',
                  );
                  assert.equal((await evaluate(measure)).tabs.length, 11);
                  await click(".workspace-add-tab");
                  if (cycle === 0) {
                    const probe = (which = "first") =>
                      evaluate(`(() => {
                    const first=document.querySelector(${JSON.stringify(which === "last" ? ".workspace-tab-types > button:last-of-type" : ".workspace-tab-types > button")}),r=first.getBoundingClientRect();
                    const x=r.left+r.width/2,y=r.top+r.height/2;
                    return {top:r.top,bottom:r.bottom,focused:document.activeElement===first,reachable:y>=0&&y<innerHeight&&first.contains(document.elementFromPoint(x,y)),scrolls:[...document.querySelectorAll('.auxiliary-panel *')].filter(e=>e.scrollHeight>e.clientHeight+1).map(e=>({className:e.className,top:e.scrollTop,height:e.clientHeight,scrollHeight:e.scrollHeight}))};
                  })()`);
                    const before = await probe();
                    const body = await evaluate(
                      `(() => {const r=document.querySelector('.auxiliary-body').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+Math.min(200,r.height/2)}})()`,
                    );
                    await send("Input.dispatchMouseEvent", {
                      type: "mouseWheel",
                      ...body,
                      deltaX: 0,
                      deltaY: -2000,
                    });
                    await delay(250);
                    const afterWheel = await probe();
                    // Start at the already-focused plus control and use real Tab
                    // navigation, not programmatic focus/scroll, to reach choice one.
                    let afterKeyboard = afterWheel;
                    for (let n = 0; n < 12 && !afterKeyboard.focused; n++) {
                      await key("Tab", "Tab", 9);
                      afterKeyboard = await probe();
                    }
                    interaction.firstChoiceProbe = {
                      before,
                      afterWheel,
                      afterKeyboard,
                    };
                    assert.equal(
                      afterWheel.reachable,
                      true,
                      "first chooser choice is reachable by native scrolling",
                    );
                    assert.equal(
                      afterKeyboard.focused,
                      true,
                      "native Tab reaches the first choice",
                    );
                    assert.equal(
                      afterKeyboard.reachable,
                      true,
                      "first chooser keyboard focus is visible",
                    );
                    if (platform === "darwin" && width === 760)
                      await screenshot(
                        `${name}-${expanded ? "expanded" : "normal"}-chooser-first-after.png`,
                      );
                    {
                      await click(".workspace-tab-types > button");
                      assert.ok(
                        (await evaluate(measure)).tabs.some(
                          (tab) => tab.active && tab.id.endsWith("synthetic-0"),
                        ),
                      );
                      await click(".workspace-add-tab");
                    }
                    await send("Input.dispatchMouseEvent", {
                      type: "mouseWheel",
                      ...body,
                      deltaX: 0,
                      deltaY: 2000,
                    });
                    await delay(250);
                    const lastAfterWheel = await probe("last");
                    let lastAfterKeyboard = lastAfterWheel;
                    for (let n = 0; n < 32 && !lastAfterKeyboard.focused; n++) {
                      await key("Tab", "Tab", 9);
                      lastAfterKeyboard = await probe("last");
                    }
                    interaction.lastChoiceProbe = {
                      afterWheel: lastAfterWheel,
                      afterKeyboard: lastAfterKeyboard,
                    };
                    assert.equal(
                      lastAfterWheel.reachable,
                      true,
                      "last chooser choice is reachable by native scrolling",
                    );
                    assert.equal(
                      lastAfterKeyboard.focused,
                      true,
                      "native Tab reaches the last choice",
                    );
                    assert.equal(
                      lastAfterKeyboard.reachable,
                      true,
                      "last chooser keyboard focus is visible",
                    );
                    if (platform === "darwin" && width === 760)
                      await screenshot(
                        `${name}-${expanded ? "expanded" : "normal"}-chooser-last-after.png`,
                      );
                    await send("Input.dispatchMouseEvent", {
                      type: "mouseWheel",
                      ...body,
                      deltaX: 0,
                      deltaY: -2000,
                    });
                    await delay(250);
                  }
                  // Reopen the closed middle type after independently checking
                  // both menu ends through real scrolling and keyboard navigation.
                  await click(".workspace-tab-types > button:nth-of-type(5)");
                  const m = await evaluate(measure);
                  valid(m);
                  assert.equal(m.tabs.length, 12);
                  assert.equal(m.focused, "aux-tab-custom:synthetic-4");
                }
                await click(".workspace-add-tab");
                await key("Escape", "Escape", 27);
                assert.equal(
                  await evaluate(
                    "document.querySelector('.auxiliary-panel').dataset.open",
                  ),
                  "true",
                );
                valid(await evaluate(measure));
                interaction.interactions =
                  "pointer, keyboard, manual horizontal wheel, resize, owner reorder, close/reopen twice, chooser Escape";
              }
            }
            item.status = baseline ? "observed" : "passed";
          }
      if (!baseline) {
        evidence.shortChoosers = [];
        for (const theme of ["light", "dark"]) {
          evidence.phase = `short chooser ${theme}`;
          await send("Emulation.setDeviceMetricsOverride", {
            width: 760,
            height: 820,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await send("Emulation.setEmulatedMedia", {
            features: [
              {
                name: "prefers-reduced-motion",
                value: theme === "dark" ? "reduce" : "no-preference",
              },
            ],
          });
          const destination = `${url}/titlebar-safe-area.html?${new URLSearchParams({ platform: "darwin", sidebar: "closed", tabs: "overflow", count: "short", theme, lang: theme === "dark" ? "zh-CN" : "en" })}`;
          await send("Page.navigate", { url: destination });
          await wait(
            `location.href===${JSON.stringify(destination)}&&document.body?.dataset.previewReady==='true'`,
          );
          await stable();
          await click(".workspace-add-tab");
          const m = await evaluate(`(() => {
            const body=document.querySelector('.workspace-new-tab').getBoundingClientRect(),menu=document.querySelector('.workspace-tab-types').getBoundingClientRect();
            const reachable=e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};
            return {body:{top:body.top,height:body.height},menu:{top:menu.top,height:menu.height},first:reachable(document.querySelector('.workspace-tab-types > button')),last:reachable(document.querySelector('.workspace-tab-types > button:last-of-type'))};
          })()`);
          evidence.shortChoosers.push({ theme, ...m });
          assert.ok(
            m.menu.height < m.body.height,
            "short menu fits the viewport",
          );
          assert.ok(
            Math.abs(
              m.menu.top + m.menu.height / 2 - m.body.top - m.body.height / 2,
            ) <= 1,
            "short chooser remains vertically centered",
          );
          assert.ok(
            m.first && m.last,
            "short menu actions remain visible and hit-testable",
          );
          await screenshot(`short-chooser-${theme}-after.png`);
        }
      }
      const reproduced = evidence.cases.filter((item) => item.fragment);
      if (baseline)
        assert.ok(
          reproduced.length > 0,
          "current production component must reproduce an iconless leading fragment",
        );
      evidence.reproducedCases = reproduced.length;
      evidence.status = baseline ? "baseline-reproduced" : "passed";
    } catch (error) {
      evidence.status = "failed";
      evidence.failure = String(error);
      evidence.failureState = await evaluate(measure).catch((reason) => ({
        error: String(reason),
      }));
      evidence.resizeSamples = await evaluate(
        "window.__stopTabOverflowResize?.() ?? []",
      ).catch(() => []);
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
