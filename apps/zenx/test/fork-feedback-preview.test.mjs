import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { build } from "vite";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

test("the actual bundled fork fixture keeps the Composer contract through edits, pending, failure and success", async () => {
  const result = await build({
    configFile: false,
    root,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    build: {
      write: false,
      minify: true,
      cssCodeSplit: false,
      lib: {
        entry: path.join(
          root,
          "apps/zenx/test/fixtures/fork-feedback-visual.tsx",
        ),
        name: "ForkFeedbackPreview",
        formats: ["iife"],
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const js = output
    .filter((item) => item.type === "chunk")
    .map((item) => item.code)
    .join("\n");
  assert.ok(js.length > 0, "The production-component fixture bundled");
  for (const lang of ["en", "zh-CN"]) {
    const errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (error) => errors.push(error.message));
    virtualConsole.on("error", (error) =>
      errors.push(error?.message ?? String(error)),
    );
    const dom = new JSDOM(
      `<div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script>`,
      {
        runScripts: "dangerously",
        pretendToBeVisual: true,
        url: `http://localhost/fork-feedback-preview.html?lang=${lang}`,
        virtualConsole,
        beforeParse(window) {
          window.structuredClone = structuredClone;
          window.matchMedia = (media) => ({
            media,
            matches: false,
            addEventListener() {},
            removeEventListener() {},
          });
          window.HTMLElement.prototype.scrollIntoView = function () {};
          window.HTMLElement.prototype.scrollTo = function () {};
          window.scrollTo = function () {};
        },
      },
    );
    const doc = dom.window.document;
    const settled = async (predicate) => {
      const deadline = Date.now() + 2000;
      while (!predicate() && errors.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(
        errors,
        [],
        `${lang}: fixture renders without runtime exceptions`,
      );
      assert.ok(predicate(), `${lang}: expected fixture transition appeared`);
    };
    try {
      await settled(() => Boolean(doc.querySelector(".message-fork")));
      const completeCopy = doc.querySelector('[data-fork-preview="complete"]');
      const failCopy = doc.querySelector('[data-fork-preview="fail"]');
      assert.equal(completeCopy?.textContent, "Complete copy");
      assert.equal(failCopy?.textContent, "Fail copy");
      assert.equal(completeCopy?.disabled, true);
      assert.equal(failCopy?.disabled, true);
      completeCopy.click();
      failCopy.click();
      assert.match(doc.querySelector("header").textContent, /0 fork request/);
      const textarea = doc.querySelector(".composer textarea");
      assert.ok(textarea, `${lang}: production Composer mounted`);
      assert.equal(textarea.value, "");
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      ).set.call(textarea, "Keep this synthetic draft.");
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      const fork = doc.querySelector(".message-fork");
      fork.click();
      fork.click();
      await settled(
        () =>
          doc.querySelector(".message-fork")?.getAttribute("aria-busy") ===
          "true",
      );
      assert.equal(
        doc.querySelector(".composer textarea")?.value,
        "Keep this synthetic draft.",
      );
      assert.match(doc.querySelector("header").textContent, /1 fork request/);
      assert.ok(
        doc.querySelector(".message-fork .mini-spinner"),
        "Pending Fork is visible",
      );
      assert.equal(completeCopy.disabled, false);
      assert.equal(failCopy.disabled, false);
      assert.equal(typeof dom.window.__forkPreview.complete, "function");
      assert.equal(typeof dom.window.__forkPreview.fail, "function");
      const failedRequest = dom.window.__forkPreview;
      failCopy.click();
      await settled(() =>
        Boolean(doc.querySelector(".message-fork-error[role=alert]")),
      );
      assert.equal(completeCopy.disabled, true);
      assert.equal(failCopy.disabled, true);
      failedRequest.complete();
      assert.match(doc.querySelector("header").textContent, /Source thread/);
      assert.equal(doc.querySelector(".message-fork").disabled, false);
      assert.equal(
        doc.querySelector(".turn-toggle").getAttribute("aria-expanded"),
        "false",
      );
      assert.ok(
        doc.querySelector('[data-read-message-id="final"]'),
        "Failure preserves the actual answer",
      );
      doc.querySelector(".message-fork").click();
      await settled(
        () =>
          doc.querySelector(".message-fork")?.getAttribute("aria-busy") ===
          "true",
      );
      assert.equal(completeCopy.disabled, false);
      assert.equal(failCopy.disabled, false);
      completeCopy.click();
      await settled(() =>
        doc.querySelector("header")?.textContent.includes("Copied thread"),
      );
      assert.ok(
        doc.querySelector('[data-read-message-id="final"]'),
        "Copy retains the actual answer",
      );
      assert.equal(
        doc.querySelector(".turn-toggle").getAttribute("aria-expanded"),
        "false",
      );
      assert.equal(
        doc.querySelector(".composer textarea")?.value,
        "Keep this synthetic draft.",
      );
      assert.equal(completeCopy.disabled, true);
      assert.equal(failCopy.disabled, true);
      // Keep the scripted capture helper contract as well as real-click controls.
      doc.querySelector(".message-fork").click();
      await settled(() => !failCopy.disabled);
      dom.window.__forkPreview.fail();
      await settled(() =>
        Boolean(doc.querySelector(".message-fork-error[role=alert]")),
      );
      assert.equal(completeCopy.disabled, true);
      assert.equal(failCopy.disabled, true);
      doc.querySelector(".message-fork").click();
      await settled(() => !completeCopy.disabled);
      dom.window.__forkPreview.complete();
      await settled(() => completeCopy.disabled && failCopy.disabled);
      assert.match(doc.querySelector("header").textContent, /4 fork request/);
      assert.deepEqual(errors, []);
    } finally {
      dom.window.close();
    }
  }
});
