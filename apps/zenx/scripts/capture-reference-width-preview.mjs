import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".reference-width-preview");
process.env.ZENX_PREVIEW_DESKTOP_INPUT = "1";
const evidence = {
  source:
    "Production responsive ReferenceToken wrapper, Markdown and CSS; synthetic identities, supplied visible excerpt. No Provider or user computer access.",
  scenes: [],
};
await withPreviewBrowser(
  directory,
  async ({ send, evaluate, url, screenshot, errors }) => {
    for (const width of [1280, 420, 320]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 1500,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Page.navigate", { url: url + "/index.html" });
      for (let i = 0; i < 100; i++) {
        if (await evaluate("!!window.layoutMetrics")) break;
        await delay(50);
      }
      await evaluate("document.fonts.ready");
      await evaluate("document.querySelector('#measure').click()");
      const metrics = await evaluate("window.layoutMetrics");
      assert.equal(metrics?.length, 5, "all real-component cases mounted");
      assert.equal(
        await evaluate(
          "document.querySelectorAll('section .reference-token').length",
        ),
        6,
        "canonical references parsed into production tokens",
      );
      for (const c of metrics) {
        const content = c.boxes.find(
          (b) => b.class === "inline-reference-content",
        );
        assert.ok(
          content.scrollWidth <= content.clientWidth + 1,
          `no horizontal overflow at ${width}: ${JSON.stringify(c)}`,
        );
        for (const token of c.boxes.filter(
          (b) => b.class === "reference-token",
        )) {
          assert.ok(token.width <= 300.1, "token retains desktop cap");
          assert.ok(
            token.x >= content.x - 1 && token.right <= content.right + 1,
            `token contained at ${width}: ${JSON.stringify(c)}`,
          );
        }
      }
      if (width === 1280) {
        for (const i of [0, 2, 4])
          assert.ok(
            metrics[i].boxes[0].width < 400,
            "long hidden excerpt does not inflate bubble",
          );
        assert.ok(
          metrics[1].boxes[0].width < 180,
          "short reference remains content-sized",
        );
      }
      const editable = await evaluate(
        `(() => {const e=document.querySelector('.inline-composer-editor'),t=e.querySelector('.reference-token'),b=e.querySelector('.reference-token-remove');const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width}};return {editor:rect(e),token:rect(t),remove:rect(b)};})()`,
      );
      const editorComparisons = await evaluate(
        `(() => {const host=document.querySelector('.editor-fixture');const style=document.createElement('style');document.head.append(style);const measure=()=>{const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,clientWidth:n.clientWidth,scrollWidth:n.scrollWidth}};return {editor:rect(host.querySelector('.inline-composer-editor')),content:rect(host.querySelector('.cm-content')),token:rect(host.querySelector('.reference-token')),remove:rect(host.querySelector('.reference-token-remove'))}};const fixed=measure();style.textContent='.editor-fixture .cm-content{min-width:auto}';const wrapperOnly=measure();style.textContent+='.editor-fixture .reference-token-wrap{display:contents}.editor-fixture .reference-token{max-width:min(300px,100%)}.editor-fixture .inline-composer-reference .reference-token{max-width:100%}';const baseline=measure();style.remove();return {baseline,wrapperOnly,fixed}})()`,
      );
      await writeFile(
        path.join(directory, `geometry-${width}.json`),
        JSON.stringify(
          { width, metrics, editable, editorComparisons },
          null,
          2,
        ),
      );
      await screenshot(`reference-width-${width}-fixed.png`);
      assert.ok(
        editable.token.left >= editable.editor.left - 1 &&
          editable.token.right <= editable.editor.right + 1,
        `editable long token is contained at ${width}: ${JSON.stringify(editable)}`,
      );
      assert.ok(
        editable.remove.width >= 24 &&
          editable.remove.right <= editable.token.right + 1,
        "remove remains visible and usable",
      );
      await screenshot(`reference-width-${width}-fixed.png`);
      await evaluate(
        "document.querySelector('.reference-token-details').click()",
      );
      await delay(200);
      assert.equal(
        await evaluate(
          "document.querySelector('.reference-exact-excerpt')?.textContent",
        ),
        await evaluate("window.referenceExcerpt"),
        "expanded reference preserves exact full excerpt",
      );
      await screenshot(`reference-width-${width}-expanded.png`);
      await evaluate(
        "document.querySelector('.reference-details-popover header button').click()",
      );
      await delay(200);
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.reference-details-popover').length",
        ),
        0,
        "close removes the detail popover",
      );
      await evaluate("document.querySelector('#measure').click()");
      assert.deepEqual(
        await evaluate("window.layoutMetrics"),
        metrics,
        "opening/closing detail never changes inline bubble geometry",
      );
      await evaluate(
        "document.querySelector('section .reference-token-details').focus()",
      );
      assert.ok(
        await evaluate(
          "document.activeElement===document.querySelector('section .reference-token-details')",
        ),
        "trigger focused before keyboard activation",
      );
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        text: "\r",
        unmodifiedText: "\r",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      await delay(200);
      assert.ok(
        await evaluate(
          "!!document.querySelector('.reference-details-popover')",
        ),
        "keyboard Enter opens details",
      );
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
      await delay(200);
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.reference-details-popover').length",
        ),
        0,
        "Escape dismisses details",
      );
      assert.ok(
        await evaluate(
          "document.activeElement===document.querySelector('section .reference-token-details')",
        ),
        "dismissal restores trigger focus",
      );
      await evaluate(
        "document.querySelector('.editor-fixture .reference-token-remove').click()",
      );
      await delay(200);
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.editor-fixture .reference-token').length",
        ),
        0,
        "editable remove works",
      );
      assert.equal(
        await evaluate(
          "document.querySelectorAll('section .reference-token').length",
        ),
        6,
        "removing draft reference does not mutate sent references",
      );
      const scene = { width, metrics, editable, editorComparisons };
      evidence.scenes.push(scene);
      console.log("REFERENCE_WIDTH_MEASUREMENTS " + JSON.stringify(scene));
    }
    assert.deepEqual(errors, [], "no browser exceptions");
  },
);
await writeFile(
  path.join(directory, "measurements.json"),
  JSON.stringify(evidence, null, 2),
);
