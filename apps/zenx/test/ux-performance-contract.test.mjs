import assert from "node:assert/strict";
import test from "node:test";
import {
  summarize, verifyManifest, instrument, verifyTranscriptUpdates,
} from "../evals/ux-performance/metrics.mjs";

const sample = (ms) => ({
  ms, startedAtMs: 0, longtasks: [],
  counts: { markdown: 1, thread: 0, commits: 1 }, domNodes: 10,
});
test("summaries retain raw work counts and quantiles without latency thresholds", () => {
  const result = summarize([sample(10000), sample(1), sample(2)]);
  assert.equal(result.p50Ms, 2);
  assert.equal(result.p95Ms, 10000);
  assert.equal(result.n, 3);
  assert.equal(result.samples[0].counts.markdown, 1);
});
test("malformed measurements fail closed", () => {
  for (const samples of [
    [], [sample(NaN)], [sample(-1)],
    [{ ...sample(1), counts: {} }],
    [{ ...sample(1), longtasks: [{ start: 0, duration: NaN }] }],
    [{ ...sample(1), counts: { markdown: -1 } }],
    [{ ...sample(1), domNodes: 0 }],
  ]) assert.throws(() => summarize(samples));
});
test("clean exact SHA and production synthetic provenance are mandatory", () => {
  const manifest = {
    schemaVersion: 1, sourceSha: "a".repeat(40), sourceDirty: false,
    production: true, synthetic: true, instrumented: true,
    htmlSha256: "b".repeat(64),
  };
  verifyManifest(manifest, manifest.sourceSha);
  for (const patch of [
    { sourceDirty: true }, { production: false }, { synthetic: false },
    { instrumented: false }, { sourceSha: "bad" }, { htmlSha256: "" }, { schemaVersion: 2 },
  ]) assert.throws(() => verifyManifest({ ...manifest, ...patch }, manifest.sourceSha));
  assert.throws(() => verifyManifest(manifest, "c".repeat(40)));
});
test("instrumentation never silently misses or duplicates its source target", () => {
  const id = "/repo/apps/zenx/src/renderer/src/Markdown.tsx";
  const needle = "  inlineTokens?: readonly MarkdownInlineToken[];\n}) {";
  assert.match(instrument(needle, id), /__uxCounts.markdown\+\+/);
  assert.throws(() => instrument("", id));
  assert.throws(() => instrument(needle + needle, id));
  assert.equal(instrument("unchanged", "/other.tsx"), undefined);
});
test("transcript work requires every exact text delta, DOM update and commit", () => {
  const before = { lastText: "**Base**", renderedLastText: "Base" };
  const first = { ...sample(1), counts: { thread: 1, markdown: 1, commits: 1 },
    transcript: { lastText: "**Base** delta", renderedLastText: "Base delta" } };
  const second = { ...sample(1), counts: { thread: 1, markdown: 1, commits: 1 },
    transcript: { lastText: "**Base** delta delta", renderedLastText: "Base delta delta" } };
  verifyTranscriptUpdates(before, second.transcript, [first, second], 2);
  for (const bad of [
    { ...second, transcript: before },
    { ...second, transcript: first.transcript },
    { ...second, transcript: { ...second.transcript, lastText: second.transcript.lastText + " delta" } },
    { ...second, transcript: { ...second.transcript, renderedLastText: first.transcript.renderedLastText } },
    ...["thread", "markdown", "commits"].map((key) => ({ ...second, counts: { ...second.counts, [key]: 0 } })),
  ]) assert.throws(() => verifyTranscriptUpdates(before, second.transcript, [first, bad], 2));
  assert.throws(() => verifyTranscriptUpdates(before, second.transcript, [second], 2));
  assert.throws(() => verifyTranscriptUpdates(before, before, [first, second], 2));
});
