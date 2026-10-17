# Retry UI: single-line + pill candidate

These are synthetic production-component screenshots for review, not a claim of full native end-to-end acceptance.

## Exact identity

- Screenshot source: `83751a64c1242a130c1917d7a8fa5f002a600781`
- Published PR #446 head: `b3113792f0cfb0b03a55e26a17aad10654ca25c2`, exactly the same tree as the screenshot source.
- Source tree: `a715ad37922e4cca62e0a42e27ecb759fb12495b`
- Prior browser behavior matrix source: `3403c73411aa0938cb00aad5a262548e81700710`, tree `33c77eaa58186629d240aa85a8f782a8574b6dd4`.
- The delta between those commits changes only `styles.css` and `docs/retry-ui.md`. The bundled JavaScript SHA-256 is identical: `5abc341d9919ed7c8a38811f42a26298485b5869ec70091c691034d6c7c389b4`. Screenshots are freshly captured on the latest source; older screenshots are not relabeled.
- Latest CSS SHA-256: `967b2b2d10ae14c7d9a1c4a146c0b66b277c113d5c1cafee7d256857cf1d0a37`.

## What was checked

- Production ThreadView, production styles, production manual-retry requester, synthetic native projection and transport. Dashed controls at the top belong to the test fixture, not the product.
- Default terminal status, retry count, and error-details affordance share one line; Retry has a pill shape. Explicitly expanded technical details appear below. At 390 CSS px, default row and expanded details fit with document width equal to scroll width (390).
- Active recovery follows the last history item. A long 18-item conversation shows recovery at the latest-content end above the composer.
- The actual Retry action starts one request. Pending spinner/disabled state prevents two further pointer clicks from adding requests. Ordinary composer send count remains zero and the existing draft is retained.
- Synthetic rejected receipt displays an error and restores Retry. Another explicit Retry can succeed; acknowledged receipt clears terminal status and continues the synthetic scenario. This tests the UI/requester contract, not real Host/provider transport.
- Fresh confirmed-stopped scenario can retry. Disabled composer also disables Retry. Real keyboard entry focuses the textarea and preserves/extends its draft. At 390 px, actual Tab then Enter activates Retry.
- Native `disabled` removes Retry focus to the document; button-focus preservation is not claimed. Retry is a request action, not a shortcut to focus the composer.
- Shown elapsed seconds are synthetic Turn duration, not a retry wait countdown. The sample message about saving once is not evidence of backend side-effect deduplication.

## Coverage limits

No full App/Electron/real Host/provider E2E, native touch/coarse-pointer device, OS-specific rendering, screen-reader session, or attachment preservation is established by these images. Backend tests and CI must be assessed separately. The previous heavy-card iteration was rejected and remains historical only.
