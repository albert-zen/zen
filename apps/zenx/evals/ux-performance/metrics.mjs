/** Synthetic measurement contracts. Rebuilt from retained task code, not an old Git object. */
export const SCHEMA_VERSION = 1;
export const CADENCE_MS = 64;

export function summarize(samples) {
  if (!samples.length) throw new Error("Empty measurement samples");
  for (const sample of samples) {
    if (!Number.isFinite(sample.ms) || sample.ms < 0)
      throw new Error("Invalid measurement duration");
    if (
      !Number.isFinite(sample.startedAtMs) ||
      sample.startedAtMs < 0 ||
      !Array.isArray(sample.longtasks)
    )
      throw new Error("Invalid sample timing metadata");
    for (const task of sample.longtasks)
      if (
        !Number.isFinite(task.start) ||
        task.start < 0 ||
        !Number.isFinite(task.duration) ||
        task.duration < 0
      )
        throw new Error("Invalid long task");
    for (const key of ["markdown", "thread", "commits"])
      if (!Number.isInteger(sample.counts?.[key]) || sample.counts[key] < 0)
        throw new Error("Invalid work count");
    if (!Number.isInteger(sample.domNodes) || sample.domNodes < 1)
      throw new Error("Invalid DOM count");
  }
  const sorted = samples.map((x) => x.ms).sort((a, b) => a - b);
  return {
    n: samples.length,
    p50Ms: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms:
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    samples,
  };
}

export function verifyManifest(manifest, expectedSha) {
  if (
    manifest.schemaVersion !== SCHEMA_VERSION ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceSha) ||
    manifest.sourceSha !== expectedSha ||
    manifest.sourceDirty !== false ||
    manifest.production !== true ||
    manifest.synthetic !== true ||
    manifest.instrumented !== true ||
    !/^[a-f0-9]{64}$/.test(manifest.htmlSha256)
  )
    throw new Error("Invalid or mismatched clean-source build provenance");
}

export function instrument(code, id) {
  const targets = [
    [
      "/src/renderer/src/Markdown.tsx",
      "  inlineTokens?: readonly MarkdownInlineToken[];\n}) {",
      "  window.__uxCounts.markdown++;",
    ],
    [
      "/src/renderer/src/ThreadView.tsx",
      "export function ThreadView(props: ThreadViewProps) {",
      " window.__uxCounts.thread++;",
    ],
  ];
  for (const [suffix, needle, increment] of targets)
    if (id.endsWith(suffix)) {
      if (code.split(needle).length !== 2)
        throw new Error(`Ambiguous instrumentation target: ${suffix}`);
      return code.replace(needle, needle + increment);
    }
}

/** Reject no-op, dropped/duplicate deltas, stale DOM or absent React work. */
export function verifyTranscriptUpdates(
  before,
  after,
  samples,
  expectedDeltas,
) {
  if (
    typeof before.lastText !== "string" ||
    typeof before.renderedLastText !== "string" ||
    !Number.isInteger(expectedDeltas) ||
    expectedDeltas < 1 ||
    samples.length !== expectedDeltas
  )
    throw new Error("Invalid transcript update boundary");
  let lastText = before.lastText;
  let renderedLastText = before.renderedLastText;
  for (const sample of samples) {
    lastText += " delta";
    renderedLastText += " delta";
    if (
      sample.transcript?.lastText !== lastText ||
      sample.transcript?.renderedLastText !== renderedLastText ||
      !["thread", "markdown", "commits"].every((key) => sample.counts[key] > 0)
    )
      throw new Error(
        "Transcript delta did not update exact projected text, rendered text and React work",
      );
  }
  if (
    after.lastText !== lastText ||
    after.renderedLastText !== renderedLastText
  )
    throw new Error("Final transcript delta state mismatch");
}
