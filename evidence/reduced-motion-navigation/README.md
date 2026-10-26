# Synthetic native document-end evidence

These unedited PNGs contain only the owned, disposable macOS Electron fixture: fixed synthetic Chinese Markdown, generic file names, and no Host, private file, conversation, credentials or user identity. The candidate PNG was independently reviewed by the task owner before public publication; the user explicitly authorized reviewed synthetic evidence in albert-zen/zen.

- `baseline-reduce-256-end-failure.png`: PR #524 frozen diagnostic head 7b4326fa, native run 40325042008, artifact 12650927612. Original failed End state saved before the isolated after-failure probe, with gap observer enabled. Observer-off independently failed as well. The screen remains near paragraph 3, not document end.
- `candidate-reduce-256-end.png`: PR #536 head 237b8f17, test-merge cc58a37e, native run 40331446381, reduce artifact 12653364341. Exact original filename macos-cjk-256-wheel-production-csp-end.png. LAST_MARKDOWN_SECTION and caret are visible at document end. Git blob 665bcf3b29a67d45a356958a1d9795955505f9ac.

Both candidate media modes (reduce and no-preference) passed the unchanged native end-navigation suite: two cold cases plus four width/wheel cases per mode, Source and Markdown End, wheel, layout, strict nonce CSP and all 12 origin isolation negatives. All 32 source hashes and the driver match the candidate. This is Electron-owned input, not physical keyboard/trackpad acceptance. Other full-CI browser failures remain separately reported in PR #536; this evidence does not override them.

This evidence-only branch is not proposed for merge and does not modify the production candidate.
