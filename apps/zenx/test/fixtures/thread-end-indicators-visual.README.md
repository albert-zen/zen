# Thread ending indicators (#402)

This fixture mounts the production `Sidebar` with explicit synthetic summaries and
loads production `theme.css` and `styles.css`. It has no Host connection and no
user content. The running/retrying rows intentionally include a stale failed end
to verify that active execution hides it.

Open `thread-end-indicators-visual.html` with the existing fixture/Vite workflow.
Query parameters: `appearance=light|dark`, `accent=azure|iris|jade|red-token`.
`red-token` is only a test override of `--color-accent`, not a product theme option.
The links change theme parameters. Selecting a row must not clear its marker;
“Mark selected ending viewed” demonstrates the resulting read projection.

Acceptance:

- Normal completion and cancellation: 10px current accent dot.
- Failed completion: 10px danger-red outlined exclamation, no ordinary dot.
- Running/retrying: existing activity indicator, no end marker.
- Viewed failure: no end marker.
- Same status slot geometry in light/dark and all accent variants.

This is visual evidence only. `thread-end-unread.test.ts` separately exercises the
real runtime, canonical terminal summary, production `ThreadView` visibility/read
store, and production `Sidebar`, including restoration after recovery.
`thread-summary.test.ts` verifies terminal outcomes, automatic recovery attempts,
restart rebuilds and older summary validation. Existing notification tests cover
live/reconnected epoch fencing and replay suppression.
