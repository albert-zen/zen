# Find a term in a long code block, close Find, then Copy

Same synthetic 30-turn thread and 86-line completed Markdown fence. Row 48 in reply 26 has a long line ending in the unique term `verify-tail-26`. Linux Chromium 131.0.6778.0 at DPR 1; actual production UI built offline from exact #761 (`9e65c3493b668e25d34c3942974716b7360b2e7e`) versus nine local candidates together, including the prior Find selection and sticky code action changes. No Electron, native clipboard, provider or network. Original unedited captures:

| Viewport | Merged #761 after Escape | Local stack while Find is open | Local stack after Escape and Copy |
|---|---|---|---|
| Dark 960 × 820 | [PNG](zen-dark-merged-after-escape.png) | [PNG](zen-dark-candidate-find.png) | [PNG](zen-dark-candidate-copied.png) |
| Light 1280 × 800 | [PNG](zen-light-merged-after-escape.png) | [PNG](zen-light-candidate-find.png) | [PNG](zen-light-candidate-copied.png) |

1. Open synthetic Thread one at its latest reply. Enter an unsent `Keep this command draft while searching.` and press Ctrl+F. Type `verify-tail-26`. Both builds land on and highlight the only match. The code, not the window, scrolls horizontally: 1,335px in light and 1,487px in dark. Other short lines in the block are then off to the left.
2. Press Escape. Both restore composer focus and retain the exact vertical offset, horizontal offset, term position and draft. In the merged build the Copy/Wrap strip is over 800px above the viewport. In the local stack the same strip is at the top of the viewport again, does not cover the term, and does not create another vertical scroller.
3. Click Copy in the local stack: the stub receives all 86 exact lines and the transcript does not move. Tab + Space toggles Wrap in both directions. Wrapping reflows the long line, so this is **not** a claim that Wrap itself preserves the term's screen coordinates.

Reference for the Find step: the [VS Code chat test plan](https://github.com/microsoft/vscode/issues/330953) explicitly checks searching and highlighting a term deep inside a code block. We read the published plan; it does not supply a screenshot for this term, validate this Copy step, or establish visual parity. For Copy, see the [two locally exercised Streamdown releases and original pictures](https://github.com/albert-zen/zen/tree/d1eb7b45150821b42c608d76af20fee65973f52f/apps/zenx/docs/reviews/long-code-block-copy). There is no matched external end-to-end capture or independent score. This archive contains evidence only, not product code.
