# Mixed Chinese/English long reply: reading across 961 → 960 → 961

Production ZenX App and virtualized ThreadView in Linux Chromium 131.0.6778.0, dark theme, 820 CSS px high, DPR 1, English UI with the same synthetic bilingual Markdown in each build. No Host, provider, user data, native OS scaling, or real run logs. The only fixture input change is the synthetic reply. The prepared LegendList 3.3.5 Web module is the repo-patched blob 393cfdd0b1cd53a05c19a35159c9dec28c6deab5. One upward mouse wheel at 961 px before taking the first frame; no additional scroll between size changes. Record settled DOM Range relative to transcript viewport top (88 px in each frame).

| Source | Body, 961 → 960 → 961 | Marked line relative to transcript top | Distance from scroll end | Earlier state |
| --- | --- | --- | --- | --- |
| 974db08 (before typography change) | 15/27 → 14/23.52 → 15/27 px | +58.0 → +70.5 → +247.0 px | 163 → 0 → 304 px | on → off → off |
| e97be87 (typography change only) | 15/27 → 15/27 → 15/27 px | +58.0 → −6.7 → +67.0 px | 163 → 0 → 124 px | on → off → off |
| 3163e53 (same product source/package as merge candidate #761 at 97dbc73) | 15/27 → 15/27 → 15/27 px | +58.0 → −6.7 → +67.0 px | 163 → 0 → 124 px | on → off → off |

Typography is stable, but the first line of the target sentence in the new case is partially clipped at 960 px; resizing back restores visibility, not the reading-earlier UI state. The old build also reached the scroll end and lost that state, but it reflowed differently. In the current build, 962 → 961 → 962 stayed at +58 px throughout; starting farther from the tail at 961 → 960 → 961 retained earlier state but the anchor moved +173 → +99 → +173 px. Do not infer loss of earlier state on every resize. Browser font inspection of the mixed paragraph reported Liberation Sans and Noto Sans CJK JP; this does not measure perceived size on Windows or macOS.

[Adjacent upstream reference: T3 Code #41184](https://github.com/pingdotgg/t3code/pull/41184) has author-provided Linux Chromium screenshots of the text anchor moving when a side panel changes transcript width. The author retained the top text by keeping a DOM text anchor. That is a different resize path and these are not matched score pairs or a local T3 run.

Original files below are direct browser PNGs. No new product change in this archive.
