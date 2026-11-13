import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, withPreviewBrowser } from "./preview-browser.mjs";

const directory = path.resolve(process.argv[2] ?? ".ui-polish-visual");
const manifest = JSON.parse(
  await readFile(path.join(directory, "source.json"), "utf8"),
);
const html = await readFile(path.join(directory, manifest.artifact.html));
assert.equal(
  createHash("sha256").update(html).digest("hex"),
  manifest.artifact.htmlSha256,
);
process.env.ZENX_PREVIEW_DESKTOP_INPUT = "1";
const results = [];
const lookalikeResults = [];
const crowdedConversationResults = [];
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot }) => {
    const wait = async (expression) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(expression)) return;
        await delay(50);
      }
      throw new Error("Timed out: " + expression);
    };
    const geometry = () =>
      evaluate(`(() => {
    const rail = document.querySelector('[role="tablist"]');
    const viewport = rail.getBoundingClientRect();
    return {
      scroll: rail.scrollLeft,
      width: viewport.width,
      selected: document.querySelector('[aria-selected="true"]')?.id,
      overflowControls: document.querySelectorAll('.workspace-tabs-previous, .workspace-tabs-next').length,
      tabs: [...document.querySelectorAll('.workspace-content-tab')].map(tab => {
        const r = tab.getBoundingClientRect();
        const title = tab.querySelector('.workspace-tab-title').getBoundingClientRect();
        return { width: r.width, titleWidth: title.width, full: r.left >= viewport.left + 1 && r.right <= viewport.right - 1,
          background: getComputedStyle(tab).backgroundColor, border: getComputedStyle(tab).borderTopColor };
      })
    };
  })()`);
    // Existing hover/selection styling may change colors without moving layout.
    // Keep those colors in evidence and the original selection contrast checks.
    const layoutGeometry = async () => {
      const state = await geometry();
      return {
        ...state,
        tabs: state.tabs.map(({ width, titleWidth, full }) => ({
          width,
          titleWidth,
          full,
        })),
      };
    };
    const key = async (key, windowsVirtualKeyCode) => {
      for (const type of ["keyDown", "keyUp"]) {
        await send("Input.dispatchKeyEvent", {
          type,
          key,
          code: key,
          windowsVirtualKeyCode,
        });
      }
    };
    const revealSelector = ".workspace-conversation-title-reveal";
    const reveal = () =>
      evaluate(`(() => {
      const element = document.querySelector('${revealSelector}');
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { text: element.textContent, ariaHidden: element.getAttribute('aria-hidden'),
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
        fits: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
        x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`);
    const waitReveal = (text) =>
      wait(
        `document.querySelector('${revealSelector}')?.textContent === ${JSON.stringify(text)}`,
      );
    const waitNoReveal = () =>
      wait(`!document.querySelector('${revealSelector}')`);
    // Evidence baseline, not a claim that clipped titles are visually distinguishable.
    // Keep this separate so the existing distinct-title and many-tab checks stay intact.
    for (const language of ["en", "zh"]) {
      const names =
        language === "en"
          ? [
              "Cross-project implementation consistency and detailed interaction validation - Alpha",
              "Cross-project implementation consistency and detailed interaction validation - Beta",
            ]
          : [
              "跨项目实施一致性与详细交互验证甲组",
              "跨项目实施一致性与详细交互验证乙组",
            ];
      for (const width of [1280]) {
        for (const theme of ["light", "dark"]) {
          await send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 720,
            deviceScaleFactor: 1,
            mobile: false,
          });
          const destination = `${url}/ui-polish-visual.html?scene=auxiliary&tabLookalike=${language}&lang=${language === "zh" ? "zh-CN" : "en"}&platform=darwin&theme=${theme}`;
          await send("Page.navigate", { url: destination });
          await wait(
            `location.href === ${JSON.stringify(destination)} && document.body?.dataset.previewReady === 'true' && document.querySelectorAll('[role=tab]').length === 2`,
          );
          await delay(300);
          const readNames = () =>
            evaluate(`(() => {
            const rail = document.querySelector('[role="tablist"]');
            return {
              selected: window.__uiPolishAuxiliary.getState().selected,
              openChangeRequests: [...window.__uiPolishAuxiliary.getState().openChangeRequests],
              sourceConversations: window.__uiPolishAuxiliary.getState().sourceConversations,
              renderedThreadId: document.querySelector('[role="tabpanel"]:not([hidden]) [data-synthetic-thread-id]')?.getAttribute('data-synthetic-thread-id'),
              conversationHeading: document.querySelector('[role="tabpanel"]:not([hidden]) .auxiliary-conversation-heading > span')?.textContent,
              heading: document.getElementById(document.querySelector('[role="tab"][aria-selected="true"]').getAttribute('aria-controls'))?.querySelector('.auxiliary-conversation-heading > span')?.textContent ?? null,
              tabs: [...rail.querySelectorAll('[role="tab"]')].map(tab => {
                const label = tab.querySelector('.workspace-tab-title');
                const r = label.getBoundingClientRect();
                const tabRect = tab.getBoundingClientRect();
                const style = getComputedStyle(label);
                return { id: tab.id, title: tab.title, ariaLabelAttribute: tab.getAttribute('aria-label'),
                  text: label.textContent, titleClientWidth: label.clientWidth, titleScrollWidth: label.scrollWidth, tabWidth: tabRect.width,
                  labelRect: { x: r.x, y: r.y, width: r.width, height: r.height },
                  font: style.font, textOverflow: style.textOverflow, overflow: style.overflow,
                  focused: tab === document.activeElement, selected: tab.getAttribute('aria-selected') };
              })
            };
          })()`);
          const before = await readNames();
          assert.deepEqual(
            before.sourceConversations.map((entry) => entry.title),
            names,
          );
          assert.equal(before.renderedThreadId, "synthetic-lookalike-1");
          assert.equal(before.conversationHeading, names[1]);
          assert.deepEqual(
            before.tabs.map((tab) => tab.text),
            names,
            "DOM labels preserve full synthetic source names",
          );
          assert.ok(
            before.tabs.every((tab) => tab.title === ""),
            "conversation reveal replaces duplicate native title tooltip",
          );
          assert.equal(before.selected, "thread:synthetic-lookalike-1");
          assert.equal(
            before.heading,
            names[1],
            "selected content keeps the full Beta/乙组 source name",
          );
          assert.equal((await geometry()).overflowControls, 0);
          await screenshot(`tabs-lookalike-${language}-${width}-${theme}.png`);
          const restingGeometry = await layoutGeometry();
          const hoverPoint = before.tabs[0].labelRect;
          await send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: hoverPoint.x + hoverPoint.width / 2,
            y: hoverPoint.y + hoverPoint.height / 2,
          });
          await waitReveal(names[0]);
          const pointerReveal = await reveal();
          assert.ok(pointerReveal.visible && pointerReveal.fits);
          assert.equal(
            pointerReveal.ariaHidden,
            "true",
            "visual duplicate is not an extra accessible name",
          );
          assert.deepEqual(
            await layoutGeometry(),
            restingGeometry,
            "hover does not resize, scroll or select tabs",
          );
          assert.equal((await readNames()).selected, before.selected);
          await screenshot(
            `tabs-lookalike-${language}-${width}-${theme}-pointer-reveal.png`,
          );
          await send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: pointerReveal.x + pointerReveal.width / 2,
            y: pointerReveal.y + pointerReveal.height / 2,
          });
          await delay(400);
          assert.equal(
            (await reveal())?.text,
            names[0],
            "pointer can enter and read the reveal without dismissal",
          );
          await send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: 20,
            y: 500,
          });
          await waitNoReveal();
          const betaPoint = before.tabs[1].labelRect;
          await send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: betaPoint.x + betaPoint.width / 2,
            y: betaPoint.y + betaPoint.height / 2,
          });
          await waitReveal(names[1]);
          const pointerBetaReveal = await reveal();
          assert.ok(pointerBetaReveal.visible && pointerBetaReveal.fits);
          assert.equal(
            (await readNames()).selected,
            before.selected,
            "pointer inspection does not activate a conversation",
          );
          for (const type of ["mousePressed", "mouseReleased"]) {
            await send("Input.dispatchMouseEvent", {
              type,
              button: "left",
              clickCount: 1,
              x: betaPoint.x + betaPoint.width / 2,
              y: betaPoint.y + betaPoint.height / 2,
            });
          }
          await wait(
            `document.activeElement?.id === 'aux-tab-thread:synthetic-lookalike-1'`,
          );
          assert.equal(
            await evaluate(`document.activeElement.matches(':focus-visible')`),
            false,
            "real pointer click leaves Beta mouse-focused, not keyboard focus-visible",
          );
          await send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: hoverPoint.x + hoverPoint.width / 2,
            y: hoverPoint.y + hoverPoint.height / 2,
          });
          await waitReveal(names[0]);
          await key("Escape", 27);
          await waitNoReveal();
          await delay(450);
          assert.equal(
            await reveal(),
            null,
            "Escape stays dismissed while hovered",
          );
          const mouseFocusedEscape = await readNames();
          assert.equal(mouseFocusedEscape.selected, before.selected);
          assert.equal(
            mouseFocusedEscape.renderedThreadId,
            "synthetic-lookalike-1",
          );
          assert.ok(
            mouseFocusedEscape.tabs[1].focused,
            "Escape dismisses inactive Alpha reveal without moving mouse focus from Beta",
          );
          assert.deepEqual(
            mouseFocusedEscape.openChangeRequests,
            [],
            "Escape with a reveal must not request workspace closure",
          );
          await send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: 20,
            y: 500,
          });
          await send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: hoverPoint.x + hoverPoint.width / 2,
            y: hoverPoint.y + hoverPoint.height / 2,
          });
          await waitReveal(names[0]);
          assert.deepEqual(
            await layoutGeometry(),
            restingGeometry,
            "repeated pointer inspection preserves layout and selection",
          );
          await send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: 20,
            y: 500,
          });
          await waitNoReveal();
          await evaluate(
            `document.querySelector('[role="tab"][aria-selected="true"]').focus()`,
          );
          for (const type of ["keyDown", "keyUp"]) {
            await send("Input.dispatchKeyEvent", {
              type,
              key: "ArrowLeft",
              code: "ArrowLeft",
              windowsVirtualKeyCode: 37,
            });
          }
          await wait(
            `window.__uiPolishAuxiliary.getState().selected === 'thread:synthetic-lookalike-0' && document.activeElement?.id === 'aux-tab-thread:synthetic-lookalike-0' && document.querySelector('[role=tabpanel]:not([hidden]) [data-synthetic-thread-id]')?.getAttribute('data-synthetic-thread-id') === 'synthetic-lookalike-0'`,
          );
          const after = await readNames();
          assert.deepEqual(
            after.sourceConversations,
            before.sourceConversations,
            "keyboard selection leaves full synthetic source names and IDs intact",
          );
          assert.equal(after.renderedThreadId, "synthetic-lookalike-0");
          assert.equal(after.conversationHeading, names[0]);
          assert.ok(after.tabs.every((tab) => tab.title === ""));
          assert.equal(
            after.heading,
            names[0],
            "keyboard selection opens Alpha/甲组 content",
          );
          assert.deepEqual(
            after.tabs.map((tab) => tab.text),
            names,
            "selection does not rewrite source names",
          );
          assert.ok(
            after.tabs[0].focused,
            "keyboard navigation focuses the Alpha/甲组 identity",
          );
          assert.equal(after.tabs[0].selected, "true");
          await waitReveal(names[0]);
          const keyboardReveal = await reveal();
          assert.ok(keyboardReveal.visible && keyboardReveal.fits);
          assert.equal(keyboardReveal.ariaHidden, "true");
          const keyboardGeometry = await layoutGeometry();
          await screenshot(
            `tabs-lookalike-${language}-${width}-${theme}-keyboard.png`,
          );
          await key("Escape", 27);
          await waitNoReveal();
          await delay(450);
          assert.equal(
            await reveal(),
            null,
            "Escape stays dismissed while focused",
          );
          assert.deepEqual(
            await layoutGeometry(),
            keyboardGeometry,
            "Escape preserves geometry and selection",
          );
          const escaped = await readNames();
          assert.equal(escaped.selected, after.selected);
          assert.ok(escaped.tabs[0].focused);
          assert.deepEqual(
            escaped.sourceConversations,
            before.sourceConversations,
          );
          await key("ArrowRight", 39);
          await waitReveal(names[1]);
          await key("ArrowLeft", 37);
          await waitReveal(names[0]);
          const repeated = await readNames();
          assert.equal(repeated.selected, after.selected);
          assert.equal(repeated.renderedThreadId, "synthetic-lookalike-0");
          assert.ok(repeated.tabs[0].focused);
          assert.deepEqual(
            repeated.sourceConversations,
            before.sourceConversations,
          );
          await key("Escape", 27);
          await waitNoReveal();
          lookalikeResults.push({
            language,
            width,
            theme,
            names,
            before,
            after,
            pointerReveal,
            pointerBetaReveal,
            mouseFocusedEscape,
            keyboardReveal,
            escaped,
            repeated,
            geometry: await geometry(),
          });
        }
      }
    }
    // Desktop-only genuine conversations, unlike the legacy five custom tabs below.
    // Overlap is an observed baseline, deliberately NOT a no-overlap assertion.
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const destination = `${url}/ui-polish-visual.html?scene=auxiliary&tabLookalike=en&tabCrowded&lang=en&platform=darwin&theme=${theme}`;
      await send("Page.navigate", { url: destination });
      await wait(
        `location.href === ${JSON.stringify(destination)} && document.body?.dataset.previewReady === 'true' && document.querySelectorAll('[role=tab]').length === 5`,
      );
      await delay(300);
      const state = () =>
        evaluate(`(() => {
        const rail = document.querySelector('[role=tablist]');
        const panel = document.querySelector('[role=tabpanel]:not([hidden])');
        return { ...window.__uiPolishAuxiliary.getState(),
          focus: document.activeElement?.id,
          renderedThreadId: panel.querySelector('[data-synthetic-thread-id]')?.dataset.syntheticThreadId,
          heading: panel.querySelector('.auxiliary-conversation-heading > span')?.textContent,
          scroll: rail.scrollLeft, clientWidth: rail.clientWidth, scrollWidth: rail.scrollWidth };
      })()`);
      const measure = () =>
        evaluate(`(() => {
        const popup = document.querySelector('${revealSelector}');
        const panel = document.querySelector('[role=tabpanel]:not([hidden])');
        const rect = el => { const r = el.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom }; };
        const describe = el => el ? { tag:el.tagName,id:el.id,className:el.className,role:el.getAttribute('role'),label:el.getAttribute('aria-label') } : null;
        const hit = (x,y) => ({ x,y, top:describe(document.elementFromPoint(x,y)), stack:document.elementsFromPoint(x,y).slice(0,8).map(describe), revealWins:popup.contains(document.elementFromPoint(x,y)) });
        const pr = rect(popup);
        const targets = [panel.querySelector('.auxiliary-conversation-heading'), panel.querySelector('.auxiliary-conversation-heading > span'), panel.querySelector('.auxiliary-conversation-heading button'), ...document.querySelectorAll('[role=tab]')];
        return { reveal:pr, revealCenterHit:hit(pr.x+pr.width/2,pr.y+pr.height/2), targets:targets.map(el => {
          const r=rect(el), x=Math.max(r.x,pr.x), y=Math.max(r.y,pr.y), right=Math.min(r.right,pr.right), bottom=Math.min(r.bottom,pr.bottom);
          const w=Math.max(0,right-x), h=Math.max(0,bottom-y);
          return { target:describe(el),rect:r,overlapArea:w*h,
            centerHit:hit(r.x+r.width/2,r.y+r.height/2),
            overlapHit:w*h ? hit(x+w/2,y+h/2) : null };
        }) };
      })()`);
      const before = await state();
      assert.equal(before.sourceConversations.length, 5);
      assert.ok(
        before.scrollWidth > before.clientWidth,
        "genuine conversation strip overflows",
      );
      assert.ok(
        (await geometry()).tabs.some((tab) => !tab.full),
        "some genuine conversations are clipped",
      );
      assert.equal(before.renderedThreadId, "synthetic-lookalike-1");
      assert.equal(before.heading, before.sourceConversations[1].title);
      const restingGeometry = await layoutGeometry();
      const point = await evaluate(`(() => {
        const rail = document.querySelector('[role=tablist]').getBoundingClientRect();
        const tab = document.getElementById('aux-tab-thread:synthetic-lookalike-1');
        const r = tab.querySelector('.workspace-tab-title').getBoundingClientRect();
        const x = (Math.max(r.left,rail.left)+Math.min(r.right,rail.right))/2;
        const y = r.top+r.height/2;
        return {x,y,hit:tab.contains(document.elementFromPoint(x,y))};
      })()`);
      assert.ok(point.hit, "hover uses a real visible conversation target");
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
      });
      await waitReveal(before.sourceConversations[1].title);
      const pointerReveal = await reveal();
      assert.ok(pointerReveal.visible && pointerReveal.fits);
      const pointerMeasurement = await measure();
      assert.deepEqual(await layoutGeometry(), restingGeometry);
      await screenshot(`tabs-crowded-conversations-${theme}-pointer.png`);
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: pointerReveal.x + pointerReveal.width / 2,
        y: pointerReveal.y + pointerReveal.height / 2,
      });
      await delay(400);
      assert.equal(
        (await reveal())?.text,
        before.sourceConversations[1].title,
        "pointer transfer keeps reveal readable",
      );
      await key("Escape", 27);
      await waitNoReveal();
      await delay(450);
      assert.equal(
        await reveal(),
        null,
        "Escape stays dismissed under pointer",
      );
      assert.deepEqual(await layoutGeometry(), restingGeometry);
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 20,
        y: 500,
      });
      await evaluate(
        `document.getElementById('aux-tab-thread:synthetic-lookalike-1').focus()`,
      );
      await key("End", 35);
      await wait(
        `document.activeElement?.id === 'aux-tab-thread:synthetic-lookalike-4' && window.__uiPolishAuxiliary.getState().selected === 'thread:synthetic-lookalike-4'`,
      );
      await wait(
        `(() => { const r=document.querySelector('[role=tablist]').getBoundingClientRect(); const t=document.activeElement.getBoundingClientRect(); return t.left>=r.left+1 && t.right<=r.right-1; })()`,
      );
      await waitReveal(before.sourceConversations[4].title);
      await delay(300);
      assert.equal(
        (await reveal())?.text,
        before.sourceConversations[4].title,
        "keyboard reveal survives auto-scroll settling",
      );
      const end = await state();
      assert.ok(
        end.scroll > before.scroll,
        "keyboard auto-scroll exposes last conversation",
      );
      assert.equal(end.renderedThreadId, "synthetic-lookalike-4");
      assert.equal(end.heading, before.sourceConversations[4].title);
      const keyboardReveal = await reveal();
      assert.ok(keyboardReveal.visible && keyboardReveal.fits);
      const keyboardMeasurement = await measure();
      const keyboardGeometry = await layoutGeometry();
      await screenshot(`tabs-crowded-conversations-${theme}-keyboard.png`);
      await key("Escape", 27);
      await waitNoReveal();
      await delay(450);
      assert.equal(await reveal(), null);
      const escaped = await state();
      assert.equal(escaped.focus, end.focus);
      assert.equal(escaped.selected, end.selected);
      assert.deepEqual(await layoutGeometry(), keyboardGeometry);
      await key("Home", 36);
      await wait(
        `document.activeElement?.id === 'aux-tab-thread:synthetic-lookalike-0' && document.querySelector('[role=tablist]').scrollLeft < 2`,
      );
      await waitReveal(before.sourceConversations[0].title);
      const home = await state();
      assert.equal(home.selected, "thread:synthetic-lookalike-0");
      assert.equal(home.renderedThreadId, "synthetic-lookalike-0");
      assert.deepEqual(home.sourceConversations, before.sourceConversations);
      assert.deepEqual(home.openChangeRequests, []);
      assert.deepEqual(
        home.writes,
        [],
        "inspection and keyboard navigation do not reorder or persist tabs",
      );
      await key("Escape", 27);
      await waitNoReveal();
      crowdedConversationResults.push({
        theme,
        width: 1280,
        before,
        pointerReveal,
        pointerMeasurement,
        end,
        keyboardReveal,
        keyboardMeasurement,
        escaped,
        home,
      });
    }
    for (const [width, platform, theme] of [
      [1280, "darwin", "light"],
      [1280, "darwin", "dark"],
      [390, "darwin", "light"],
      [1280, "win32", "light"],
    ]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 720,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const destination = `${url}/ui-polish-visual.html?scene=auxiliary&tabDiscovery&lang=zh-CN&platform=${platform}&theme=${theme}`;
      await send("Page.navigate", { url: destination });
      await wait(
        `location.href === ${JSON.stringify(destination)} && document.body?.dataset.previewReady === 'true' && document.querySelectorAll('[role=tab]').length === 2`,
      );
      await delay(300);
      const state = await geometry();
      assert.ok(
        state.tabs.every((tab) => tab.titleWidth >= 40),
        "tab labels keep a readable minimum",
      );
      if (width > 720) {
        assert.ok(
          state.tabs.every((tab) => tab.full),
          "both long tabs fit in the normal side panel",
        );
      } else {
        assert.ok(
          state.tabs.some((tab) => tab.full),
          "the narrow panel shows a whole tab",
        );
      }
      assert.equal(state.overflowControls, 0, "no added overflow indicators");
      assert.notEqual(
        state.tabs[0].background,
        state.tabs[1].background,
        "selection is visibly distinct",
      );
      await screenshot(`tabs-two-${platform}-${width}-${theme}.png`);
      results.push({ width, platform, theme, state });
    }
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const destination = `${url}/ui-polish-visual.html?scene=auxiliary&platform=darwin`;
    await send("Page.navigate", { url: destination });
    await wait(
      `location.href === ${JSON.stringify(destination)} && document.body?.dataset.previewReady === 'true' && document.querySelectorAll('[role=tab]').length === 5`,
    );
    await delay(300);
    const start = await geometry();
    assert.equal(
      start.overflowControls,
      0,
      "overflow uses the existing clipped strip",
    );
    assert.ok(
      start.tabs.some((tab) => !tab.full),
      "many tabs retain clipping after reaching their minimum width",
    );
    assert.ok(
      start.tabs.every((tab) => tab.width < results[0].state.tabs[0].width),
      "more tabs shrink before overflowing",
    );
    const point = await evaluate(`(() => {
      const r = document.querySelector('[role="tablist"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...point,
      deltaX: 220,
      deltaY: 0,
    });
    await wait("document.querySelector('[role=tablist]').scrollLeft > 0");
    const moved = await geometry();
    assert.ok(moved.scroll > start.scroll);
    assert.equal(
      moved.selected,
      start.selected,
      "manual horizontal scrolling preserves resource selection",
    );
    assert.equal(moved.overflowControls, 0);
    await screenshot("tabs-many-scrolled.png");
    await evaluate(`document.querySelector('[aria-selected="true"]').focus()`);
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "End",
      code: "End",
      windowsVirtualKeyCode: 35,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "End",
      code: "End",
      windowsVirtualKeyCode: 35,
    });
    await delay(100);
    const end = await geometry();
    assert.ok(end.tabs.at(-1).full);
    assert.equal(
      end.overflowControls,
      0,
      "keyboard navigation adds no overflow indicator",
    );
    await screenshot("tabs-many-last-selected.png");
    results.push({ many: { start, moved, end } });
  },
);
await writeFile(
  path.join(directory, "tab-discovery-results.json"),
  JSON.stringify(
    {
      commit: manifest.commit,
      source: manifest,
      scope:
        "Production AuxiliaryPanel/styles; synthetic tab data and information control; Chromium renderer, not a native OS window.",
      results,
      lookalikeScope:
        "Production side-conversation tab and heading path populated through conversations with synthetic thread IDs and read-only body. No live child Thread, pending approval, rename editor or persistence coverage. Full DOM text, visual reveal contents and geometry are measured separately. aria-hidden duplication guard is not an AX-tree validation. Native tooltip suppression is intentional for these conversation tabs. Geometry is not visual suffix-recognition proof; inspect screenshots. No requirement that clipping remain in a later candidate.",
      lookalikeResults,
      crowdedConversationScope:
        "Desktop 1280x720, five synthetic conversations through production conversation tabs. Records bounding-box overlap and elementFromPoint hit stacks with current heading, heading text, fullscreen target and tabs; overlap is not a pass/fail gate. Not native desktop, live Host, mobile, rename, approval or AX-tree coverage.",
      crowdedConversationResults,
    },
    null,
    2,
  ) + "\n",
);
console.log("Tab discoverability visual and interaction checks passed.");
