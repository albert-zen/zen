# Retry presentation

The recovery status stays at the end of the Turn, after its received output and
activity. Automatic recovery, resumed normal work and the terminal outcome occupy the same place, so
following the newest content keeps recovery feedback visible. There is no second
recovery label at the top of a long Turn.

The default outcome is a compact single-row capsule with a light surface and thin border: status, retry metadata,
the optional **Details** disclosure and a pill-shaped **Retry** button. Narrow
viewports may wrap without hiding essential text or overflowing. Active recovery
and noncompact ongoing work use the same capsule treatment; expanded diagnostics use a modest corner radius
instead of stretching the capsule into a tall oval. Shared capsule/control/line-box
metrics keep the status icon, text and action vertically aligned, including the
animated activity text. Full technical errors and diagnostic identifiers appear only when
requested. User stops and unconfirmed background operations keep their distinct
meaning and receipts. The background-activity review link remains available.

**Retry** actually sends a separate localized continuation message (`继续` or
`Go on`). The native Host atomically admits it only against the exact latest
failed/aborted Turn using its existing admission lock. Stable request identity
and canonical retry provenance reconcile an uncertain acknowledgement rather
than starting another execution. The new agent Turn sees the original history
and actual tool receipts; no tool operation is replayed by the retry button.
Composer draft text, images and selection are not read, submitted or cleared.
Repeated clicks share a pending request, with visible busy/disabled feedback.

Automatic recovery uses only the current native `turn_recovery` observation,
not historical failure Items. Sampling success, terminal completion, disconnect
and interruption clear the live observation. Cold journal snapshots do not
claim that old retries are running. There is no invented countdown or additional
durable recovery state machine.

## Design rationale

Button wording describes the actual action, following the
[GOV.UK button guidance](https://design-system.service.gov.uk/components/button/).
Timely feedback follows the
[visibility-of-system-status principle](https://www.nngroup.com/articles/visibility-system-status/),
and error details use progressive disclosure alongside an actionable recovery
path, informed by [error-message guidance](https://www.nngroup.com/articles/error-message-guidelines/).
The bottom placement and single-row default are explicit product requirements,
not a claim that those sources prescribe an exact visual layout.

## Visual acceptance fixture

`apps/zenx/test/fixtures/retry-ui-visual.tsx` renders the production ThreadView
with synthetic native-projected events and a visibly separate QA control strip.
It supports `theme=light|dark`, `phase=running|recovering|continuing|completed|failed|stopped`,
`lang=zh-CN|en`, `draft=...`, `disabled=1` and `long=1`. Relative timestamps are
fixed at mount. The manual request uses the production request helper with an
explicitly synthetic transport and acknowledgement control. This is component
browser acceptance, not Electron or real-server end-to-end validation. Capture
light/dark outcomes, long-history bottom recovery, stopped state, details,
manual request/loading, draft preservation and narrow viewport before merging.
