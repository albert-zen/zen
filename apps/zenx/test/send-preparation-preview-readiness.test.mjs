import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Execute the capture's actual CDP expression, not a duplicate test predicate.
const source = await readFile(
  new URL("../scripts/capture-send-preparation-preview.mjs", import.meta.url),
  "utf8",
);
const template = source.match(
  /const sceneReady = \(\) =>\s*evaluate\(\s*`([^`]+)`/u,
)?.[1];
assert.ok(template, "capture must expose its scene readiness expression");
const sceneUrl = "http://127.0.0.1/send-preparation-preview.html?theme=dark";
const expression = runInNewContext(`\`${template}\``, {
  sceneUrl,
  theme: "dark",
});
const ready = ({
  href = sceneUrl,
  root = { dataset: { appearance: "dark" } },
  label = "Preparing for 12s",
} = {}) =>
  runInNewContext(expression, {
    location: { href },
    document: {
      documentElement: root,
      querySelector(selector) {
        assert.equal(selector, ".turn-running-label .turn-work-label");
        return label === null ? null : { textContent: label };
      },
    },
  });

test("navigation without a document root is not ready and can recover", () => {
  assert.equal(ready({ root: null }), false);
  assert.equal(ready(), true);
});

test("readiness still requires the exact new URL, theme, and Preparing clock", () => {
  assert.equal(ready({ href: sceneUrl.replace("dark", "light") }), false);
  assert.equal(ready({ root: { dataset: { appearance: "light" } } }), false);
  assert.equal(ready({ root: { dataset: {} } }), false);
  for (const label of [
    null,
    "Preparing",
    "Preparing for 0s",
    "Working for 12s",
  ])
    assert.equal(ready({ label }), false);
  assert.equal(ready(), true);
});

test("unexpected evaluation errors remain failures rather than readiness retries", () => {
  assert.throws(
    () =>
      runInNewContext(expression, {
        location: { href: sceneUrl },
        document: {
          documentElement: { dataset: { appearance: "dark" } },
          querySelector() {
            throw Error("unexpected renderer failure");
          },
        },
      }),
    /unexpected renderer failure/u,
  );
});
