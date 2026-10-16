# Thread ending indicators: cloud UI evidence

Source: base commit `2a227f88445c9ec6ccc2dc97e2cf464f7125a948`, frozen staged tree `059b53d38cdc3021ee402c029edd1d9d78c057f0`. No commit was authored for capture. The author-provided bundle was copied unchanged to the shared evidence directory; `source-identity.json` records source and build SHA-256 hashes.

Production `Sidebar`, `theme.css`, and `styles.css` with explicitly synthetic summary props. Browser: cloud Chrome, viewport 1180×757 CSS px. No user computer, native Electron session, or live provider was used.

## Verified
- Six real selectable accent/appearance combinations: jade, iris, azure × light/dark. Normal unread completion and cancellation use the actual accent token; unread failure uses the danger token and outlined exclamation, replacing the normal dot.
- Both marker boxes measure exactly 10×10 CSS px in every captured combination. No horizontal document overflow.
- Running and retrying show the production running spinner, with no terminal dot or failure marker even though the synthetic prior ending is failed. Viewed failure has no marker.
- The fixture's red-token override is explicitly labeled "not a selectable theme". Normal dot and failure outlined exclamation remain shape-distinct when both colors are identical.
- Keyboard Enter selected the failed row; the failure marker remained. The separate visible fixture button, activated by Enter, simulated the read-tail prop update and removed only that failure marker. This does not claim a real read-tracking end-to-end test.
- Space on the production density control switched to Compact, kept visible keyboard focus, and retained 10×10 markers in 34px rows.
- All 11 screenshots were actually viewed. No clipped marker, lost failure glyph, or obscuring hover popover in the final set.

## Screenshots
1. `01-light-jade.jpg`
2. `02-dark-jade.jpg`
3. `03-dark-iris.jpg`
4. `04-light-iris.jpg`
5. `05-light-azure.jpg`
6. `06-dark-azure.jpg`
7. `07-dark-red-token-test.jpg`
8. `08-light-red-token-test.jpg`
9. `09-selected-failure-retains-marker.jpg`
10. `10-synthetic-viewed-clears-failure.jpg`
11. `11-dark-azure-compact-keyboard.jpg`

Runtime/read integration is covered by separate author tests, not by these synthetic props screenshots. Native Electron, OS-specific rendering, browser restart persistence, touch, forced-colors, and a narrow browser viewport were not inspected in this bounded marker scope.

