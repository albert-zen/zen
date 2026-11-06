import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
import path from "node:path";
const out = path.resolve(process.argv[2] ?? ".thinking-presence-preview");
const evidence = { syntheticData: true, modelCalls: 0, cases: [] };
await withPreviewBrowser(out, async ({ send, evaluate, url, screenshot }) => {
  for (const [theme, width, height] of [
    ["light", 1280, 900],
    ["dark", 1280, 900],
    ["light", 420, 900],
  ]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", {
      url: `${url}/thinking-presence.html?theme=${theme}`,
    });
    await delay(900);
    await evaluate(`document.querySelector('.trace-toggle').click()`);
    await delay(250);
    const check = async () =>
      evaluate(
        `({rows:[...document.querySelector('.trace-items').children].map(x=>x.textContent),opaque:document.getElementById('root').innerHTML.includes('synthetic-opaque-payload-must-never-display'),overflow:document.documentElement.scrollWidth>innerWidth})`,
      );
    let state = await check();
    assert.equal(state.rows.length, 7);
    assert.equal(state.rows[0], "思考");
    assert.equal(state.rows[1], "思考");
    assert.equal(state.rows[5], "思考");
    assert.equal(state.rows[3], "核对调用记录与保存的会话内容");
    assert.equal(state.opaque, false);
    assert.equal(state.overflow, false);
    await screenshot(`thinking-${theme}-${width}-running.png`);
    await evaluate(
      `document.querySelector('.trace-items').lastElementChild.querySelector('button').click()`,
    );
    await delay(250);
    assert.match(
      await evaluate(`document.querySelector('.trace-detail').textContent`),
      /提供方明确公开/,
    );
    await screenshot(`thinking-${theme}-${width}-public-content.png`);
    await evaluate(`window.thinkingProbe.finish()`);
    await delay(250);
    await evaluate(`document.querySelector('.turn-toggle').click()`);
    await delay(250);
    state = await check();
    assert.equal(state.rows.length, 7);
    assert.equal(state.opaque, false);
    await screenshot(`thinking-${theme}-${width}-completed.png`);
    evidence.cases.push({
      theme,
      width,
      height,
      runningRows: 7,
      completedRows: 7,
      opaqueExposed: false,
      horizontalOverflow: false,
    });
  }
});
await writeFile(out + "/evidence.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
