# Paused transcript at the shell breakpoint

These original PNGs are unedited captures of the ZenX application renderer operated
in Chromium 131 on cloud Linux. They are not native Windows/macOS capture, generated
mockups, or screenshots of a real account. The bridge is synthetic and offline.
Graphite dark, zh-CN, DPR 1, viewport height 820 CSS px. The baseline is the product
from PR #761 at `5a6be36e477bfdbd879da894e56b94ac34491645`. The after images use
the two renderer stylesheets in this commit and identical synthetic inputs.

1. Open the synthetic thread with 17 completed bilingual sections. Fill the
   composer with an unsent synthetic draft.
2. At width 961, use a real wheel input to move up 160 px from the end.
   `before-wide.png` is the shared start (the after frame at 961 is byte-identical).
3. Resize to 960 with no input to the transcript. Compare `before-narrow.png`
   with `after-narrow.png`.
4. Resize back to 961. Check the same heading positions, available arrow, and draft
   in `after-widened.png`. Click the arrow or use the keyboard to return live.

| Path | Paused at 961 | At 960 | Back at 961 |
| --- | --- | --- | --- |
| Baseline: offset / distance from the end | 2920 / 208 | 2775 / 0 | 2775 / 353 |
| After: offset / distance from the end | 2920 / 208 | 2920 / 208 | 2920 / 208 |

The column loses 1 px at the threshold. The previous breakpoint also removed
305 px of rendered reply height and 48 px of paused return-overlay clearance.
The fixed build shares the reading metrics and the overlay clearance; the arrow
variants, accessible name and return interaction are unchanged. The measured
headings retain their positions on the original replay. The same cases with a
12 px or 400 px wheel and a same-side 962 → 961 → 962 control also pass. Separately
tested while streaming: appending text after the width round trip leaves the
paused offset unchanged; click and Shift+Tab then Enter restore following
without losing the draft. This does not claim unchanged line wraps for arbitrary
width changes.
