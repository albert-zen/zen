import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";
const source = await readFile(
  new URL("../scripts/capture-information-entry-preview.mjs", import.meta.url),
  "utf8",
);
const body = source.slice(
  source.indexOf("const wait = async"),
  source.indexOf("const click = async"),
);
test("failed readiness preserves state even if screenshot fails, without retrying clicks", async () => {
  let reads = 0;
  let saved;
  const wait = vm.runInNewContext(`(()=>{${body}; return wait;})()`, {
    evaluate: async () =>
      ++reads <= 160
        ? false
        : { primaryTab: { selected: true }, toolbar: { hidden: true } },
    delay: async () => {},
    screenshot: async () => {
      throw Error("capture unavailable");
    },
    writeFile: async (_p, value) => {
      saved = JSON.parse(value);
    },
    path,
    directory: "/synthetic",
    evidence: { cases: [] },
  });
  await assert.rejects(wait("toolbar visible"), /Timed out: toolbar visible/);
  assert.equal(reads, 161);
  assert.equal(saved.observed.primaryTab.selected, true);
  assert.equal(saved.observed.toolbar.hidden, true);
  assert.match(saved.diagnosticErrors[0], /capture unavailable/);
});
