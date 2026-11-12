# Issue #336: unread numeral centering candidate

The production change is limited to the existing unread badge's text layout: an inner span trims the font's cap-to-baseline box before the existing grid centers it. The badge retains its 18 px shape, minimum width, padding, count formatting and accessibility label. Unread state and behavior from #325 are unchanged.

## Checked

- Related Room conversation and sidebar style tests: **34/34 passed**.
- Independent code review R1 passed, with its own 34-test run and 40-case static rendering matrix. Static markup is not pixel evidence.
- Production-component fixture bundles successfully. No rendered visual acceptance is claimed yet.
- Browsers without `text-box-trim`/`text-box-edge` support keep a conventional centered line box; improved optical centering is not guaranteed in that fallback.

## Pending visual acceptance

Use `apps/zenx/test/fixtures/unread-centering-visual.html`. It renders real PAW/Room navigation with synthetic unread counts 3, 12 and 105 (displayed as 99+). Query options: `before=1`, `theme=dark`, `lang=en|zh`, `zoom=1|1.25|1.5|2`.

The fixture reports CSS feature support, requested font stack, CSS zoom and devicePixelRatio in `window.fixtureEvidence`. CSS zoom is not native DPI scaling; the reported font-family is not proof of the actual glyph font. The caption deliberately says NOT INSPECTED unless the capture worker can identify actual fonts using its available, permitted inspection tools and calls `window.recordRenderedFonts(numeralFontNames, labelFontNames)` with observed names. Font identification is optional: retain NOT INSPECTED and disclose the limitation when unavailable. Do not bypass disabled developer tools or organization policies for font inspection.

Before/after captures must use the same browser environment, font settings, native device scale and CSS zoom. Inspect the actual displayed numerals within the unchanged badge, in light/dark and English/Chinese, and record CSS feature support. Identify the rendered font only if permitted inspection tools provide it; otherwise state that it remains unknown. A Linux fallback-font capture cannot establish Windows Segoe UI or macOS system-font behavior. Screenshot capture remains pending; no screenshot or visual pass is included in this candidate.
