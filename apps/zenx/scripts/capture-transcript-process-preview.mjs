/** Real-browser, synthetic production-component acceptance; no Host/model calls. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";

const directory = path.resolve(process.argv[2] ?? ".process-style-preview");
const evidence = {
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  sourceDiff: execFileSync("git", ["diff", "HEAD", "--", "apps/zenx"], {
    encoding: "utf8",
  }).trim(),
  bundleSha256: createHash("sha256")
    .update(await readFile(path.join(directory, "process-style-frame.html")))
    .digest("hex"),
  scope:
    "Synthetic authored data; production ThreadView, reading-state provider, ActivityText and CSS. No Host, real history, or model calls.",
  cases: [],
};
const measure = `(() => {
  const history = document.querySelector('.turn-history');
  const rows = [...(history?.querySelectorAll(':scope > .trace-singleton, :scope > .trace-group') ?? [])];
  return {
    collapsed: document.querySelector('.turn-toggle')?.getAttribute('aria-expanded') === 'false',
    history: !!history,
    final: !!document.querySelector('.turn-final'),
    inputs: document.querySelectorAll('.user-row').length,
    intermediate: /Intermediate B:|Partial D:/.test(document.querySelector('.messages')?.textContent ?? ''),
    outcome: document.querySelector('.turn-outcome')?.textContent,
    overflow: document.documentElement.scrollWidth > innerWidth,
    rows: rows.map(row => ({ unsettled: row.dataset.unsettled, text: row.textContent, active: row.querySelector('.activity-text')?.dataset.active, expanded: row.querySelector('button')?.getAttribute('aria-expanded') })),
    sweeps: [...document.querySelectorAll('.turn-history .activity-sweep')].map(sweep => ({ display: getComputedStyle(sweep).display, animation: getComputedStyle(sweep).animationName, title: sweep.closest('.trace-activity-title, .trace-item-label')?.title }))
  };
})()`;
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, screenshot, url }) => {
    for (const theme of ["light", "dark"]) {
      for (const width of [1280, 420]) {
        for (const scene of [
          "latest-group",
          "latest-requested",
          "latest-settled",
          "interrupted-comments",
        ]) {
          const name = `transcript-${scene}-${theme}-${width}`;
          await send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await send("Page.navigate", {
            url: `${url}/process-style-frame.html?scene=${scene}&theme=${theme}&lang=en`,
          });
          for (let attempt = 0; ; attempt++) {
            if (
              await evaluate(
                `Boolean(window.__processStylePreview?.snapshot().scene === ${JSON.stringify(scene)} && document.querySelector('.turn'))`,
              )
            )
              break;
            if (attempt >= 199)
              throw new Error(`${name}: fixture did not mount`);
            await delay(50);
          }
          await delay(200);
          const before = await evaluate(measure);
          assert.equal(before.overflow, false, name);
          if (scene === "interrupted-comments") {
            assert.equal(before.collapsed, true);
            assert.equal(before.history, false);
            assert.equal(before.final, false);
            assert.equal(before.intermediate, false);
            assert.equal(before.inputs, 1);
            assert.ok(before.outcome);
            await screenshot(`${name}-collapsed.png`);
            await evaluate(
              "document.querySelector('.turn-toggle').focus(); document.querySelector('.turn-toggle').click()",
            );
            await delay(200);
            const expanded = await evaluate(measure);
            assert.equal(expanded.intermediate, true);
            assert.equal(expanded.final, false);
            assert.equal(expanded.sweeps.length, 0);
            await screenshot(`${name}-expanded.png`);
            await evaluate("document.querySelector('.turn-toggle').click()");
            const collapsed = await evaluate(measure);
            assert.equal(collapsed.intermediate, false);
            assert.equal(collapsed.history, false);
            assert.equal(collapsed.final, false);
            assert.equal(
              await evaluate(
                "document.activeElement === document.querySelector('.turn-toggle')",
              ),
              true,
            );
            evidence.cases.push({
              scene,
              theme,
              width,
              before,
              expanded,
              collapsed,
            });
          } else {
            assert.deepEqual(
              before.rows.map((row) => row.active),
              ["false", "true"],
            );
            assert.equal(
              before.rows[0].unsettled,
              "true",
              "Earlier task fact remains intact",
            );
            assert.equal(before.sweeps.length, 1);
            assert.match(before.sweeps[0].title, /Agent is still working/u);
            await screenshot(`${name}.png`);
            await evaluate(
              "document.querySelector('.turn-history > section:last-of-type > button').focus(); document.querySelector('.turn-history > section:last-of-type > button').click()",
            );
            await delay(250);
            const expanded = await evaluate(measure);
            assert.equal(
              expanded.sweeps.length,
              1,
              "Expanded rows never duplicate the sweep",
            );
            assert.equal(expanded.overflow, false);
            await screenshot(`${name}-expanded.png`);
            await send("Emulation.setEmulatedMedia", {
              features: [{ name: "prefers-reduced-motion", value: "reduce" }],
            });
            await delay(50);
            const reduced = await evaluate(measure);
            assert.ok(
              reduced.sweeps.every((sweep) => sweep.display === "none"),
            );
            await screenshot(`${name}-reduced.png`);
            await send("Emulation.setEmulatedMedia", { features: [] });
            // Move focus out of history before interruption; preserve-selection behavior is separately covered.
            await evaluate(
              "document.activeElement.blur(); window.__processStylePreview.interrupt()",
            );
            await delay(100);
            const interrupted = await evaluate(measure);
            assert.equal(interrupted.history, false);
            assert.equal(interrupted.final, false);
            assert.equal(interrupted.sweeps.length, 0);
            await screenshot(`${name}-interrupted.png`);
            evidence.cases.push({
              scene,
              theme,
              width,
              before,
              expanded,
              reduced,
              interrupted,
            });
          }
          await writeFile(
            path.join(directory, "transcript-measurements.json"),
            JSON.stringify(evidence, null, 2) + "\n",
          );
        }
      }
    }
  },
);
console.log(
  `Verified ${evidence.cases.length} real-browser transcript cases with screenshots, reduced motion, latest-only activity and explicit interruption collapse.`,
);
