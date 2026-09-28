# Context compaction error UI — isolated fixture

Both images are **synthetic failure** captures of the production `ThreadView`
React component and `requestContextCompaction` executor in Electron 43.2.0,
macOS, dark theme, 1280×820 CSS viewport (PNG backing scale 2). The fixture
throws an artificial `Error invoking remote method` exception and contains
only synthetic Thread text. No real Host, user conversation, daily app or
compaction operation was used. It does **not** reproduce the user's original
unidentified failure or establish its root cause.

- [Collapsed error card](synthetic-compaction-error-dark-1280x820.png): notice above Composer, not below textarea nor inside the closed context popover.
- [Expanded details](synthetic-compaction-error-dark-1280x820-details.png): native `<details>` summary focused and expanded in hidden Electron window; original exception text withheld. Focus was set programmatically for capture, not an active-window Tab-navigation acceptance test.

Screenshot driver and DOM capture assertions are in this work line's local
`compaction-error-ui/capture-electron.cjs`, `run-capture.mjs`, and
`capture-final.log` artifacts. Fixture source is in
`apps/zenx/test/fixtures/compaction-error-visual.{html,tsx}`. The screenshot
captures component paint, not a packaged/signed daily-app test.
