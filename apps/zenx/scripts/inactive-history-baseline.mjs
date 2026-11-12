import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Frozen, reviewed cache-only delta from #723, not a frozen whole current App.
const contractBytes = readFileSync(
  new URL("./inactive-history-baseline.json", import.meta.url),
);
export const historyBaselineContract = JSON.parse(contractBytes);
export const historyBaselineContractSha256 = createHash("sha256")
  .update(contractBytes)
  .digest("hex");
export const gitBlob = (source) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(source)}\0`)
    .update(source)
    .digest("hex");

function replaceUnique(source, from, to, id) {
  const offset = source.indexOf(from);
  assert.ok(
    offset >= 0 && source.indexOf(from, offset + 1) === -1,
    `Cache baseline ${id}: expected one exact reviewed fragment; review the cache delta before measuring`,
  );
  return source.slice(0, offset) + to + source.slice(offset + from.length);
}

export function buildHistoryCounterfactual(candidate) {
  const { schemaVersion, edits } = historyBaselineContract;
  assert.equal(schemaVersion, 1);
  assert.deepEqual(
    edits.map((e) => e.id),
    ["trim-definition", "trim-hook", "notification-trim"],
  );
  let baseline = candidate;
  for (const edit of edits) {
    assert.ok(
      edit.after.endsWith(edit.before) &&
        edit.after.length > edit.before.length,
    );
    baseline = replaceUnique(baseline, edit.after, edit.before, edit.id);
  }
  assert.doesNotMatch(
    baseline,
    /\b(?:trimThreadHistoryCache|trimThreadProjectionCache)\b/,
    "Cache baseline contains an unreviewed retention reference",
  );
  let restored = baseline;
  for (const edit of [...edits].reverse())
    restored = replaceUnique(
      restored,
      edit.before,
      edit.after,
      `${edit.id} round trip`,
    );
  assert.equal(
    restored,
    candidate,
    "Cache-only inverse must preserve every unrelated byte",
  );
  return {
    baseline,
    provenance: {
      kind: "same-revision-cache-only-counterfactual",
      origin: historyBaselineContract.origin,
      contractSha256: historyBaselineContractSha256,
      editedFragments: edits.map((e) => e.id),
      baselineAppBlob: gitBlob(baseline),
      candidateAppBlob: gitBlob(candidate),
      exactRoundTrip: true,
    },
  };
}
