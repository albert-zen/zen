import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildHistoryCounterfactual,
  historyBaselineContract,
  gitBlob,
} from "../scripts/inactive-history-baseline.mjs";

const current = readFileSync(
  new URL("../src/renderer/src/App.tsx", import.meta.url),
  "utf8",
);
const { edits } = historyBaselineContract;

test("current App counterfactual removes only the three reviewed cache additions", () => {
  const result = buildHistoryCounterfactual(current);
  let expected = current;
  for (const edit of edits)
    expected = expected.replace(edit.after, edit.before);
  assert.equal(result.baseline, expected);
  assert.equal(result.provenance.candidateAppBlob, gitBlob(current));
  assert.equal(result.provenance.exactRoundTrip, true);
  assert.equal(
    result.provenance.kind,
    "same-revision-cache-only-counterfactual",
  );
});

test("unrelated imports, callbacks and Unicode UI changes remain identical in both variants", () => {
  const changed =
    "// Independent App Shot change: 截图\n" +
    current.replace(
      "export function AppConversationProviders({",
      'const unrelatedAppShotCallback = () => "capture";\nexport function AppConversationProviders({',
    );
  // Insertion inside an exact patch anchor is deliberately rejected.
  assert.throws(
    () => buildHistoryCounterfactual(changed),
    /exact reviewed fragment/,
  );
  const independent =
    "// Independent App Shot change: 截图\n" +
    current +
    '\nconst unrelatedAppShotCallback = () => "capture";\n';
  const baseline = buildHistoryCounterfactual(independent).baseline;
  assert.equal(
    baseline,
    "// Independent App Shot change: 截图\n" +
      buildHistoryCounterfactual(current).baseline +
      '\nconst unrelatedAppShotCallback = () => "capture";\n',
  );
});

for (const edit of edits) {
  test(`missing or duplicated ${edit.id} fails closed`, () => {
    assert.throws(
      () =>
        buildHistoryCounterfactual(current.replace(edit.after, edit.before)),
      /exact reviewed fragment/,
    );
    assert.throws(
      () => buildHistoryCounterfactual(current + "\n" + edit.after),
      /exact reviewed fragment/,
    );
  });
}

test("cache policy edits and extra call sites require a reviewed contract change", () => {
  assert.throws(
    () =>
      buildHistoryCounterfactual(
        current.replace("inactive.slice(0, -4)", "inactive.slice(0, -8)"),
      ),
    /exact reviewed fragment/,
  );
  assert.throws(
    () => buildHistoryCounterfactual(current + "\ntrimThreadHistoryCache();\n"),
    /unreviewed retention reference/,
  );
});

test("counterfactual cannot be transformed twice", () => {
  assert.throws(
    () =>
      buildHistoryCounterfactual(buildHistoryCounterfactual(current).baseline),
    /exact reviewed fragment/,
  );
});
