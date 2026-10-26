import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { rendererHtmlWithStyleNonce } from "../src/main/renderer-style-policy.ts";
import { withPreviewBrowser, delay } from "./preview-browser.mjs";
const directory = path.resolve(process.argv[2] ?? ".composer-overflow-preview");
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const name = url.pathname.slice(1) || "index.html";
    if (
      !["index.html", "composer.css", "composer.js", "observer.js"].includes(
        name,
      )
    ) {
      res.writeHead(404).end();
      return;
    }
    let content = await readFile(path.join(directory, name));
    if (name === "index.html" && !url.searchParams.has("baseline"))
      content = rendererHtmlWithStyleNonce(
        content.toString(),
        randomBytes(24).toString("base64"),
      );
    res.setHeader(
      "Content-Type",
      name.endsWith(".html")
        ? "text/html"
        : name.endsWith(".css")
          ? "text/css"
          : "text/javascript",
    );
    res.end(content);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}/index.html`;
process.env.ZENX_PREVIEW_DESKTOP_INPUT = "1";
const measure = `(()=>{const read=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect(),c=getComputedStyle(e);return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,scrollTop:e.scrollTop,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,display:c.display,position:c.position,overflowY:c.overflowY,inlineStyle:e.getAttribute('style')}};return {state:window.composerFixture.snapshot(),shell:read('.composer'),rail:read('.composer-rail'),plain:read('.composer > textarea'),editor:read('.cm-editor'),scroller:read('.cm-scroller'),content:read('.cm-content'),layers:[...document.querySelectorAll('.cm-layer')].map(e=>({class:e.className,height:e.getBoundingClientRect().height,position:getComputedStyle(e).position})),violations:window.composerCspViolations};})()`;
const report = [];
let browserVersion;
const exactExcerpt = "Exact synthetic excerpt\nwith whitespace preserved.";
const longText = Array.from(
  { length: 30 },
  (_, i) =>
    `Line ${i + 1}: 合成回归文本，检查长输入不会覆盖工具栏。 Synthetic text tests bounded scrolling.`,
).join("\n");
try {
  await withPreviewBrowser(
    directory,
    async ({ send, evaluate, screenshot }) => {
      browserVersion = await send("Browser.getVersion");
      await send("DOM.enable");
      await send("CSS.enable");
      async function until(expression, label) {
        for (let i = 0; i < 100; i++) {
          if (await evaluate(expression)) return;
          await delay(50);
        }
        throw Error(`Timed out: ${label}`);
      }
      async function key(key, code, modifiers = 0) {
        const virtual =
          { Backspace: 8, Home: 36, End: 35, ArrowDown: 40 }[key] ??
          (code.startsWith("Key") ? code.charCodeAt(3) : 0);
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key,
          code,
          windowsVirtualKeyCode: virtual,
          modifiers,
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key,
          code,
          windowsVirtualKeyCode: virtual,
          modifiers,
        });
        await delay(120);
      }
      async function click(selector, trailingEdge = false) {
        const point = await evaluate(
          `(() => { const e=document.querySelector(${JSON.stringify(selector)}); const r=e.getBoundingClientRect(); return {x:${trailingEdge ? "r.right-3" : "r.x+r.width/2"},y:r.y+r.height/2}; })()`,
        );
        for (const type of ["mousePressed", "mouseReleased"])
          await send("Input.dispatchMouseEvent", {
            type,
            ...point,
            button: "left",
            clickCount: 1,
          });
        await delay(150);
      }
      async function addReference() {
        await click("[data-add-reference]");
        await until(
          "document.querySelectorAll('.inline-composer-editor .reference-token').length===1",
          "one synthetic reference",
        );
        await click(".cm-content", true);
        await until(
          "document.activeElement===document.querySelector('.cm-content')",
          "editor receives pointer focus",
        );
      }
      async function clear() {
        await key("a", "KeyA", 2);
        await key("Backspace", "Backspace");
        await until(
          "window.composerFixture.snapshot().draft.text===''",
          "delete all updates the real draft",
        );
        await delay(250);
      }
      function bounded(value, label) {
        assert.ok(
          value.scroller.height > 0 &&
            value.scroller.bottom <= value.rail.y + 1,
          `${label}: scroller is above toolbar`,
        );
        assert.ok(
          value.editor.height <= 136 && value.editor.height >= 36,
          `${label}: editor height bounded`,
        );
        assert.ok(
          value.scroller.scrollWidth <= value.scroller.clientWidth + 1,
          `${label}: no horizontal overflow`,
        );
        assert.equal(value.scroller.overflowY, "auto");
        assert.deepEqual(
          value.violations,
          [],
          `${label}: production CSP permits required styles`,
        );
      }
      for (const scene of [
        { baseline: true, width: 1000, lang: "en", theme: "light" },
        { baseline: false, width: 1000, lang: "en", theme: "light" },
        { baseline: false, width: 420, lang: "zh-CN", theme: "light" },
        { baseline: false, width: 420, lang: "en", theme: "dark" },
        { baseline: false, width: 1000, lang: "zh-CN", theme: "dark" },
      ]) {
        const result = { ...scene, status: "running", phase: "navigation" };
        report.push(result);
        async function capture(label) {
          result.phase = label;
          return (result[label] = await evaluate(measure));
        }
        try {
          const { baseline, width, lang, theme } = scene;
          const prefix = `${baseline ? "before" : "after"}-${width}-${lang}-${theme}`;
          const entry = new URL(url);
          if (baseline) entry.searchParams.set("baseline", "1");
          entry.searchParams.set("lang", lang);
          entry.searchParams.set("theme", theme);
          await send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 700,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await send("Page.navigate", { url: entry.href });
          await until("!!window.composerFixture", "fixture mounts");
          await evaluate("document.fonts.ready");
          const pristineEmpty = await capture("pristineEmpty");
          await screenshot(`${prefix}-pristine-empty.png`);
          result.phase = "add short reference";
          await addReference();
          await send("Input.insertText", { text: " Short synthetic draft." });
          await delay(250);
          const short = await capture("short");
          assert.equal(short.state.draft.references.length, 1);
          await screenshot(`${prefix}-short.png`);
          await clear();
          const emptyAfterShort = await capture("emptyAfterShort");
          assert.equal(emptyAfterShort.state.draft.references.length, 0);
          await screenshot(`${prefix}-empty-short.png`);
          await addReference();
          // Real clipboard paste reaches CodeMirror's production paste handler.
          await send("Browser.grantPermissions", {
            origin: entry.origin,
            permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
          });
          await evaluate(
            `navigator.clipboard.writeText(${JSON.stringify(longText)})`,
          );
          await key("v", "KeyV", 2);
          await until(
            `window.composerFixture.snapshot().draft.text.includes(${JSON.stringify(longText)})`,
            "long paste preserves exact text",
          );
          await delay(400);
          const long = await capture("long");
          const doc = await send("DOM.getDocument");
          const contentNode = await send("DOM.querySelector", {
            nodeId: doc.root.nodeId,
            selector: ".cm-content",
          });
          result.renderedFonts = (
            await send("CSS.getPlatformFontsForNode", {
              nodeId: contentNode.nodeId,
            })
          ).fonts;
          assert.equal(long.state.draft.references.length, 1);
          assert.equal(long.state.draft.references[0].excerpt, exactExcerpt);
          await screenshot(`${prefix}-long-bottom.png`);
          await key("Home", "Home", 2);
          await delay(250);
          const longTop = await capture("longTop");
          await screenshot(`${prefix}-long-top.png`);
          const r = longTop.scroller;
          await send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
            deltaX: 0,
            deltaY: 560,
          });
          await delay(300);
          const afterWheel = await capture("afterWheel");
          await clear();
          const emptyAfterLong = await capture("emptyAfterLong");
          await screenshot(`${prefix}-empty-long.png`);
          assert.equal(emptyAfterLong.state.sent, 0, "editing never submits");
          // Keep baseline diagnostic, not a fabricated before CSS override.
          if (!baseline) {
            for (const [label, value] of Object.entries({
              short,
              emptyAfterShort,
              long,
              longTop,
              afterWheel,
              emptyAfterLong,
            }))
              bounded(value, label);
            assert.ok(
              long.scroller.scrollHeight > long.scroller.clientHeight + 100,
              "long input genuinely overflows internally",
            );
            assert.ok(
              afterWheel.scroller.scrollTop > longTop.scroller.scrollTop,
              "real wheel scrolls the editor",
            );
            for (const empty of [emptyAfterShort, emptyAfterLong]) {
              assert.equal(empty.state.draft.text, "");
              assert.equal(empty.state.editorText, "");
              assert.equal(empty.state.draft.references.length, 0);
              assert.ok(
                Math.abs(empty.shell.height - pristineEmpty.shell.height) <= 1,
                "clear restores pristine shell height",
              );
              for (const box of [empty.editor, empty.scroller])
                assert.ok(
                  Math.abs(box.height - pristineEmpty.plain.height) <= 1,
                  "clear restores pristine input height",
                );
              assert.equal(
                empty.scroller.scrollTop,
                0,
                "empty editor has no residual scroll",
              );
            }
            result.phase = "undo long deletion";
            await key("z", "KeyZ", 2);
            await until(
              "window.composerFixture.snapshot().draft.references.length===1",
              "undo restores reference metadata",
            );
            const undone = await capture("undone");
            assert.equal(
              undone.state.editorText,
              long.state.editorText,
              "undo restores all original code units",
            );
            assert.equal(
              undone.state.draft.references[0].excerpt,
              exactExcerpt,
            );
            bounded(undone, "undo long deletion");
            await key("z", "KeyZ", 10);
            await until(
              "window.composerFixture.snapshot().draft.text===''",
              "redo clears again",
            );
            await send("Input.insertText", { text: "重新输入 Re-enter 😀" });
            await until(
              "window.composerFixture.snapshot().draft.text==='重新输入 Re-enter 😀'",
              "re-entry exact",
            );
            await key("z", "KeyZ", 2);
            await until(
              "window.composerFixture.snapshot().draft.text===''",
              "undo re-entry",
            );
            await key("z", "KeyZ", 10);
            await until(
              "window.composerFixture.snapshot().draft.text==='重新输入 Re-enter 😀'",
              "redo re-entry",
            );
            await clear();
            await addReference();
            await click(".inline-composer-editor .reference-token-remove");
            await until(
              "window.composerFixture.snapshot().draft.references.length===0",
              "remove token button",
            );
            bounded(await evaluate(measure), "reference removal");
            result.editingRegression =
              "paste, wheel, delete-all, undo/redo, re-entry, reference removal passed";
          }
          result.status = "passed";
          result.phase = "complete";
          console.log("COMPOSER_OVERFLOW " + JSON.stringify(result));
        } catch (error) {
          result.status = "failed";
          result.error = String(error.stack ?? error);
          try {
            result.lastSnapshot = await evaluate(measure);
          } catch (snapshotError) {
            result.snapshotError = String(snapshotError);
          }
          try {
            await screenshot(
              `failed-${scene.baseline ? "before" : "after"}-${scene.width}-${scene.lang}.png`,
            );
          } catch (screenshotError) {
            result.screenshotError = String(screenshotError);
          }
          throw error;
        }
      }
    },
  );
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await writeFile(
    path.join(directory, "measurements.json"),
    JSON.stringify(
      {
        scope:
          "Production ThreadView and InlineComposerEditor; exact production CSP before/after existing per-document nonce transform. All draft/excerpt/model data synthetic; no Host or Provider request. Chromium loopback renderer test, not packaged Electron or physical OS input acceptance.",
        browserVersion,
        scenes: report,
      },
      null,
      2,
    ),
  );
}
