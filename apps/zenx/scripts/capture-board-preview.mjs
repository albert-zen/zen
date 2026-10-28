import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, withPreviewBrowser } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".board-preview");
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot, errors }) => {
    const waitFor = async (expression) => {
      for (let i = 0; i < 240; i++) {
        assert.deepEqual(errors, []);
        if (await evaluate(expression)) return;
        await delay(50);
      }
      throw new Error(`Timed out: ${expression}`);
    };
    const click = async (selector) => {
      const r = await evaluate(
        `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        clickCount: 1,
        ...r,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        clickCount: 1,
        ...r,
      });
    };
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url: `${url}/board.html` });
    await waitFor("!!window.__boardFixture");
    await click('[aria-label="Information board"]');
    await waitFor("!!document.querySelector('.board-surface')");
    await screenshot("01-popup-light.png");
    assert.equal(
      await evaluate("document.getElementById('composer-draft').value"),
      "My unsent chat draft stays here.",
    );
    await click('[aria-label="Pin information"]');
    await waitFor("!!document.querySelector('.information-rail')");
    await screenshot("02-pinned-light.png");
    // Custom iframe executes real JS but the fixture's script port is deliberately synthetic.
    await evaluate(
      "document.querySelector('.board-custom').scrollIntoView({block:'center'})",
    );
    await delay(200);
    const tree = await send("Page.getFrameTree");
    const frameId = tree.frameTree.childFrames[0].frame.id;
    const world = await send("Page.createIsolatedWorld", {
      frameId,
      worldName: "board-observer",
    });
    const frameEval = async (expression) =>
      (
        await send("Runtime.evaluate", {
          expression,
          contextId: world.executionContextId,
          returnByValue: true,
          awaitPromise: true,
        })
      ).result.value;
    assert.equal(await frameEval("document.body.dataset.onload"), "blocked");
    assert.equal(await evaluate("window.__boardFixture.calls.length"), 0);
    const frameClick = async (id) => {
      const offset = await evaluate(
        "(()=>{const r=document.querySelector('.board-custom').getBoundingClientRect();return {x:r.x,y:r.y}})()",
      );
      const r = await frameEval(
        `(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        clickCount: 1,
        x: offset.x + r.x,
        y: offset.y + r.y,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        clickCount: 1,
        x: offset.x + r.x,
        y: offset.y + r.y,
      });
    };
    await frameClick("local");
    assert.equal(await evaluate("window.__boardFixture.calls.length"), 0);
    await frameClick("chain");
    await waitFor(
      "window.__boardFixture.calls.some(call=>call.event==='sendCustom')",
    );
    const calls = await evaluate("window.__boardFixture.calls");
    assert.deepEqual(
      calls.map((c) => c.event),
      ["check", "sendCustom"],
    );
    assert.equal(
      calls[1].values.answer,
      "Custom count 1; script checked successfully.",
    );
    await screenshot("03-custom-async-chain.png");
    await evaluate("window.__boardFixture.update()");
    await waitFor(
      "document.querySelector('.board-heading h2')?.textContent==='Release plan · updated'",
    );
    assert.equal(
      await evaluate("document.querySelector('.board-field textarea').value"),
      "Keep this draft while I explore.",
    );
    await evaluate(
      "document.querySelector('.information-content').scrollTop=0",
    );
    await evaluate("document.querySelector('.window-titlebar button').click()");
    await screenshot("04-pinned-dark.png");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 760,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await screenshot("05-narrow-dark.png");
    await click('[aria-label="Unpin information"]');
    await waitFor("!!document.querySelector('.information-popover')");
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await waitFor(
      "document.activeElement?.getAttribute('aria-label')==='Information board'",
    );
    assert.equal(
      await evaluate("document.getElementById('composer-draft').value"),
      "My unsent chat draft stays here.",
    );
    await writeFile(
      path.join(directory, "evidence.json"),
      JSON.stringify(
        {
          scope:
            "Actual production components; synthetic effect ports and chat scaffold. No private data or real shell/API/model call.",
          passed: [
            "popup/pin/unpin",
            "light/dark/narrow",
            "onload privileged event denied",
            "custom local-only interaction makes zero calls",
            "user activation once across 6.2-second async script and custom assembled submit",
            "agent revision preserves draft",
            "chat draft never touched",
            "Escape returns focus",
          ],
          calls,
        },
        null,
        2,
      ),
    );
  },
);
