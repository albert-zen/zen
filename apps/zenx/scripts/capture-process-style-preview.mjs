import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".process-style-preview");
const matrix = [
  { scene: "thinking", theme: "light", width: 1280, height: 900 },
  { scene: "waiting", theme: "dark", width: 1280, height: 900 },
  { scene: "thinking", theme: "dark", width: 420, height: 900 },
  { scene: "waiting", theme: "light", width: 420, height: 900 },
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
  return { text: header?.textContent, header: rect(header), history: rect(history), row: rect(row), icon: rect(icon), label: rect(label), gap: icon && label ? label.getBoundingClientRect().left - icon.getBoundingClientRect().right : null, headerIndex: turn && header ? [...turn.children].indexOf(header) : -1, totalInsideHistory: !!history?.querySelector('.turn-duration'), footer: !!document.querySelector('.turn-status-footer'), overflow: document.documentElement.scrollWidth > innerWidth, activeSweep: row?.querySelector('.activity-text')?.dataset.animating, sweepDisplay: row?.querySelector('.activity-sweep') ? getComputedStyle(row.querySelector('.activity-sweep')).display : null };
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
      const name = `${entry.scene}-${entry.theme}-${entry.width}`;
      await send("Emulation.setDeviceMetricsOverride", {
        width: entry.width,
        height: entry.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Page.navigate", {
        url: `${url}/process-style-frame.html?scene=${entry.scene}&theme=${entry.theme}`,
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
      if (entry.scene === "thinking") {
        assert.equal(before.gap, 6);
        assert.equal(before.activeSweep, "true");
      }
      await screenshot(`${name}.png`);
      if (entry.scene === "thinking") {
        await evaluate(
          "document.getAnimations().forEach(a => { a.currentTime = 1100; })",
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
  "Captured four full synthetic scenes, same-turn completion and reduced-motion evidence.",
);
