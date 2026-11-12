/** Functional-only jsdom smoke; no browser/performance measurement claims. */
import { JSDOM, VirtualConsole } from "jsdom";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { verifyTranscriptUpdates } from "./metrics.mjs";
const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push(String(e)));
const dom = new JSDOM(
  await readFile(path.join(process.argv[2], "ux-performance.html"), "utf8"),
  {
    url: "http://synthetic.invalid/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.PerformanceObserver = class {
        observe() {}
      };
      w.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      w.matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      });
      w.HTMLElement.prototype.scrollIntoView = function () {};
      w.HTMLElement.prototype.scrollTo = function () {};
      w.document.fonts = {
        ready: Promise.resolve(),
        addEventListener() {},
        removeEventListener() {},
      };
    },
  },
);
try {
  for (let i = 0; i < 100 && !dom.window.__ux; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.ok(dom.window.__ux);
  await dom.window.__ux.measure("open", 100, "a");
  assert.equal(dom.window.document.querySelectorAll(".turn").length, 100);
  assert.ok(dom.window.__uxCounts.markdown >= 100);
  assert.ok(dom.window.__uxCounts.commits > 0);
  const before = dom.window.__ux.transcript();
  const samples = [];
  for (let i = 0; i < 2; i++) {
    const sample = await dom.window.__ux.measure("delta");
    samples.push({ ...sample, transcript: dom.window.__ux.transcript() });
  }
  const streamed = dom.window.__ux.transcript();
  verifyTranscriptUpdates(before, streamed, samples, 2);
  dom.window.__ux.action("remember");
  await dom.window.__ux.measure("open", 100, "b");
  await dom.window.__ux.measure("clear");
  await dom.window.__ux.measure("restore", 100, "a");
  assert.deepEqual(dom.window.__ux.transcript(), streamed);
  await dom.window.__ux.measure("sendScene");
  await dom.window.__ux.measure("clickSend");
  assert.equal(dom.window.__ux.state().submission, "pending");
  await dom.window.__ux.measure("admit");
  assert.equal(dom.window.__ux.state().admitted, true);
  assert.equal(dom.window.__ux.state().submission, null);
  assert.deepEqual(errors, []);
  console.log(
    "JSDOM functional smoke passed; NOT browser or performance evidence",
  );
} finally {
  dom.window.close();
}
