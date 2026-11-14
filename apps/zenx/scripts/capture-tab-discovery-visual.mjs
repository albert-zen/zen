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
// Opt in only for the in-flow candidate; default preserves overlay baseline capture.
const inflowAcceptance = process.env.ZENX_EXPECT_INFLOW_REVEAL !== "0";
const results = [];
const lookalikeResults = [];
const crowdedConversationResults = [];
const crowdedRestingErrors = [];
const recordCrowdedRestingCheck = async (theme, stage, check) => {
  try {
    await check();
  } catch (error) {
    if (error?.code !== "ERR_ASSERTION") throw error;
    crowdedRestingErrors.push({ theme, stage, message: error.message });
  }
};
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
    const saveCrowdedWidths = async (theme, stage, captureTheme) => {
      const widths = await evaluate(`(() => {
  const width = element => element?.getBoundingClientRect().width ?? null;
  return {
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    desktop: matchMedia('(min-width: 721px)').matches,
    fontsStatus: document.fonts?.status,
    userAgent: navigator.userAgent,
    tabs: [...document.querySelectorAll('[role=tablist] [role=tab]')].map(tab => {
      const slot = tab.querySelector('.workspace-tab-label-box');
      const label = tab.querySelector('.workspace-tab-title');
      const full = tab.querySelector('.workspace-tab-title-probe');
      const candidate = tab.querySelector('.workspace-tab-candidate-probe');
      const font = getComputedStyle(label);
      const bare = tab.querySelector('.workspace-tab-bare-probe');
      return {
        id: tab.id, canonical: tab.getAttribute('aria-label'),
        selected: tab.getAttribute('aria-selected'),
        display: label.textContent, abbreviated: label.dataset.abbreviated === 'true',
        slotWidth: width(slot), slotClientWidth: slot?.clientWidth ?? null,
        fullWidth: width(full), candidateWidth: width(candidate),
        candidate: candidate?.textContent ?? null,
        bare: bare?.textContent ?? null, bareSuffixWidth: width(bare),
        labelClientWidth: label.clientWidth, labelScrollWidth: label.scrollWidth,
        font: font.font, letterSpacing: font.letterSpacing,
      };
    }),
  };
})()`);
      await writeFile(
        path.join(
          directory,
          `tabs-crowded-${captureTheme}-${stage}-widths.json`,
        ),
        JSON.stringify(
          {
            commit: manifest.commit,
            htmlSha256: manifest.artifact.htmlSha256,
            theme,
            stage,
            host: { platform: process.platform, arch: process.arch },
            ...widths,
          },
          null,
          2,
        ) + "\n",
      );
      return widths;
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
    // Assert fit of the actual resting labels, while checking canonical identity separately.
    const restingLabels = () =>
      evaluate(`[...document.querySelectorAll('[role=tablist] [role=tab]')].map(tab => {
      const label = tab.querySelector('.workspace-tab-title');
      const rect = label.getBoundingClientRect();
      return { id: tab.id, canonical: tab.getAttribute('aria-label'),
        compact: label.dataset.abbreviated === 'true', label: label.textContent,
        visible: rect.width > 0 && rect.height > 0 && getComputedStyle(label).visibility === 'visible',
        fits: label.scrollWidth <= label.clientWidth };
    })`);
    const waitForRestingLabels = (count) =>
      wait(
        `document.querySelectorAll('[role=tablist] [role=tab] .workspace-tab-title[data-abbreviated=true]').length === ${count}`,
      );
    const assertRestingLabels = (labels, names, endings, widths) => {
      assert.deepEqual(
        labels.map((tab) => tab.canonical),
        names,
        "ARIA keeps each canonical title",
      );
      assert.equal(
        new Set(
          labels.map((tab) =>
            tab.label
              .normalize("NFKC")
              .toLowerCase()
              .replace(/\s+/gu, " ")
              .trim(),
          ),
        ).size,
        names.length,
        "resting labels distinguish every conversation in the scenario",
      );
      labels.forEach((tab, index) => {
        assert.ok(
          tab.compact && tab.visible && tab.fits,
          "compact label must render untruncated: " + tab.id,
        );
        const marked = tab.label.startsWith("… ");
        const suffix = marked ? tab.label.slice(2) : tab.label;
        assert.ok(
          suffix.endsWith(endings[index]) && names[index].endsWith(suffix),
          "compact label shows a truthful distinguishing suffix: " + tab.id,
        );
        if (!widths) {
          assert.ok(marked, "roomy labels keep their ellipsis: " + tab.id);
          return;
        }
        const measured = widths.tabs[index];
        assert.equal(measured.id, tab.id);
        assert.ok(
          measured.slotClientWidth > 0 &&
            measured.fullWidth > measured.slotClientWidth + 1 &&
            measured.candidateWidth > 0 &&
            measured.bareSuffixWidth > 0,
          "full and compact widths are measured: " + tab.id,
        );
        const expected =
          measured.candidateWidth <= measured.slotClientWidth
            ? measured.candidate
            : measured.bareSuffixWidth <= measured.slotClientWidth
              ? measured.bare
              : null;
        assert.ok(expected, "a readable suffix fits: " + tab.id);
        assert.equal(
          tab.label,
          expected,
          "prefer the ellipsis when it fits: " + tab.id,
        );
      });
    };
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
          await waitForRestingLabels(names.length);
          const before = await readNames();
          const compactLabels = await restingLabels();
          const endings =
            language === "en" ? ["Alpha", "Beta"] : ["甲组", "乙组"];
          assertRestingLabels(compactLabels, names, endings);
          assert.deepEqual(
            before.sourceConversations.map((entry) => entry.title),
            names,
          );
          assert.equal(before.renderedThreadId, "synthetic-lookalike-1");
          assert.equal(before.conversationHeading, names[1]);
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
          await waitForRestingLabels(names.length);
          const compactAfterSelection = await restingLabels();
          assertRestingLabels(compactAfterSelection, names, endings);
          assert.deepEqual(
            compactAfterSelection.map((tab) => tab.label),
            compactLabels.map((tab) => tab.label),
            "selection does not rewrite resting labels",
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
            compactLabels,
            compactAfterSelection,
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
    for (const [language, theme] of [
      ["en", "light"],
      ["en", "dark"],
      ["zh", "light"],
      ["zh", "dark"],
    ]) {
      const captureTheme = language === "en" ? theme : `zh-${theme}`;
      await send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const destination = `${url}/ui-polish-visual.html?scene=auxiliary&tabLookalike=${language}&tabCrowded&lang=${language === "zh" ? "zh-CN" : "en"}&platform=darwin&theme=${theme}`;
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
      const contentGeometry = () =>
        evaluate(`(() => {
        const heading = document.querySelector('[role=tabpanel]:not([hidden]) .auxiliary-conversation-heading');
        const button = heading.querySelector('button');
        const rail = document.querySelector('[role=tablist]').getBoundingClientRect();
        const h = heading.getBoundingClientRect(), b = button.getBoundingClientRect();
        const popup = document.querySelector('${revealSelector}');
        const p = popup?.getBoundingClientRect();
        return { headingY:h.y, buttonY:b.y, railY:rail.y, railHeight:rail.height,
          fullscreenCenterHit:button.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)),
          revealHeight:p?.height ?? 0, maxShift:innerHeight/4 };
      })()`);
      const checkInflow = async (resting, label) => {
        const current = await contentGeometry();
        const measured = await measure();
        assert.ok(
          measured.targets.every((target) => target.overlapArea === 0),
          label + ": reveal does not cover heading/control/tabs",
        );
        assert.ok(
          current.fullscreenCenterHit,
          label + ": fullscreen center hits its own button",
        );
        const shift = current.headingY - resting.headingY;
        assert.ok(
          shift > 0 && shift <= current.maxShift + 1,
          label + ": bounded in-flow shift",
        );
        assert.ok(
          Math.abs(shift - current.revealHeight) <= 1,
          label + ": shift matches reveal height",
        );
        assert.ok(
          Math.abs(current.buttonY - resting.buttonY - shift) <= 1,
          label + ": control moves with heading",
        );
        assert.equal(current.railY, resting.railY);
        assert.equal(current.railHeight, resting.railHeight);
        return current;
      };
      const checkRestored = async (resting) => {
        const current = await contentGeometry();
        for (const field of ["headingY", "buttonY", "railY", "railHeight"]) {
          assert.ok(
            Math.abs(current[field] - resting[field]) <= 1,
            field + ": restored after Escape",
          );
        }
        assert.ok(
          current.fullscreenCenterHit,
          "fullscreen center remains reachable after dismissal",
        );
        return current;
      };
      const restingContent = await contentGeometry();
      const before = await state();
      assert.equal(before.sourceConversations.length, 5);
      const names = before.sourceConversations.map((tab) => tab.title);
      const endings =
        language === "en"
          ? ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]
          : ["甲组周报", "乙组复盘", "丙组方案", "丁组记录", "戊组清单"];
      try {
        await waitForRestingLabels(names.length);
      } catch (error) {
        if (!error?.message?.startsWith("Timed out: ")) throw error;
        crowdedRestingErrors.push({
          theme: captureTheme,
          stage: "initial-wait",
          message: error.message,
        });
      }
      const compactLabels = await restingLabels();
      const initialWidths = await saveCrowdedWidths(
        theme,
        "initial",
        captureTheme,
      );
      await screenshot(
        `tabs-crowded-conversations-${captureTheme}-resting.png`,
      );
      await recordCrowdedRestingCheck(captureTheme, "initial", () => {
        assertRestingLabels(compactLabels, names, endings, initialWidths);
        assert.ok(
          initialWidths.tabs.some(
            (tab) =>
              tab.candidateWidth > tab.slotClientWidth &&
              tab.bareSuffixWidth <= tab.slotClientWidth &&
              tab.abbreviated &&
              tab.display === tab.bare,
          ),
          "crowded scene actually exercises the bare suffix fallback",
        );
      });
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
      await screenshot(
        `tabs-crowded-conversations-${captureTheme}-pointer.png`,
      );
      const trajectory = [];
      if (inflowAcceptance) {
        const exposedContent = await checkInflow(
          restingContent,
          "pointer before crossing",
        );
        const pointerState = await state();
        // Eight actual input moves, including a checked midpoint, over nominal 160ms.
        // This crosses the real route rather than teleporting across the leave-grace gap.
        for (let step = 1; step <= 8; step++) {
          const fraction = step / 8;
          const x =
            point.x +
            (pointerReveal.x + pointerReveal.width / 2 - point.x) * fraction;
          const y =
            point.y +
            (pointerReveal.y + pointerReveal.height / 2 - point.y) * fraction;
          await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          await delay(20);
          const visible = await reveal();
          assert.equal(
            visible?.text,
            before.sourceConversations[1].title,
            "reveal survives crossing step " + step,
          );
          assert.ok(visible.visible, "reveal is visible mid-crossing");
          const content = await checkInflow(
            restingContent,
            "crossing step " + step,
          );
          assert.deepEqual(
            content,
            exposedContent,
            "content does not jump while crossing",
          );
          assert.deepEqual(await layoutGeometry(), restingGeometry);
          const currentState = await state();
          assert.equal(currentState.focus, pointerState.focus);
          assert.equal(currentState.selected, pointerState.selected);
          trajectory.push({ step, x, y, reveal: visible, content });
        }
      } else {
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: pointerReveal.x + pointerReveal.width / 2,
          y: pointerReveal.y + pointerReveal.height / 2,
        });
      }
      await delay(400);
      assert.equal(
        (await reveal())?.text,
        before.sourceConversations[1].title,
        "pointer transfer keeps reveal readable",
      );
      const beforePointerEscape = await state();
      await key("Escape", 27);
      await waitNoReveal();
      await delay(450);
      assert.equal(
        await reveal(),
        null,
        "Escape stays dismissed under pointer",
      );
      assert.deepEqual(await layoutGeometry(), restingGeometry);
      const afterPointerEscape = await state();
      assert.equal(afterPointerEscape.focus, beforePointerEscape.focus);
      assert.equal(afterPointerEscape.selected, beforePointerEscape.selected);
      assert.deepEqual(afterPointerEscape.openChangeRequests, []);
      const pointerRestored = inflowAcceptance
        ? await checkRestored(restingContent)
        : null;
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
      const keyboardContent = inflowAcceptance
        ? await checkInflow(restingContent, "keyboard End")
        : null;
      const keyboardGeometry = await layoutGeometry();
      await screenshot(
        `tabs-crowded-conversations-${captureTheme}-keyboard.png`,
      );
      await key("Escape", 27);
      await waitNoReveal();
      await delay(450);
      assert.equal(await reveal(), null);
      const escaped = await state();
      assert.equal(escaped.focus, end.focus);
      assert.equal(escaped.selected, end.selected);
      assert.deepEqual(await layoutGeometry(), keyboardGeometry);
      const endRestingLabels = await restingLabels();
      const endWidths = await saveCrowdedWidths(
        theme,
        "after-keyboard",
        captureTheme,
      );
      await screenshot(
        `tabs-crowded-conversations-${captureTheme}-end-resting.png`,
      );
      await recordCrowdedRestingCheck(captureTheme, "after-keyboard", () => {
        assertRestingLabels(endRestingLabels, names, endings, endWidths);
      });
      const keyboardRestored = inflowAcceptance
        ? await checkRestored(restingContent)
        : null;
      // Also exercise a fallback label at the selected tab's stronger weight.
      await key("ArrowLeft", 37);
      await wait(
        `document.activeElement?.id === 'aux-tab-thread:synthetic-lookalike-3' && window.__uiPolishAuxiliary.getState().selected === 'thread:synthetic-lookalike-3'`,
      );
      await key("ArrowLeft", 37);
      await wait(
        `document.activeElement?.id === 'aux-tab-thread:synthetic-lookalike-2' && window.__uiPolishAuxiliary.getState().selected === 'thread:synthetic-lookalike-2'`,
      );
      await waitReveal(names[2]);
      const middleLayout = await layoutGeometry();
      await key("Escape", 27);
      await waitNoReveal();
      await delay(450);
      assert.equal(await reveal(), null);
      const middle = await state();
      assert.equal(middle.focus, "aux-tab-thread:synthetic-lookalike-2");
      assert.equal(middle.renderedThreadId, "synthetic-lookalike-2");
      assert.equal(middle.heading, names[2]);
      assert.deepEqual(await layoutGeometry(), middleLayout);
      if (inflowAcceptance) await checkRestored(restingContent);
      const middleLabels = await restingLabels();
      const middleWidths = await saveCrowdedWidths(
        theme,
        "middle-selected",
        captureTheme,
      );
      await screenshot(
        `tabs-crowded-conversations-${captureTheme}-middle-resting.png`,
      );
      await recordCrowdedRestingCheck(captureTheme, "middle-selected", () => {
        assertRestingLabels(middleLabels, names, endings, middleWidths);
        assert.equal(middleWidths.tabs[2].selected, "true");
        assert.equal(
          middleLabels[2].label,
          endings[2],
          "the selected fallback retains its true identifier at the stronger weight",
        );
        for (const [index, label] of middleLabels.entries()) {
          assert.equal(
            label.label.replace(/^… /u, ""),
            compactLabels[index].label.replace(/^… /u, ""),
            "keyboard scrolling and selection preserve each resting identifier",
          );
        }
      });
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
        inflowAcceptance,
        trajectory,
        restingContent,
        compactLabels,
        endRestingLabels,
        pointerRestored,
        keyboardContent,
        keyboardRestored,
        language,
        theme,
        middle,
        middleLabels,
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
        "Production side-conversation tab and heading path populated through conversations with synthetic thread IDs and read-only body. No live child Thread, pending approval, rename editor or persistence coverage. Canonical ARIA titles, fitted and distinct resting suffixes, visual reveal contents and geometry are measured separately. aria-hidden duplication guard is not an AX-tree validation. Native tooltip suppression is intentional for these conversation tabs. Geometry is not visual suffix-recognition proof; inspect screenshots. No requirement that clipping remain in a later candidate.",
      lookalikeResults,
      crowdedConversationScope:
        "Desktop 1280x720, five English or Chinese synthetic conversations through production conversation tabs. Records bounding-box overlap and elementFromPoint hit stacks with current heading, heading text, fullscreen target and tabs; overlap is observational only when ZENX_EXPECT_INFLOW_REVEAL=0. By default this gates no overlap, fullscreen center hit, bounded/restored content displacement, and eight-step pointer crossing with midpoint samples. Center hit testing does not activate fullscreen. Not native desktop, live Host, mobile, rename, approval or AX-tree coverage.",
      crowdedConversationResults,
      crowdedRestingErrors,
    },
    null,
    2,
  ) + "\n",
);
assert.deepEqual(
  crowdedRestingErrors,
  [],
  "All five crowded resting labels must pass in both languages and themes; widths and screenshots are retained",
);
console.log("Tab discoverability visual and interaction checks passed.");
