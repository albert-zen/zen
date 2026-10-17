# Compaction workflow-status screenshot evidence

## Version and scope
- Capture source: `73a106f201799c0f4ce49cf8608bae2c6d6265eb`, tree `c7a0e93d0daa0ae6c6271ebbb6812a8aaaeaf861`.
- PR #448 published head: `4cb8cc99e79be93f49d479e2b54eae08d1194497`, tree `37305c4f584a21b50140b650d23e2478d6e6b43f`, equal to local `fc99bee3`. The only change since capture source is a test assertion diagnostic adjustment in `thread-view-component.test.ts`; production and fixture files are unchanged.
- Cloud Chrome screenshots of real production ThreadView and CSS with synthetic messages. Three independent scenes compare success/Working, pending/Retrying, and compaction-error/terminal-error. This is not native Electron, full App, Host/provider or successful original-history E2E evidence.
- The elapsed number beside Working is Turn elapsed time, not a retry countdown. Scene wrappers are 520px high; expanded panels scroll within the scene. Partial composer/content visibility in interaction screenshots reflects that bounded viewport and scroll position.

## Verified
- 8 combinations: desktop and 390 CSS-pixel iframe; light/dark; English/Chinese. All six collapsed status rows in each combination measure 38px high. No document horizontal overflow. See computed-summary.json.
- Main activity/compaction text and icon boxes are vertically centered within the row. Retry count badge rounding is under 0.008px. Measurements describe CSS boxes, not font-ink optical centers or native touch geometry. The different scenes do not assert equal absolute page Y positions.
- Collapsed success shows title/source and keeps View original history available. Enter expands and collapses the real control, preserves keyboard focus, and rotates the chevron 180 degrees. Full summary statistics remain in expanded content.
- Copy summary produces the visible Summary copied feedback. Operating-system clipboard contents were not independently verified.
- View original history opens the real reader, reports the explicitly synthetic unavailable bridge, and offers keyboard-operable Retry with disabled pagination. A second request remains correctly unavailable. No Host request is made by this fixture.
- Long unbroken technical error expands below a separate 38px header. Header icon and text center coincide. The diagnostic is keyboard-focusable, wraps without horizontal overflow and is bounded to 240px at this viewport. End scrolls to 282px, equal to scrollHeight520 minus clientHeight238.
- Dismiss compaction error removes that error only; the separate terminal Turn error remains.

## Baseline and limitations
The previous compaction layout used a 44px minimum success row and 48px pending layout with larger icon/two-line presentation. That baseline is a source-style comparison, not a browser before image. Early candidate preview captures are not relabeled as baseline or current evidence.

No real mobile/touch, native OS font rendering, screen reader, clipboard contents, real Host history retrieval, or backend compaction execution is claimed here. Retry action in the terminal comparison scene is intentionally unavailable because the fixture supplies no retry transport; the separate PR #446 evidence covers that interaction.

## Screenshot index
01–04 desktop language/theme matrix; 05–08 390px matrix; 09 long-error header/focus; 10 keyboard-scroll at diagnostic end; 11 expanded summary keyboard focus; 12 Copy feedback; 13 original-history unavailable/retry; 14 error dismissed with terminal error preserved.
