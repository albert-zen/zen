/** DOM-only smoke; deliberately does not claim browser geometry/visual success. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM, VirtualConsole } from "jsdom";
const html = await readFile(process.argv[2], "utf8");
const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => errors.push(error.message));
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "http://localhost/process-style-frame.html",
  virtualConsole,
  beforeParse(window) {
    window.structuredClone = structuredClone;
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    });
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    window.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback;
      }
      observe(target) {
        this.callback([{ target, isIntersecting: true }]);
      }
      unobserve() {}
      disconnect() {}
    };
    window.HTMLElement.prototype.scrollIntoView = function () {};
    window.HTMLElement.prototype.scrollTo = function () {};
    window.scrollTo = function () {};
  },
});
try {
  const wait = () => new Promise((resolve) => setTimeout(resolve, 80));
  await wait();
  const api = dom.window.__processStylePreview;
  assert.ok(api, "Actual fixture mounted");
  for (const scene of api.scenes) {
    api.selectScene(scene);
    await wait();
    assert.ok(dom.window.document.querySelector(".turn"), scene);
    if (["thinking", "waiting", "running", "parallel"].includes(scene)) {
      const turn = dom.window.document.querySelector(".turn");
      const header = turn.querySelector(":scope > .turn-running-label");
      assert.equal([...turn.children].indexOf(header), 1);
      api.finish();
      await wait();
      assert.equal(
        dom.window.document.querySelector(".turn"),
        turn,
        "Same turn, no remount",
      );
      assert.equal(
        [...turn.children].indexOf(turn.querySelector(":scope > .turn-toggle")),
        1,
      );
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    "10 actual-component scenes and four same-turn transitions passed DOM-only smoke.",
  );
} finally {
  dom.window.close();
}
