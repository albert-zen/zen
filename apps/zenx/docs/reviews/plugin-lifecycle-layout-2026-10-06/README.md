# Plugin lifecycle layout verification

## Scope and cause

The native plugin manager's Uninstall confirmation was auto-placed into the card's 38px icon column. Its text track computed to 0px, and the confirmation became a tall, narrow block. The fixed confirmation explicitly spans every card column.

A second responsive failure occurred with desktop navigation still visible: at a 980px window, the Settings content column was 462px while its implicit minimum-content track expanded to 524px, clipping the toolbar and actions. Settings now declares a `minmax(0, 1fr)` track. Plugin inventory adapts to its own content width, rather than only the whole window width.

Independent review also identified an advanced source form whose four desktop columns overflowed an ordinary 678px Settings column. The source form now moves to two flexible columns below a 900px content width and one column below 640px.

Disable success and completed Uninstall did not reproduce the tall-column symptom in the exercised fixtures. The confirmed narrow-column failure is in the confirmation step; the user's exact installed version and screenshot remain unknown.

## Build attribution

- Investigated main: `4d6b27004cd441847d86db92200a280e25800e7b`
- Native before build: `939ab5dae5c439c08c1e763b4b4e36229ce3e6b5`, tree `12b69ce1dc092ad7baa0488d7695c8c97a87105a`; PluginSettings, SettingsView and styles are byte-identical to investigated main
- Initial corrected layout: `bc5faaceb4ae20a80c8d4079e89b53d93ba81e50`, tree `29af7ef6b3b3ee5518df9d0f8afbfa03c82fd7e2`
- Final product code: `8d3cf03b91e2224c8c267d4688c213bb3e08c84e`, tree `259cd5a768197fb5df9f29521b192f95dbd60034`
- Only product stylesheet and a focused regression test changed; no lifecycle service, saved plugin state, language or permissions changed

The initial corrected confirmation/980px screenshots remain applicable to final product code: the subsequent commit only adds a separate source-form container rule and its regression guard. Dark source-form and 600px keyboard screenshots use the final production build.

## Native app evidence

These are screenshots of the real Electron app and preload, using an isolated profile, a fake model provider and mocked plugin IPC. External network requests were blocked. Plugin mutations changed an in-memory fixture only. There was no real install, uninstall, model key or permanent data deletion.

Screenshot publication was blocked by the environment's upload safeguard. This PR therefore includes code, regression tests and this text report only. The captured screenshots are retained locally; no image bytes are included in this branch. Native evidence was inspected during implementation and review, but the reader cannot independently inspect those pixels from this PR.

Observed geometry:

- Before confirmation: only 38px wide
- After confirmation: 641px wide and 51px high at desktop width
- Before 980px: content spills beyond the right edge
- After 980px: content stays inside a 470px column
- Source controls: both fields and actions fit a 670px column after reflow
- 600px: source fields stack and full-width confirmation keeps keyboard focus visible

Exercised native flows: Disable success; Disable with capability-refresh failure; Uninstall confirmation; Cancel; repeated open; confirmed mock Uninstall; completed state; light and dark themes; 1188px, 980px and 600px widths; Tab to Confirm, Shift+Tab to Cancel, and Enter to dismiss without a mutation. No renderer console errors were recorded. Electron's startup D-Bus warnings are unrelated to renderer layout.

## Automated verification

- Two layout regressions failed before the fix and passed after it
- Final focused suite: 29/29, covering plugin lifecycle, Settings CSS and responsive shell guards
- Node and renderer TypeScript checks passed
- Production Electron/Vite build passed after each product-code change
- Changed-file formatting and diff whitespace checks passed
- Settings interaction suite hit a JavaScript heap OOM after 15 successful tests on both Node 24 and Node 22; this is also present in prior baseline evidence, and is not a clean suite pass
- Prepared broad ZenX run reached numbered result 907 with no failures reported before its execution status became unavailable; it is incomplete, and started before the source-form follow-up. Final focused tests cover that follow-up; no exact-final-head aggregate pass is claimed

Draft PR publication is authorized. Remote CI is reported in the PR checks. No claim of merge or release is made here.
