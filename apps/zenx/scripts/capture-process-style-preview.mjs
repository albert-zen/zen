import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".process-style-preview");
const matrix = [
  {
    scene: "thinking",
    theme: "light",
    width: 1280,
    height: 900,
    lang: "zh-CN",
  },
  { scene: "waiting", theme: "dark", width: 1280, height: 900, lang: "zh-CN" },
  { scene: "thinking", theme: "dark", width: 420, height: 900, lang: "zh-CN" },
  { scene: "waiting", theme: "light", width: 420, height: 900, lang: "zh-CN" },
  ...["running", "approval", "stopping", "recovery"].map((scene) => ({
    scene,
    theme: "light",
    width: 1280,
    height: 900,
    lang: "zh-CN",
  })),
  ...["thinking", "running", "waiting", "approval", "stopping", "recovery"].map(
    (scene) => ({ scene, theme: "dark", width: 1280, height: 900, lang: "en" }),
  ),
];
const measure = `(() => {
  const turn = document.querySelector('.turn');
  const header = turn?.querySelector(':scope > .turn-running-label, :scope > .turn-toggle');
  const history = turn?.querySelector(':scope > .turn-history');
  const row = history?.querySelector('.trace-toggle, .trace-item-toggle, .trace-item-static');
  const content = row?.querySelector('.activity-content');
  const label = content?.querySelector('.activity-label');
  const icon = content?.querySelector('.trace-tool-icons, svg');
  const rect = element => element ? { x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height } : null;
  return { baseColor: content ? getComputedStyle(content).color : null, iconColor: icon ? getComputedStyle(icon).color : null, labelColor: label ? getComputedStyle(label).color : null, sweepColor: row?.querySelector(".activity-sweep") ? getComputedStyle(row.querySelector(".activity-sweep")).color : null, text: header?.textContent, workLabel: header?.querySelector('.turn-work-label')?.textContent, workLabelX: header?.querySelector('.turn-work-label')?.getBoundingClientRect().x, headerIcons: header?.querySelectorAll('svg').length, phase: header?.getAttribute('data-phase'), header: rect(header), history: rect(history), row: rect(row), icon: rect(icon), label: rect(label), gap: icon && label ? label.getBoundingClientRect().left - icon.getBoundingClientRect().right : null, headerIndex: turn && header ? [...turn.children].indexOf(header) : -1, totalInsideHistory: !!history?.querySelector('.turn-duration'), footer: !!document.querySelector('.turn-status-footer'), overflow: document.documentElement.scrollWidth > innerWidth, activeSweep: row?.querySelector('.activity-text')?.dataset.animating, sweepMask: row?.querySelector('.activity-sweep') ? getComputedStyle(row.querySelector('.activity-sweep')).maskImage : null, sweepDisplay: row?.querySelector('.activity-sweep') ? getComputedStyle(row.querySelector('.activity-sweep')).display : null };
})()`;
const evidence = {
  source:
    "Synthetic data; production Sidebar, ThreadView, ActivityText and CSS. No Host actions.",
  scenes: [],
};
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot }) => {
    for (const entry of matrix) {
      const name = `${entry.scene}-${entry.theme}-${entry.width}${entry.lang === "en" ? "-en" : ""}`;
      await send("Emulation.setDeviceMetricsOverride", {
        width: entry.width,
        height: entry.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Page.navigate", {
        url: `${url}/process-style-frame.html?scene=${entry.scene}&theme=${entry.theme}&lang=${entry.lang}`,
      });
      for (let attempt = 0; attempt < 200; attempt++) {
        if (
          await evaluate(
            "Boolean(window.__processStylePreview && document.querySelector('.turn-history'))",
          )
        )
          break;
        if (attempt === 199) throw new Error("Fixture did not mount");
        await delay(50);
      }
      await delay(300);
      // Pause only animation time for deterministic screenshots, not component state.
      await evaluate(
        "document.getAnimations().forEach(a => { a.pause(); a.currentTime = 700; })",
      );
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      const before = await evaluate(measure);
      assert.ok(before.header && before.history, `${name}: header and history`);
      assert.ok(
        before.header.y < before.history.y,
        `${name}: total above history`,
      );
      assert.equal(before.headerIndex, 1, `${name}: top metadata sibling`);
      assert.equal(before.totalInsideHistory, false);
      assert.equal(before.footer, false);
      assert.equal(before.overflow, false);
      assert.equal(before.headerIcons, 0, `${name}: no leading phase icon`);
      const labelPattern =
        entry.scene === "recovery"
          ? entry.lang === "en"
            ? /^Working$/u
            : /^正在工作$/u
          : entry.lang === "en"
            ? /^Working for \d/u
            : /^已工作 \d/u;
      assert.match(
        before.workLabel,
        labelPattern,
        `${name}: T3 work-duration wording without a phase prefix`,
      );
      assert.doesNotMatch(
        before.workLabel,
        /总耗时|Total elapsed|等待中|Waiting/u,
      );
      if (entry.scene === "thinking") {
        assert.equal(before.gap, 6);
        assert.equal(before.activeSweep, "true");
        // Measure the real cascade, not merely different animation pixels.
        const expectedBase =
          entry.theme === "dark" ? "rgb(137, 140, 150)" : "rgb(97, 104, 120)";
        const expectedCrest =
          entry.theme === "dark" ? "rgb(240, 241, 243)" : "rgb(28, 32, 41)";
        assert.equal(before.baseColor, expectedBase, `${name}: muted base`);
        assert.equal(before.iconColor, expectedBase, `${name}: muted icon`);
        assert.equal(
          before.labelColor,
          expectedBase,
          `${name}: muted full label`,
        );
        assert.equal(
          before.sweepColor,
          expectedCrest,
          `${name}: foreground crest`,
        );

        assert.ok(
          before.sweepMask && before.sweepMask !== "none",
          `${name}: computed sweep mask is valid`,
        );
      }
      await screenshot(`${name}.png`);
      if (entry.scene === "thinking") {
        const clip = {
          x: before.row.x,
          y: before.row.y,
          width: before.row.width,
          height: before.row.height,
          scale: 1,
        };
        const earlyFrame = await send("Page.captureScreenshot", {
          format: "png",
          clip,
        });
        await evaluate(
          "document.getAnimations().forEach(a => { a.currentTime = 1100; })",
        );
        await evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
        const laterFrame = await send("Page.captureScreenshot", {
          format: "png",
          clip,
        });
        assert.notEqual(
          earlyFrame.data,
          laterFrame.data,
          `${name}: actual icon/text pixels change across the sweep`,
        );
        await screenshot(`${name}-sweep-later.png`);
        await send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-reduced-motion", value: "reduce" }],
        });
        const reduced = await evaluate(measure);
        assert.equal(reduced.sweepDisplay, "none");
        await screenshot(`${name}-reduced-motion.png`);
        await send("Emulation.setEmulatedMedia", { features: [] });
      }
      await evaluate("window.__processStylePreview.finish()");
      await delay(200);
      const after = await evaluate(measure);
      assert.equal(
        after.headerIndex,
        before.headerIndex,
        `${name}: unchanged top position on completion`,
      );
      assert.equal(
        after.header.y,
        before.header.y,
        `${name}: header does not jump`,
      );
      assert.equal(after.totalInsideHistory, false);
      assert.equal(
        after.workLabelX,
        before.workLabelX,
        `${name}: unchanged text anchor`,
      );
      assert.match(
        after.workLabel,
        entry.lang === "en" ? /^Worked for \d/u : /^已工作 \d/u,
      );
      await screenshot(`${name}-completed.png`);
      evidence.scenes.push({ ...entry, before, after });
    }
  },
);
await writeFile(
  path.join(directory, "measurements.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(
  "Captured fourteen full synthetic scenes, bilingual work headers, same-turn completion and reduced-motion evidence.",
);
