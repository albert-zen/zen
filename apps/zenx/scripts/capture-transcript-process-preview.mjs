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
    processRollup: !!document.querySelector('.trace-counts, .turn-outcome-review, .turn-outcome-primary-action'),
    spinners: history?.querySelectorAll('.mini-spinner').length ?? 0,
    overflow: document.documentElement.scrollWidth > innerWidth,
    statuses: [...document.querySelectorAll('.trace-item-status')].filter(cell => !cell.closest('[aria-hidden="true"], [inert]')).map(cell => {
      const row = cell.closest('.trace-item-toggle, .trace-item-static');
      const badge = cell.querySelector('.tool-status');
      const textRange = document.createRange();
      if (badge) textRange.selectNodeContents(badge);
      const text = badge ? textRange.getBoundingClientRect() : null;
      const rect = cell.getBoundingClientRect();
      const chevron = row.querySelector('.trace-item-chevron').getBoundingClientRect();
      return { text: badge?.textContent ?? '', spinner: !!cell.querySelector('.mini-spinner'), width: rect.width, left: rect.left, right: rect.right, textWidth: text?.width ?? 0, textLeft: text?.left ?? rect.left, textRight: text?.right ?? rect.left, chevronWidth: chevron.width, chevronLeft: chevron.left, rowRight: row.getBoundingClientRect().right };
    }),
    rows: rows.map(row => ({ unsettled: row.dataset.unsettled, text: row.textContent, active: row.querySelector('.activity-text')?.dataset.active, expanded: row.querySelector('button')?.getAttribute('aria-expanded') })),
    sweeps: [...document.querySelectorAll('.turn-history .activity-sweep')].map(sweep => ({ display: getComputedStyle(sweep).display, animation: getComputedStyle(sweep).animationName, title: sweep.closest('.trace-activity-title, .trace-item-label')?.title }))
  };
})()`;
function assertStatusGeometry(measurement, name) {
  for (const status of measurement.statuses) {
    assert.ok(
      status.width >= 14,
      `${name}: spinner/status slot retains its minimum width`,
    );
    assert.ok(
      status.chevronWidth >= 14,
      `${name}: chevron retains its own column`,
    );
    assert.ok(
      status.right <= status.chevronLeft + 0.5,
      `${name}: status never overlaps chevron`,
    );
    assert.ok(
      status.right <= status.rowRight + 0.5,
      `${name}: status stays in row bounds`,
    );
    if (status.text) {
      assert.ok(
        status.textWidth > 0,
        `${name}: actual status glyphs are measured`,
      );
      assert.ok(
        status.width + 0.5 >= status.textWidth,
        `${name}: full ${JSON.stringify(status.text)} width fits`,
      );
      assert.ok(
        status.textLeft >= status.left - 0.5 &&
          status.textRight <= status.right + 0.5,
        `${name}: no status glyph is clipped`,
      );
    }
  }
}
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, screenshot, url }) => {
    for (const theme of ["light", "dark"]) {
      for (const { width, lang } of [1280, 420].flatMap((width) =>
        ["en", "zh-CN"].map((lang) => ({ width, lang })),
      )) {
        for (const scene of [
          "latest-group",
          "latest-requested",
          "latest-settled",
          "interrupted-comments",
        ]) {
          const name = `transcript-${scene}-${theme}-${width}-${lang}`;
          await send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await send("Page.navigate", {
            url: `${url}/process-style-frame.html?scene=${scene}&theme=${theme}&lang=${lang}`,
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
          assertStatusGeometry(before, name);
          assert.equal(before.processRollup, false, name);
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
            assertStatusGeometry(expanded, `${name} expanded`);
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
              lang,
              before,
              expanded,
              collapsed,
            });
          } else {
            assert.deepEqual(
              before.rows.map((row) => row.active),
              ["false", scene === "latest-settled" ? "false" : "true"],
            );
            assert.equal(
              before.rows[0].unsettled,
              "false",
              "Earlier invocation stays completed even while its process runs",
            );
            const active = scene === "latest-settled" ? 0 : 1;
            assert.equal(before.sweeps.length, active);
            if (active)
              assert.ok(
                before.sweeps[0].title.includes(
                  lang === "en" ? "Agent is still working" : "Agent 仍在工作",
                ),
              );
            await screenshot(`${name}.png`);
            await evaluate(
              "document.querySelector('.turn-history > section:last-of-type > button').focus(); document.querySelector('.turn-history > section:last-of-type > button').click()",
            );
            await delay(250);
            const expanded = await evaluate(measure);
            assertStatusGeometry(expanded, `${name} expanded`);
            assert.equal(
              expanded.sweeps.length,
              active,
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
            await evaluate("window.__processStylePreview.returnLatest()");
            await delay(100);
            const returned = await evaluate(measure);
            assertStatusGeometry(returned, `${name} returned`);
            assert.ok(
              returned.statuses.some(
                (status) =>
                  status.text === (lang === "en" ? "Completed" : "已完成"),
              ),
              `${name}: returned completion is actually rendered`,
            );
            assert.equal(returned.sweeps.length, 0);
            assert.equal(returned.spinners, 0);
            assert.equal(returned.rows.at(-1).unsettled, "false");
            await screenshot(`${name}-returned.png`);
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
            await evaluate("window.__processStylePreview.returnLatest(true)");
            await delay(100);
            assert.equal(
              (await evaluate(measure)).history,
              false,
              "Late receipt cannot open interrupted history",
            );
            await evaluate("document.querySelector('.turn-toggle').click()");
            await delay(100);
            const late = await evaluate(measure);
            assertStatusGeometry(late, `${name} late receipt`);
            assert.equal(late.sweeps.length, 0);
            assert.equal(late.spinners, 0);
            assert.equal(late.processRollup, false);
            await screenshot(`${name}-late-error.png`);
            evidence.cases.push({
              scene,
              theme,
              width,
              lang,
              before,
              expanded,
              reduced,
              returned,
              interrupted,
              late,
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
  `Verified ${evidence.cases.length} real-browser transcript cases with screenshots, reduced motion, receipt-only activity, yielded returns, late errors and explicit interruption collapse.`,
);
