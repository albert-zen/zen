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
  api.selectScene("latest-requested");
  await wait();
  assert.equal(
    dom.window.document.querySelectorAll(".turn-history .mini-spinner").length,
    1,
  );
  api.returnLatest();
  await wait();
  assert.equal(
    dom.window.document.querySelectorAll(
      ".turn-history .mini-spinner, .turn-history .activity-sweep",
    ).length,
    0,
  );
  api.waitAgain();
  await wait();
  assert.equal(
    dom.window.document.querySelectorAll(".turn-history .mini-spinner").length,
    1,
  );
  api.interrupt();
  await wait();
  assert.ok(dom.window.document.querySelector(".turn-history") === null);
  api.returnLatest(true);
  await wait();
  assert.ok(dom.window.document.querySelector(".turn-history") === null);
  dom.window.document.querySelector(".turn-toggle").click();
  await wait();
  assert.equal(
    dom.window.document.querySelectorAll(
      ".turn-history .mini-spinner, .turn-history .activity-sweep",
    ).length,
    0,
  );
  assert.ok(
    dom.window.document.querySelector(
      ".trace-counts, .turn-outcome-primary-action, .turn-outcome-review",
    ) === null,
  );
  const latest = [
    ...dom.window.document.querySelectorAll(".trace-singleton"),
  ].at(-1);
  latest.querySelector(".trace-item-toggle").click();
  await wait();
  assert.match(
    latest.querySelector(".trace-detail").textContent,
    /Synthetic tool error/u,
  );
  assert.deepEqual(errors, []);
  console.log(
    `${api.scenes.length} actual-component scenes, four same-turn transitions and return → new wait → interruption → late error passed DOM-only smoke.`,
  );
} finally {
  dom.window.close();
}
