import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  verifyResultReading,
  verifyLastResultRow,
  observeResultReading,
} from "../scripts/result-reading-main-ui-preview.mjs";
const text = await readFile(
  new URL("./fixtures/result-reading-content.ts", import.meta.url),
  "utf8",
);
const fixture = await import(
  `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`
);
test("three deterministic display-only exchanges contain code and eight natural result rows", () => {
  assert.equal(fixture.resultReadingAnswers.length, 3);
  assert.equal(fixture.resultReadingPrompts.length, 3);
  assert.match(fixture.resultReadingAnswers[0], /```typescript/);
  const table = fixture.resultReadingAnswers[1];
  assert.equal(table.split("\n").filter((l) => l.startsWith("|")).length, 10);
  assert.match(
    table,
    /ExportSummaryValidationSyntheticIdentifierWithoutBreaks0123456789/,
  );
  assert.doesNotMatch(table, /<br>|firstTextTop|vertical-align/);
});
test("geometry verifier accepts observed overflow/misalignment but rejects missing cells and compressed prose", () => {
  const s = {
    rows: Array.from({ length: 8 }, () => ({
      cells: Array.from({ length: 4 }, () => ({ firstTextTop: 100 })),
      firstTextTopSpread: 45,
    })),
    dockOpen: true,
    dockVisible: true,
    proseLineHeight: "27px",
    composer: { bottom: 800 },
    viewport: { height: 900 },
    pageOverflow: 80,
  };
  verifyResultReading(s, true);
  assert.throws(() =>
    verifyResultReading({ ...s, proseLineHeight: "24px" }, true),
  );
  assert.throws(() => verifyResultReading({ ...s, rows: [] }, true));
  assert.throws(() => verifyResultReading(s, false));
});
test("measurement uses text range not cell bounding top and preserves opt-in source receipt", async () => {
  assert.match(observeResultReading.toString(), /createRange/);
  assert.match(observeResultReading.toString(), /firstTextTopSpread/);
  const visual = await readFile(
    new URL("./fixtures/ui-polish-visual.tsx", import.meta.url),
    "utf8",
  );
  assert.match(visual, /readingScene && params.get\("results"\) === "1"/);
  const receipt = await readFile(
    new URL("../scripts/build-main-ui-preview.mjs", import.meta.url),
    "utf8",
  );
  for (const path of [
    "result-reading-content.ts",
    "result-reading-main-ui-preview.mjs",
    "result-reading-main-ui-preview.test.mjs",
  ])
    assert(receipt.includes(path));
});

test("last row cannot pass when above viewport or below transcript/composer", () => {
  const state = {
    rows: [{ rect: { y: 200, bottom: 250, height: 50 } }],
    messages: { y: 100, bottom: 700 },
    composer: { y: 680 },
  };
  verifyLastResultRow(state);
  for (const rect of [
    { y: 20, bottom: 70, height: 50 },
    { y: 650, bottom: 710, height: 60 },
    { y: 200, bottom: 200, height: 0 },
  ])
    assert.throws(() => verifyLastResultRow({ ...state, rows: [{ rect }] }));
});
