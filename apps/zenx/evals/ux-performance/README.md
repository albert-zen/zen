# Synthetic UX performance evidence

This harness was **rebuilt from retained task code after a cloud workspace reset**. It is not byte-for-byte recovery of the previous local commit, and requires fresh review and validation. The old browser baseline never ran successfully; no prior browser performance numbers are claimed.

The isolated production Vite bundle measures actual ThreadView and Markdown components with synthetic data. It does **not** run App, Electron/native IPC, storage, providers or user data. Click/send admission uses an explicitly controlled synthetic component-boundary bridge, not a native send service. No screenshots are taken.

## Reproduce

Use a clean committed checkout, its installed dependencies, and existing Chromium/Chrome. Scripts do not install dependencies or download browsers. Build outputs must be outside the source checkout (or explicitly gitignored).

```sh
npm run prepare:plugin-sdk --workspace @zen/zenx
node --test apps/zenx/test/ux-performance-contract.test.mjs
npx --no-install tsc -p apps/zenx/evals/ux-performance/tsconfig.json
node apps/zenx/scripts/build-ux-performance.mjs /tmp/zen-ux-performance
node apps/zenx/scripts/measure-ux-performance.mjs /tmp/zen-ux-performance
# Optional bounded stress; not enabled on ordinary PRs:
node apps/zenx/scripts/measure-ux-performance.mjs /tmp/zen-ux-performance --include-5000
# Socket-free functional smoke only, NOT browser/performance evidence:
node apps/zenx/evals/ux-performance/smoke-fixture.mjs /tmp/zen-ux-performance
```

The runner checks clean source (excluding dependency symlinks), exact build/runner SHA and HTML SHA-256. Failed provenance, readiness, behavior, malformed metrics or cleanup fails the run. Its JSON retains failure stage and partial results. A local environment denying Chromium sockets cannot perform this test: use an authorized hosted runner, never bypass sandbox restrictions. The existing preview-browser helper owns teardown and lifecycle receipts.

The dedicated workflow runs for changes to its harness paths in a PR, or manual dispatch; it does not add work to every product PR. A new workflow first runs via its authorized PR and becomes dispatchable once on the default branch. Ten-minute job and four-minute browser step bound execution. A 15-second CDP timeout is failed/censored evidence, not an invented latency.

## Cases

- 100 and 1,000 synthetic messages: one visible assistant message per turn, final turn active. First mount once, 30 `item_delta` reducer updates, five A→B→unmount→restore-A revisits. Every delta must grow both projected and final-message DOM text by exactly ` delta`, with positive ThreadView/Markdown/commit counts. No-op, dropped/duplicate deltas and stale DOM fail acceptance.
- Revisit saves the exact immutable streamed snapshot in the fixture, restores it after unmount and asserts projection/DOM equality. It measures component remount plus retained reading state, **not** native history-cache navigation. First mount includes fixture construction; restore does not reconstruct original unstreamed text.
- Optional 5,000-message case: one mount, three deltas, one preserved-snapshot revisit.
- Markdown starts with exactly 51,200 ASCII characters of headings, emphasis, inline code, links and lists. Thirty complete-text prefix updates append six characters each, ending at 51,380. Cadence targets 64ms (~15.6Hz) and is sequential/backpressured: slow work delays the next update without queuing a backlog. Actual sample start times are retained. This is not a 500-delta stress run or a complete Markdown corpus.
- Ten actual DOM clicks on the production send control must show pending/disabled feedback. Ten separately triggered synthetic admission transitions must display the admitted user message. No fake network delay is included in the feedback measurement.

First mount means the first mount of that fixture in an already-loaded browser, not cold browser startup or empty OS cache. Single-sample p95 has no statistical significance. Sequential deltas do not test cross-delta coalescing; a future finer-grained subscription may relax the ThreadView work guard, but must retain exact DOM assertions.

## Evidence and limitations

`measurements.json` schema version 1 retains build provenance, Chromium version, status/stage, raw samples, n/p50/p95, DOM-node counts, long tasks, React commit and ThreadView/Markdown invocation counts. Source instrumentation is measurement-only, fails on ambiguous targets, and adds overhead; cross-check an uninstrumented trace before precise speedup claims.

Duration is action→two animation-frame callbacks plus a timer: a **paint-opportunity proxy**, not proof of painted pixels. Counts cover the whole sample window (including incidental timers), not parser-only CPU. Long-task entries are asynchronous and crossing-window work may be omitted. No IPC-byte, retained-heap, GPU/compositor, service-latency or entire-repository performance claim is made.

CI has no noisy millisecond gate. It validates behavior and deterministic metric/provenance contracts, recording work for same-machine comparisons. Use accepted browser evidence to set future targeted render/parser work budgets. The jsdom smoke only validates 100 turns, exact delta projection/DOM/work, snapshot restore and click/admission behavior; it outputs no performance timings.

## Validation status

Each rebuilt checkpoint requires fresh contract tests, fixture typecheck, production build and functional smoke. Real Chromium measurement remains separately gated on a successful authorized runner. A production build or jsdom pass is never reported as browser performance acceptance. See the accompanying PR for exact tested SHA and stage outcomes.

## Unshipped heading-segmentation experiment

`test/markdown-heading-prototype.test.ts` is a test-only feasibility check, not
an enabled Markdown fast path. From `apps/zenx`, run:

```sh
node --import tsx --test test/markdown-heading-prototype.test.ts
```

It compares every UTF-16 prefix of synthetic headings, prose, lists, tables,
nested blocks, fences, late references, multiline constructs, footnotes, HTML,
math, Unicode, CRLF, unsafe URLs and local-file links against the **unchanged
production Markdown renderer**, both with and without message-link context.
Inline-token inputs always retain the whole source. The proposed split is
only immediately before a column-zero ATX heading following a blank line;
fences, indentation, blockquotes, `<`, CR, `$`, line-leading `[` and inline
tokens conservatively disable all splitting. No prefix history or global cache
is used. A literal newline joins rendered sections, preserving the renderer's
inter-block text nodes; code whitespace is compared exactly, never normalized.

The same test prints seven alternating Node SSR CPU samples summarized by
median for 8, 64 and 417 sections. Both timed alternatives use a single SSR
root; the candidate mounts a full production pipeline per section and retains
its extra wrapper elements. This isolates an initial-render feasibility risk,
not a production DOM implementation or browser benchmark. Timings have no CI
threshold and do not demonstrate update/memoization benefit. No callbacks,
context subscriptions, token equality or security policies are replaced.
A product candidate would still need live context/locale, replacement,
truncation, snapshot and stream-end tests plus hosted unchanged-baseline and
candidate browser measurements. Do not adopt this experiment on parse-character
counts alone: hundreds of fresh processors may materially worsen initial mount.
