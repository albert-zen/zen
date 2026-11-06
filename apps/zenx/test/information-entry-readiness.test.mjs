import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(
  new URL("../scripts/capture-information-entry-preview.mjs", import.meta.url),
  "utf8",
);
const destination =
  "http://127.0.0.1:1234/titlebar-safe-area.html?platform=linux";
// Execute the exact initial Page.navigate readiness expression, not a copy of
// its intended behavior. Later geometry and interaction assertions stay strict.
const expression = source
  .match(/`(location\.href===\$\{JSON\.stringify\(destination\)\}[^`]+)`/)[1]
  .replace("${JSON.stringify(destination)}", JSON.stringify(destination));
function ready({ href = destination, body = null, button = null } = {}) {
  return runInNewContext(expression, {
    location: { href },
    document: {
      body,
      querySelector(selector) {
        assert.equal(selector, ".information-toolbar button");
        return button;
      },
    },
  });
}

test("information entry readiness waits while navigation has no body", () => {
  assert.equal(ready(), false);
  assert.equal(ready({ href: "about:blank" }), false);
});
test("information entry readiness requires exact URL, ready marker and button", () => {
  assert.equal(ready({ body: { dataset: {} } }), false);
  assert.equal(
    ready({ body: { dataset: { previewReady: "false" } }, button: {} }),
    false,
  );
  assert.equal(ready({ body: { dataset: { previewReady: "true" } } }), false);
  assert.equal(
    ready({
      href: "http://other/",
      body: { dataset: { previewReady: "true" } },
      button: {},
    }),
    false,
  );
  assert.equal(
    ready({ body: { dataset: { previewReady: "true" } }, button: {} }),
    true,
  );
});
test("information entry keeps bounded readiness and strict interaction coverage", () => {
  assert.match(source, /n < 160/);
  assert.match(source, /await delay\(25\)/);
  assert.match(source, /throw Error\(`Timed out:/);
  assert.match(source, /verifySlot\(split, "split"\)/);
  assert.match(source, /verifySlot\(full, "maximized-main"\)/);
  assert.match(source, /\["darwin", "win32", "linux"\]/);
});
