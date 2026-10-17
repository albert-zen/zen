# Shared workflow status: context compaction

Tracks #447. This change is stacked on #446 candidate
`e70440b1da06c2c5ae42251678328f57b3918bd3`, not a claim that it has merged.

Compaction pending/error and committed-success summaries consume the same
`.workflow-status` foundation as running, recovery and terminal outcomes:
38px minimum surface, 20px line height, 28px compact controls, shared neutral
surface/border, and 44px coarse-pointer targets. A 14px icon slot matches the existing running/terminal status headers;
no per-language or per-state text translation is used. The collapsed success row shows the completed state and initiator; full summary
character counts and unknown-input explanation remain available in the expanded
summary. Unusually long labels can still wrap without clipping.
Narrow surfaces inherit the shared 20px corners and 6px inline padding;
expanded error details have their own full-width 12px-corner panel below the
status row, keeping the title, icon and dismiss action centered together.

The success capsule remains a native disclosure button. The original-history
entry stays available while the summary is collapsed. Expanded summary, copy,
retained-context diagnostics and the existing bounded original-history reader
remain outside the compact capsule. Pending retains role=status; error retains
role=alert, keyboard-reachable details and explicit dismissal. No change to
canonical projection, compaction commit rules, retention, original reads,
model tools, retry behavior or permissions.

The old compaction CSS used a separate 28px icon tile and 48px progress minimum;
its success minimum was initially 48px then overridden to 44px later in the
stylesheet. Both declarations are replaced. The existing double rotation on the
expanded chevron (`transform` plus later `rotate`) is reduced to one transform.

## Visual fixture and acceptance

Serve the repository root with Vite, then open:
`/apps/zenx/test/fixtures/compaction-status-visual.html?theme=light&lang=en`.
Supports `theme=light|dark`, `lang=en|zh-CN`. Three production ThreadViews show
success + working, pending + recovering, and error + failed on the same page.
The history reader intentionally returns a synthetic unavailable error; it never
contacts a Host. Existing original-history integration tests exercise real exact
boundary reads and pagination independently.

Required browser review: light/dark × English/Chinese at desktop and 390px,
layout-box and glyph visual centering, no horizontal overflow, keyboard summary
and error disclosure, summary copy, explicit dismiss, and original-history
visibility/error handling. Include all screenshots and computed measurements in
the PR with exact source identity. Synthetic Chromium coverage does not establish
packaged Electron or cross-platform font rendering.

Code-level validation is reported separately from visual and CI acceptance.
