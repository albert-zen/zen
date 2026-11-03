# Information feedback final native evidence

Product head: `07a409e45a9dc39163d4832a768d24cf6f3c6b06`.
Tested PR merge: `0bfe488e3118cc7c7f17bc599379a749953f6786`.
Both have tree `4cc0dc0dbcc5cdcee0d57ea803a7d1bca5d84102`; main #678 is included.

[Native workflow](https://github.com/albert-zen/zen/actions/runs/41695117400) passed 26 full-App cases and 81 native input steps on both macOS 14 and Windows. The actual production Electron App, preload, Host and journals ran with disposable synthetic data and a private fake provider. No user profile, private Trace, credentials or user device data is included. Each source.json records the CI source commit and build/source hashes; 34 checked-in files were verified independently for each platform, including expected Git CRLF checkout on Windows.

## Screenshot mapping

- 17a: #651/#652, original Chinese reference question wording, selected full-row options, 44px free-text input without a resize handle, and 子对话 heading.
- 18a: #648/#649/#650, authoritative trigger switches, no constant trigger refresh button, no ended command row. The disabled background-command refresh belongs to a different widget.
- 01e: #647, actual new foreground question reveals the panel while the Composer draft and native focus stay intact.
- 01f: #651, actual native Space selection with checked checkbox and visible full-row keyboard focus. This replaces the ambiguous macOS image from the earlier 174c61ab artifact. Capture now waits for paint; it does not change DOM state or focus for screenshots.
- 12a: #651, the same full-row controls and non-resizable free-text fields in two real Room-owned questions.

17a and 18a are native Electron capturePage crops of the information surface; other images are full App captures. None is redrawn or image-edited. Pointer and keyboard use native Electron input. The existing select fixture uses production DOM input/change because macOS native select popup input is outside this harness; language preference uses the production same-origin storage-event receiver. These limits are not claimed as native OS-menu acceptance.

## Original reference and visual reconciliation

[Original image](https://raw.githubusercontent.com/albert-zen/zen/4dbabe0f52a521ed6d2787dc8ed8196043daa6c7/docs/images/information-panel/information-panel.png) is shared by #658/#659/#661/#662; #660/#663 have no separate image. The option grid, 6px row gap, 14px bottom spacing, 10px rounded option borders, hover border, selected accent surface/mark and existing switches are reused. Actual native input semantics and focus outlines remain. Shared theme tokens, platform font metrics and the integrated #634 dock/popover shell account for small color/width differences. Exact owner/revision guards and failure/busy reconciliation are retained.

Independent visual review accepted the reused component styling. The earlier macOS checkbox screenshot limitation is explicitly resolved by the replacement 01f images here. All selected screenshots were visually inspected before publication.

This branch is evidence-only and must not be merged into the product branch.
