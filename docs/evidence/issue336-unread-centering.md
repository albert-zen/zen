# Issue #336: unread numeral centering candidate

The production change is limited to the existing unread badge's text layout: an inner span trims the font's cap-to-baseline box before the existing grid centers it. The badge retains its 18 px shape, minimum width, padding, count formatting and accessibility label. Unread state and behavior from #325 are unchanged.

## Checked

- Related Room conversation and sidebar style tests: **34/34 passed**.
- Independent code review R1 passed, with its own 34-test run and 40-case static rendering matrix. Static markup is not pixel evidence.
- Production-component fixture bundles successfully. No rendered visual acceptance is claimed yet.
- Browsers without `text-box-trim`/`text-box-edge` support keep a conventional centered line box; improved optical centering is not guaranteed in that fallback.

## Pending visual acceptance

Use `apps/zenx/test/fixtures/unread-centering-visual.html`. It renders real PAW/Room navigation with synthetic unread counts 3, 12 and 105 (displayed as 99+). Query options: `before=1`, `theme=dark`, `lang=en|zh`, `zoom=1|1.25|1.5|2`.

The fixture reports CSS feature support, requested font stack, CSS zoom and devicePixelRatio in `window.fixtureEvidence`. CSS zoom is not native DPI scaling; the reported font-family is not proof of the actual glyph font. The caption deliberately says NOT INSPECTED until the capture worker reads the actual fonts for `.room-unread-value` and conversation labels (for example using Chromium's `CSS.getPlatformFontsForNode`) and calls `window.recordRenderedFonts(numeralFontNames, labelFontNames)` with those observed names.

Before/after captures must use the same browser, actual font, native device scale and CSS zoom. Inspect glyph bounds within the unchanged badge, in light/dark and English/Chinese. A Linux fallback-font capture cannot establish Windows Segoe UI or macOS system-font behavior. Screenshot capture remains pending; no screenshot or visual pass is included in this candidate.
