# Remaining PR #286 scope, refreshed onto current main

This candidate replaces only the remaining machine-picker width and output-rate work from PR #286 (issues #283 and #284). The unread feature shipped separately in #325; this change neither imports the old unread implementation nor closes that broader historical scope.

## Behavior

- The machine Select uses a dedicated portaled popover class, with a 260 px preferred minimum and a 360 px maximum, both clamped to the viewport. The generic Select keeps its default sizing.
- Completed-message telemetry includes output tokens/s. The session context indicator exposes an aggregate rate computed as total observed output tokens divided by the matching completed Turn durations, rather than the mean of per-Turn rates.
- Missing usage, missing/nonpositive/nonfinite duration, or no observed output yields Unknown. Failed and unmeasured Turns are excluded. Idle gaps between Turns are excluded; tools and waits inside each Turn remain included. This is observed Turn throughput, not provider-only decode speed.
- Native live completion and recovered history derive durations from canonical millisecond timestamps. Renderer receipt time and second-rounded display timestamps cannot inflate short-Turn rates.

## Verification

- Related renderer tests: **124/124 passed**, covering Fleet composer, ThreadView component/state, conversation viewport and context-usage indicator.
- New bounded integration cases cover weighted session rates, failed/unmeasured/untimed Turns, zero/negative/nonfinite durations, and identical 250 ms live/recovery windows independent of renderer receipt time.
- ZenX Node and Web TypeScript checks passed. First-party SDK was built before the Node check.
- Synthetic production-component fixture bundles successfully: `apps/zenx/test/fixtures/machine-throughput-visual.html` and `.tsx`. It uses long fake machine labels and a 900-token/3-second Turn. Parameters: `theme=dark`, `lang=zh`, `unknown=1`. It does not contact actual machines.

Original PR #286 already underwent three review rounds. This refresh is for bounded integration verification, not a new full-review round. Real rendered screenshot capture and precise-head CI remain required before merge; no visual pass is claimed here.
