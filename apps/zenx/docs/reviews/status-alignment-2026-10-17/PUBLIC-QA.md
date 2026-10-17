# Synthetic production status alignment evidence

Source: `e70440b1da06c2c5ae42251678328f57b3918bd3`, tree `2a3c7645e5cc0b27515e7afd9558e2a11ff5530f`. Published PR source `0e2063af508b593239cc9ad395fbe84228852f3a` has exactly the same tree.

Cloud Chrome renders the real production ThreadView. External matrix pages arrange four independent synthetic fixtures; their controls and message data are synthetic. This is component-level browser evidence, not full App, Electron, provider, or Host end-to-end verification.

## Captured and checked
- 01–04: Chinese/English × dark/light, with 583 CSS-pixel frames and 551-pixel status rows.
- 05–08: same four combinations, each iframe exactly390 CSS pixels and each status row358 pixels wide.
- All32 collapsed Working, retry recovery, failed, and stopped cases:38px high; same text/icon left inset within each viewport;20px text line-height. Main icon/text/button box centers coincide. Attempt badge differs by only0.0078125px due to fractional rounding.
- No horizontal document overflow, clipped labels, or narrow English retry wrapping in these cases. Narrow shared radius20px; wide999px.
- Different historical content gives different absolute row Y positions. Evidence establishes row height, inset, and within-row alignment, not identical absolute Y coordinates across scenarios.
- 09: Enter expands/collapses error details; disclosure remains focused. Expanded diagnostics use16px corners and wrap without horizontal overflow.
- 10–11: Enter on Retry creates one synthetic request, shows disabled/busy pending; an explicit synthetic acknowledgement changes it to the ordinary bottom Working capsule. Existing draft remains; ordinary send counter remains0. Native disabled button loses focus as previously documented.

## Limits
The displayed30s (or later elapsed value) is Turn elapsed time, not a retry countdown. Geometry uses CSS layout boxes, not optical glyph-ink measurement. Native touch, platform-specific Electron rendering, screen readers, actual font resolution, and real provider/Host retry transport were not verified by these screenshots. Backend tests are separate evidence. The synthetic save-once message is not proof of side-effect exactly-once execution.

The earlier d8e8 evidence was valid for retry/terminal capsules but left ordinary Working unbordered at the top. This set supersedes it for the unified status layout. Compaction is a separate follow-on scope and is not claimed covered here.
