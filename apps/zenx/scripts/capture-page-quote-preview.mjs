import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2]);
const scenes = [];
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot }) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const waitFor = async (expression) => {
      for (let i = 0; i < 150; i++) {
        if (await evaluate(`Boolean(${expression})`)) return;
        await delay(40);
      }
      console.log(
        await evaluate(
          "JSON.stringify({active:document.activeElement?.outerHTML.slice(0,180),selection:getSelection()?.toString(),draft:window.quoteFixture?.getDraft(),sent:window.quoteFixture?.getSent(),toolbar:document.querySelector('.message-selection-actions')?.outerHTML})",
        ),
      );
      throw new Error(`Timed out: ${expression}`);
    };
    const load = async () => {
      await send("Page.navigate", {
        url: `${url}/quote-frame.html?alltext&empty`,
      });
      await waitFor(
        "window.quoteFixture && document.querySelector('.user-bubble')",
      );
      await delay(150);
    };
    async function select(expression, name) {
      const point = await evaluate(
        `(async () => { const node = ${expression}; if (!node) throw Error('Selection node missing: ${name}'); node.scrollIntoView({block:'center'}); await new Promise(resolve => setTimeout(resolve, 200)); const rect = node.getBoundingClientRect(); return {x:rect.left+4,y:rect.top+4}; })()`,
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
      const excerpt = await evaluate(
        `(() => { const node = ${expression}; document.activeElement?.blur(); const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')); return selection.toString(); })()`,
      );
      await waitFor(
        "document.querySelector('.message-selection-actions')?.style.visibility === 'visible'",
      );
      await screenshot(`${name}-selection.png`);
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        modifiers: 1,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        modifiers: 1,
      });
      await waitFor("window.quoteFixture.getDraft().references.length > 0");
      const draft = await evaluate("window.quoteFixture.getDraft()");
      assert.equal(draft.references.at(-1).excerpt, excerpt, name);
      assert.equal(
        await evaluate("window.quoteFixture.getSent().length"),
        0,
        "quoting never sends",
      );
      await waitFor("document.activeElement.id === 'thread-composer'");
      scenes.push({ name, excerpt, reference: draft.references.at(-1) });
      await screenshot(`${name}-quoted.png`);
      return draft.references.at(-1);
    }
    await load();
    const user = await select("document.querySelector('.user-bubble')", "user");
    assert.equal(user.id, "synthetic-user");
    await load();
    await evaluate("document.querySelector('.turn-toggle').click()");
    await waitFor(
      "document.querySelector('.trace-toggle, .trace-item-toggle')",
    );
    await evaluate("document.querySelector('.trace-toggle')?.click()");
    await evaluate(
      "[...document.querySelectorAll('.trace-item-toggle')].forEach(button => { if (button.getAttribute('aria-expanded') !== 'true') button.click(); })",
    );
    await waitFor("document.querySelector('.trace-detail-markdown')");
    const reasoning = await select(
      "document.querySelector('.trace-detail-markdown')",
      "reasoning",
    );
    assert.equal(reasoning.id, "synthetic-reasoning");
    const tool = await select(
      "document.querySelector('.trace-output')",
      "tool-output",
    );
    assert.deepEqual(
      tool.sources.map((source) => source.id),
      ["synthetic-call", "synthetic-result"],
    );
    await load();
    const ui = await select(
      "document.querySelector('.window-titlebar-product span')",
      "interface",
    );
    assert.equal(ui.kind, "text");
    assert.deepEqual(ui.sources, []);
    await load();
    await evaluate(
      `(() => { const input = document.querySelector('#synthetic-page-field'); input.focus(); input.setSelectionRange(0, input.value.length); input.dispatchEvent(new Event('select', {bubbles:true})); })()`,
    );
    await waitFor("document.querySelector('.message-selection-actions')");
    await screenshot("field-selection.png");
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      modifiers: 1,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      modifiers: 1,
    });
    await waitFor("window.quoteFixture.getDraft().references.length === 1");
    const fieldQuote = await evaluate(
      "window.quoteFixture.getDraft().references[0]",
    );
    assert.equal(fieldQuote.excerpt, "页面字段中的可选原文");
    assert.deepEqual(fieldQuote.sources, []);
    scenes.push({ name: "form-field", reference: fieldQuote });
    await load();
    const excerpt = await evaluate(
      `(() => { const start = document.querySelector('.user-bubble'); const end = document.querySelector('.agent-copy p'); const range = document.createRange(); range.setStart(start.firstChild, 0); range.setEndAfter(end); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')); return selection.toString(); })()`,
    );
    await waitFor("document.querySelector('.message-selection-actions')");
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      modifiers: 1,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      modifiers: 1,
    });
    await waitFor("window.quoteFixture.getDraft().references.length === 1");
    const cross = await evaluate(
      "window.quoteFixture.getDraft().references[0]",
    );
    assert.equal(cross.excerpt, excerpt);
    assert.equal(cross.kind, "text");
    assert.ok(cross.sources.some((source) => source.id === "synthetic-user"));
    assert.ok(cross.sources.some((source) => source.id === "synthetic-answer"));
    scenes.push({ name: "cross-message", reference: cross });
    await screenshot("cross-message-quoted.png");
    // Verify the normal submit path keeps the exact snapshot and source list.
    await evaluate(
      "document.querySelector('.composer .action-orb.send').click()",
    );
    await waitFor("window.quoteFixture.getSent().length === 1");
    const sent = await evaluate("window.quoteFixture.getSent()[0]");
    assert.ok(JSON.stringify(sent).includes("synthetic-user"));
    scenes.push({ name: "explicit-send", sent });
    await send("Emulation.setDeviceMetricsOverride", {
      width: 520,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await load();
    await select("document.querySelector('.user-bubble')", "narrow-user");
  },
);
await writeFile(
  path.join(directory, "page-quote-verification.json"),
  JSON.stringify({ synthetic: true, scenes }, null, 2),
);
console.log(`Verified ${scenes.length} page-quote scenes.`);
