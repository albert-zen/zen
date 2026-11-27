# CJK punctuation, emphasis, and Find

Production ThreadView and virtual transcript, Linux Chromium 131.0.6778.0, 1280 × 820 CSS px, light, zh-CN, DPR 1. Offline synthetic reply, no actual conversations or Host. Same fixture digest c6cb0915122df273482fd528078881f55ca7919d18adc95ca8245a13d553ba8e in all three builds.

- 336c76b: Chinese punctuation next to emphasis delimiters exposed literal asterisks in ordinary prose.
- b1a2c84: the prose rendered bold and italic correctly, but searching visible text `确认”以后` returned no hits. Searching the hidden Markdown delimiters returned 1 / 1 without a drawable highlight.
- 3163e53 (production renderer/dependencies identical to #761 @ 97dbc73): Ctrl+F found the visible phrase (1 / 1). The two contiguous highlight rects exactly span the STRONG-to-P boundary. Hidden delimiter search correctly returned no hits. Escaped literal stars and inline code each still returned a visible hit. Search kept keyboard focus.

[Cherry Studio #4119](https://github.com/CherryHQ/cherry-studio/pull/4119) has author before/after screenshots for the same CJK emphasis parsing problem (different text, no transcript Find claim). Not a local run, not a matched scoring pair. PNGs are original Chromium screenshots.
