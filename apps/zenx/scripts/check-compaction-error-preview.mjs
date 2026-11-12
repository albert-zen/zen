import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
import assert from "node:assert/strict";
const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => {
  if (e.type !== "css-parsing") errors.push(String(e));
});
const dom = new JSDOM(
  fs.readFileSync(
    process.argv[2] ?? ".compaction-error-preview/compaction-error.html",
    "utf8",
  ),
  {
    url: "http://localhost/compaction-error.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      });
    },
  },
);
const w = dom.window,
  d = w.document;
const pause = () => new Promise((r) => setTimeout(r, 300));
await pause();
for (const [scenario, state, cause] of [
  ["http400", "failed", "HTTP 400"],
  ["refresh-failed", "succeeded", "read-only thread/resume"],
  ["unknown", "failed", "Commit outcome is unknown"],
]) {
  const select = d.querySelector('select[aria-label="Scenario"]');
  select.value = scenario;
  select.dispatchEvent(new w.Event("change", { bubbles: true }));
  await pause();
  assert.equal(d.querySelector("output").textContent, state);
  const details = d.querySelector(".context-compaction-progress details");
  assert(details);
  assert.equal(details.open, false);
  details.querySelector("summary").click();
  assert(details.open);
  assert(details.textContent.includes(cause));
  assert(!d.querySelector(".context-compaction-progress .mini-spinner"));
  d.querySelector(".context-compaction-dismiss").click();
  await pause();
  assert.equal(d.querySelector("output").textContent, "dismissed");
  [...d.querySelectorAll("button")]
    .find((b) => b.textContent === "Replay synthetic scenario")
    .click();
  await pause();
  assert.equal(d.querySelector("output").textContent, state);
  console.log(
    "PASS",
    scenario,
    "closed details -> expanded -> dismiss -> replay",
  );
}
assert.deepEqual(errors, []);
dom.window.close();
