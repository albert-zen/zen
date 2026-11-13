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
          assert.deepEqual(
            before.tabs.map((tab) => tab.title),
            names,
            "full names remain available in native title metadata",
          );
          assert.equal(before.selected, "thread:synthetic-lookalike-1");
          assert.equal(
            before.heading,
            names[1],
            "selected content keeps the full Beta/乙组 source name",
          );
          assert.equal((await geometry()).overflowControls, 0);
          await screenshot(`tabs-lookalike-${language}-${width}-${theme}.png`);
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
          assert.deepEqual(
            after.tabs.map((tab) => tab.title),
            names,
          );
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
          await screenshot(
            `tabs-lookalike-${language}-${width}-${theme}-keyboard.png`,
          );
          lookalikeResults.push({
            language,
            width,
            theme,
            names,
            before,
            after,
            geometry: await geometry(),
          });
        }
      }
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
        "Production side-conversation tab and heading path populated through conversations with synthetic thread IDs and read-only body. No live child Thread, pending approval, rename editor or persistence coverage. Full DOM text and title attribute are measured separately, not an AX tree or tooltip popup measurement. Geometry is not visual suffix-recognition proof; inspect screenshots. No requirement that clipping remain in a later candidate.",
      lookalikeResults,
    },
    null,
    2,
  ) + "\n",
);
console.log("Tab discoverability visual and interaction checks passed.");
