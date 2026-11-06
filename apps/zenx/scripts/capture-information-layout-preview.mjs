import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, withPreviewBrowser } from "./preview-browser.mjs";
const directory = path.resolve(
  process.argv[2] ?? ".information-layout-preview",
);
const cases = [];
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot, errors }) => {
    const wait = async (expression) => {
      for (let i = 0; i < 200; i++) {
        assert.deepEqual(errors, []);
        if (await evaluate(expression)) return;
        await delay(25);
      }
      throw Error(`Timed out: ${expression}`);
    };
    const click = async (selector) => {
      await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`,
      );
      const point = await evaluate(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(e.disabled)throw Error('Disabled target');return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        clickCount: 1,
        ...point,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        clickCount: 1,
        ...point,
      });
      await wait(
        "!document.querySelector('.editable-information-panel[data-busy=\"true\"]')",
      );
    };
    const navigate = async (suffix = "") => {
      await send("Page.navigate", { url: `${url}/information.html${suffix}` });
      await wait("!!window.__informationFixture");
      await click('[aria-label="Information board"]');
      await wait("!!document.querySelector('.information-widget')");
    };
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1040,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await navigate();
    await screenshot("01-default-light.png");
    assert.equal(
      await evaluate("document.querySelectorAll('.information-widget').length"),
      5,
    );
    assert.equal(await evaluate("window.__informationFixture.updates()"), 0);
    await click('[aria-label="Customize information"]');
    await screenshot("02-customize-light.png");
    await click('[aria-label="Move up · Board"]');
    cases.push(
      "Pointer-operated customize and reorder persist one local CAS edit",
    );
    await evaluate("window.__informationFixture.conflict()");
    await click(
      '[data-widget-id="default:triggers"] .information-widget-actions button:nth-child(3)',
    );
    await wait("!!document.querySelector('.information-conflict')");
    await screenshot("03-retained-conflict.png");
    assert.equal(await evaluate("window.__informationFixture.updates()"), 2);
    await click(".information-conflict button:nth-child(2)");
    await wait("!document.querySelector('.information-conflict')");
    cases.push(
      "Conflict retains edit and only explicit Reapply emits a new write",
    );
    for (let i = 0; i < 4; i++)
      await click(
        '.information-widget[data-visible="true"] .information-widget-actions button:nth-child(3)',
      );
    await wait(
      "document.querySelectorAll('.information-widget[data-visible=\"true\"]').length===0",
    );
    assert.equal(
      await evaluate("!!document.querySelector('.information-attention')"),
      true,
    );
    await screenshot("04-all-hidden-asking-remains.png");
    cases.push(
      "All widgets hidden never hides the separate Asking attention slot",
    );
    await click(".information-add-controls > button:last-of-type");
    await click(
      '[data-widget-id="synthetic-second-board"] .information-widget-actions button:nth-child(3)',
    );
    await click('[aria-label="Done"]');
    await evaluate(
      "document.querySelector('[data-widget-id=\"synthetic-second-board\"]').scrollIntoView({block:'end'})",
    );
    await delay(100);
    await screenshot("05-independent-board-bodies.png");
    const fields = await evaluate(
      "[...document.querySelectorAll('.board-field input')].map(e=>e.value)",
    );
    assert.deepEqual(fields, ["Interface review", "Independent draft"]);
    await click('[data-widget-id="synthetic-second-board"] .board-field input');
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: 2,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: 2,
    });
    await send("Input.insertText", { text: "Only the second Board changes" });
    await delay(500);
    assert.deepEqual(
      await evaluate(
        "window.__informationFixture.bodies().map(([key,value])=>[key,value.values.topic])",
      ),
      [
        ["default", "Interface review"],
        ["board:secondary", "Only the second Board changes"],
      ],
    );
    assert.equal(
      await evaluate("document.getElementById('composer-draft').value"),
      "My unsent conversation draft stays here.",
    );
    cases.push(
      "Same authored ID/revision Boards retain independent fields and leave Composer unchanged",
    );
    await navigate("?theme=dark");
    await click('[aria-label="Customize information"]');
    await screenshot("06-customize-dark.png");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 760,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await navigate("?theme=light");
    await wait("!!document.querySelector('.information-popover')");
    await screenshot("07-narrow-popover.png");
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await wait("!document.querySelector('.information-popover')");
    assert.equal(
      await evaluate("document.activeElement?.getAttribute('aria-label')"),
      "Information board",
    );
    cases.push("Narrow popover Escape dismisses and restores trigger focus");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1040,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await navigate("?owner=empty-room&theme=light");
    await click('[aria-label="Customize information"]');
    assert.equal(
      await evaluate(
        "document.querySelector('[aria-label=\"Source member\"]').value",
      ),
      "",
    );
    assert.equal(
      await evaluate(
        "window.__informationFixture.read().layout.widgets.length",
      ),
      2,
    );
    await screenshot("08-empty-room.png");
    cases.push(
      "Empty Room has only owner/Room components and no invented source member",
    );
  },
);
await writeFile(
  path.join(directory, "acceptance.json"),
  JSON.stringify(
    {
      ok: true,
      synthetic: true,
      surface:
        "Chromium production component fixture; not native Electron/real Host",
      cases,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Captured ${cases.length} editable information cases at ${directory}`,
);
