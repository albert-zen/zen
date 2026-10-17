# Retry presentation

ZenX shows a lightweight **Recovering task** status and the actual attempt while
an automatic recovery sample is active. It uses the current native
`turn_recovery` observation, not old failure Items. Successful sampling, terminal
completion, disconnect and interruption clear the observation. A cold journal
snapshot does not claim that a historical recovery is still running. There is
no invented countdown or extra durable recovery state.

A terminal failure is one compact, localized outcome card. Technical error
text and diagnostic identifiers remain available under **Details**, collapsed
by default. Already received output stays available in the activity history.
An explicit user stop remains distinct from failure; unconfirmed background
operations keep the existing receipt-review action and warning.

**Add instructions** scrolls to and focuses the existing composer. It preserves
text, selection and images and never submits a message or replays an operation.
The action is disabled when the composer is unavailable. There is deliberately
no button that pretends focusing the composer resumes execution. Existing
recovery budgets, cancellation, approval and unknown-mutation fences are
unchanged.

## Visual acceptance fixture

`apps/zenx/test/fixtures/retry-ui-visual.tsx` renders the production ThreadView
with synthetic native-projected events and a visibly separate QA control strip.
It supports `theme=light|dark`, `phase=running|recovering|continuing|completed|failed|stopped`,
`lang=zh-CN|en`, `draft=...` and `disabled=1` URL parameters. Relative timestamps
are fixed at mount. It is component-browser acceptance, not Electron end-to-end
validation. Capture light/dark terminal cards, active recovery, stopped state,
details, focus and disabled boundaries, plus a narrow viewport before merging.
