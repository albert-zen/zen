import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { delay, withPreviewBrowser } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".quote-preview");
const evidence = {
  source:
    "Production ThreadView and quote controls; synthetic messages and history; cloud Chromium desktop-input emulation, not native user-device acceptance; no Provider calls.",
  scenes: [],
  checkpoints: [],
};
try {
  await withPreviewBrowser(
    directory,
    async ({ send, evaluate, url, screenshot }) => {
      const waitFor = async (expression) => {
        for (let i = 0; i < 200; i++) {
          if (await evaluate(expression)) return;
          await delay(50);
        }
        throw new Error(`Condition timed out: ${expression}`);
      };
      const settle = () =>
        evaluate(
          "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
        );
      const snapshot = () =>
        evaluate(`(() => {
    const answer=document.querySelector('.turn-final'); const r=answer.getBoundingClientRect();
    return { expanded:document.querySelector('.turn-toggle').getAttribute('aria-expanded'),
      history:!!document.querySelector('.turn-history'), selected:getSelection().toString(),
      top:r.top,height:r.height,scroll:document.querySelector('.messages').scrollTop,
      overflow:document.documentElement.scrollWidth>innerWidth };
  })()`);
      const click = async (selector, clickCount = 1) => {
        const point = await evaluate(
          `(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
        );
        await send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          clickCount,
          ...point,
        });
        await send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: "left",
          clickCount,
          ...point,
        });
        await settle();
      };
      const key = async (key, code, windowsVirtualKeyCode) => {
        // Match production browser-targeted-input: native activation needs keypress text.
        const text = key === "Enter" ? "\r" : key === " " ? " " : undefined;
        evidence.checkpoint = `keyboard ${code}`;
        const focused = await evaluate(
          "document.activeElement === document.querySelector('.turn-toggle')",
        );
        evidence.checkpoints.push({
          stage: evidence.checkpoint,
          focused,
          before: await snapshot(),
        });
        assert.equal(
          focused,
          true,
          `${code}: the actual disclosure button must own focus`,
        );
        await send("Input.dispatchKeyEvent", {
          type: text === undefined ? "rawKeyDown" : "keyDown",
          key,
          code,
          windowsVirtualKeyCode,
          ...(text === undefined ? {} : { text, unmodifiedText: text }),
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key,
          code,
          windowsVirtualKeyCode,
        });
        await settle();
        evidence.checkpoints.push({
          stage: `${code} complete`,
          after: await snapshot(),
        });
      };
      for (const width of [1280, 420]) {
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await send("Page.navigate", {
          url: `${url}/quote-frame.html?empty&selection&lang=zh-CN`,
        });
        await waitFor(
          "!!window.quoteFixture && !!document.querySelector('.turn-final article p')",
        );
        await settle();
        const before = await snapshot();
        assert.equal(before.expanded, "false");
        assert.equal(before.history, false);
        assert.equal(before.overflow, false);
        await screenshot(`turn-selection-${width}-before.png`);
        evidence.checkpoint = `${width}: mouse drag`;
        // Real mouse drag: selectionchange comes from Chromium, not a synthetic event.
        const points =
          await evaluate(`(() => { const node=document.querySelector('.turn-final article p').firstChild;
      const rect=i=>{const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+1);return range.getBoundingClientRect();};
      const a=rect(0),b=rect(10);return {start:{x:a.left+1,y:a.top+a.height/2},end:{x:b.right-1,y:b.top+b.height/2}};})()`);
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...points.start,
        });
        await send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          clickCount: 1,
          ...points.start,
        });
        for (let i = 1; i <= 8; i++)
          await send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            button: "left",
            buttons: 1,
            x: points.start.x + ((points.end.x - points.start.x) * i) / 8,
            y: points.start.y + ((points.end.y - points.start.y) * i) / 8,
          });
        await send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: "left",
          clickCount: 1,
          ...points.end,
        });
        await waitFor("!!document.querySelector('.message-selection-actions')");
        await settle();
        const selected = await snapshot();
        assert.ok(selected.selected.length > 0);
        assert.equal(selected.expanded, "false");
        assert.equal(selected.history, false);
        assert.equal(selected.top, before.top);
        assert.equal(selected.height, before.height);
        assert.equal(selected.scroll, before.scroll);
        await screenshot(`turn-selection-${width}-selected.png`);
        evidence.checkpoint = `${width}: quote selected answer`;
        await click(".message-selection-actions button:last-child");
        await waitFor("window.quoteFixture.getDraft().references.length===1");
        assert.equal(
          await evaluate(
            "window.quoteFixture.getDraft().references[0].excerpt",
          ),
          selected.selected,
        );
        assert.equal(await evaluate("window.quoteFixture.getSent().length"), 0);
        const quoted = await snapshot();
        assert.equal(quoted.expanded, "false");
        assert.equal(quoted.history, false);
        await screenshot(`turn-selection-${width}-quoted.png`);
        // An ordinary answer click and a double-click word selection never reveal history.
        await click(".turn-final article p");
        assert.equal((await snapshot()).expanded, "false", evidence.checkpoint);
        evidence.checkpoint = `${width}: double-click answer text`;
        const wordPoint = await evaluate(`(() => {
        const node=document.querySelector('.turn-final article p').firstChild;
        const range=document.createRange();range.setStart(node,1);range.setEnd(node,2);
        const r=range.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
      })()`);
        const beforeDoubleClick = await snapshot();
        await send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          clickCount: 2,
          ...wordPoint,
        });
        await send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: "left",
          clickCount: 2,
          ...wordPoint,
        });
        await settle();
        const doubleClicked = await snapshot();
        assert.ok(
          doubleClicked.selected.length > 0,
          "double-click selects actual answer text",
        );
        assert.equal(doubleClicked.expanded, "false");
        assert.equal(doubleClicked.top, beforeDoubleClick.top);
        // Native button keyboard activation remains available and updates aria-expanded.
        await evaluate(
          "getSelection().removeAllRanges();document.querySelector('.turn-toggle').focus()",
        );
        await key("Enter", "Enter", 13);
        assert.equal((await snapshot()).expanded, "true", evidence.checkpoint);
        await key(" ", "Space", 32);
        assert.equal((await snapshot()).expanded, "false", evidence.checkpoint);
        evidence.checkpoint = `${width}: explicit pointer disclosure`;
        await click(".turn-toggle");
        assert.equal((await snapshot()).expanded, "true", evidence.checkpoint);
        evidence.checkpoint = `${width}: explicit pointer disclosure`;
        await click(".turn-toggle");
        assert.equal((await snapshot()).expanded, "false", evidence.checkpoint);
        evidence.scenes.push({
          width,
          before,
          selected,
          quoted,
          keyboardDisclosure: true,
          pointerDisclosure: true,
        });
      }
    },
  );
} catch (error) {
  evidence.failure = String(error?.stack ?? error);
  throw error;
} finally {
  await writeFile(
    path.join(directory, "turn-selection-evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
}
console.log(
  "Completed answer mouse selection, quote and explicit disclosure checks passed.",
);
