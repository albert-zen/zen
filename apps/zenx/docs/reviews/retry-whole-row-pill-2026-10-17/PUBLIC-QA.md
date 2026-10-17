# Retry UI: whole-row capsule candidate

These are synthetic production-component screenshots for review, not a claim of full native end-to-end acceptance.

## Exact identity

- Screenshot source: `d8e83c8806a84ec88ea32eed333e427a54c42b26`
- PR #446 remote head: `35e8f1d28b0ae0c6342f12ee8d7239e992657bce`, exact same tree as the screenshot source.
- Source tree: `631d2732bffaa446dba04589f96f3b79e0c15c49`
- Prior browser behavior matrix source: `3403c73411aa0938cb00aad5a262548e81700710`, tree `33c77eaa58186629d240aa85a8f782a8574b6dd4`.
- The changes since the behavior matrix are CSS, two localized retry-count strings, matching component-test assertions and documentation. Production ThreadView, requester, fixture and backend behavior modules are unchanged; bundled JavaScript is not claimed identical because localization changed.
- Final bundle JS SHA-256: `aab3853b99163f35a874a796cefe42e2b77bd08a84dab4c7cc5bf94ea44aadfb`.
- Final CSS SHA-256: `6ab122bcaedeb2106e0c8d57dad62353ed630dcf2c6656fb602cec7eee7d5655`.

## What was checked

- Production ThreadView, production styles, production manual-retry requester, synthetic native projection and transport. Dashed controls at the top belong to the test fixture, not the product.
- The entire default status row sits in a thin-bordered capsule. Status, retry count, and error-details affordance share one line with a separate smaller pill-shaped Retry button. Explicitly expanded technical details appear below. At 390 CSS px, default row and expanded details fit with document width equal to scroll width (390).
- Active recovery follows the last history item. A long 18-item conversation shows recovery at the latest-content end above the composer.
- The latest candidate was also rechecked through pending, rejected and acknowledged receipts with draft retained. The actual Retry action starts one request. Pending spinner/disabled state prevents two further pointer clicks from adding requests. Ordinary composer send count remains zero and the existing draft is retained.
- Synthetic rejected receipt displays an error and restores Retry. Another explicit Retry can succeed; acknowledged receipt clears terminal status and continues the synthetic scenario. This tests the UI/requester contract, not real Host/provider transport.
- Fresh confirmed-stopped scenario can retry. Disabled composer also disables Retry. Real keyboard entry focuses the textarea and preserves/extends its draft. At 390 px, actual Tab then Enter activates Retry.
- Native `disabled` removes Retry focus to the document; button-focus preservation is not claimed. Retry is a request action, not a shortcut to focus the composer.
- Shown elapsed seconds are synthetic Turn duration, not a retry wait countdown. The sample message about saving once is not evidence of backend side-effect deduplication.

## Coverage limits

No full App/Electron/real Host/provider E2E, native touch/coarse-pointer device, OS-specific rendering, screen-reader session, or attachment preservation is established by these images. Backend tests and CI must be assessed separately. Earlier heavy-card and standalone-button iterations remain historical only. All images in this set are freshly captured from the current whole-row capsule source.
