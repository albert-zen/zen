import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
import path from "node:path";
const out = path.resolve(process.argv[2] ?? ".empty-reasoning-preview");
const evidence = { syntheticData: true, modelCalls: 0, cases: [] };
await withPreviewBrowser(out, async ({ send, evaluate, url, screenshot }) => {
  for (const [theme, width] of [
    ["light", 1280],
    ["dark", 1280],
    ["light", 420],
  ]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const terminal of ["completed", "interrupted"]) {
      await send("Page.navigate", {
        url: `${url}/empty-reasoning.html?theme=${theme}`,
      });
      await delay(900);
      for (const phase of ["started", terminal, `restored-${terminal}`]) {
        if (phase !== "started") {
          await evaluate(
            `window.emptyReasoningProbe.setPhase(${JSON.stringify(phase)})`,
          );
          await delay(250);
        }
        await evaluate(
          `(()=>{const b=document.querySelector('.turn-toggle');if(b?.getAttribute('aria-expanded')==='false')b.click();})()`,
        );
        await delay(200);
        const state = await evaluate(
          `(()=>{const row=document.querySelector('.trace-singleton');return {probe:window.emptyReasoningProbe.state(),rows:document.querySelectorAll('.trace-singleton').length,text:row?.textContent,emptyDisclosure:row?.querySelectorAll('button,[aria-expanded],.trace-detail').length,spinners:row?.querySelectorAll('.mini-spinner').length,interrupted:row?.querySelectorAll('.tool-status.interrupted').length,overflow:document.documentElement.scrollWidth>innerWidth}})()`,
        );
        const items = state.probe.items.filter(
          (item) => item.type === "reasoning",
        );
        assert.equal(items.length, 1);
        assert.equal(items[0].id, "empty-observation");
        assert.equal(items[0].summary.join(""), "");
        assert.equal(items[0].content.join(""), "");
        assert.equal(state.rows, 1);
        assert.match(state.text, /思考/);
        assert.equal(state.emptyDisclosure, 0);
        assert.equal(state.spinners, phase === "started" ? 1 : 0);
        assert.equal(
          state.interrupted,
          phase !== "started" && terminal === "interrupted" ? 1 : 0,
        );
        assert.equal(state.overflow, false);
        if (phase.startsWith("restored")) {
          const canonical = state.probe.canonicalItems.find(
            (item) => item.id === "empty-observation",
          );
          assert.equal(canonical.contentVisibility, "public");
          assert.equal(canonical.reasoningContent, "");
          assert.equal(canonical.summary, undefined);
          assert.equal(canonical.providerItemId, undefined);
        }
        const filename = `empty-${theme}-${width}-${terminal}-${phase}.png`;
        await screenshot(filename);
        evidence.cases.push({
          theme,
          width,
          terminal,
          phase,
          filename,
          visibleRows: state.rows,
          emptyDisclosure: state.emptyDisclosure,
          spinners: state.spinners,
          interrupted: state.interrupted,
          horizontalOverflow: state.overflow,
        });
      }
    }
  }
});
await writeFile(out + "/evidence.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
