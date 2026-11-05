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
    },
    null,
    2,
  ) + "\n",
);
console.log("Tab discoverability visual and interaction checks passed.");
