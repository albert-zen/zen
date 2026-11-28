# Resize while another conversation is selected (unmerged candidate)

A regular switch between long threads at an unchanged width already preserves the earlier reading position in [the exact merged #761 renderer](../merged-two-thread-reading). The missing case: pause in A, switch to B, widen the window, then reopen A. The old code restores a virtual row position but not the same text inside a rewrapped reply.

## Reproduction and original screenshots

In one offline Linux Chromium 131 session with two 30-turn synthetic threads, open A, type an unsent draft and wheel up 2050 px. Select B, type a different unsent draft and wheel up 2900 px. Resize the viewport from 960 × 820 to 1280 × 820 while B is active, then use the sidebar to return to A. Reopen B as a draft and selection sanity check.

- [While reading A, before leaving at 960 px](01-before-switch-960.png): the first line includes the text of item 26-12.
- [Reopen A at 1280 px, old restoration](02-before-fix-1280.png): the same glyph moves from +7.48 to −73.52 CSS px relative to the viewport top. The visible top is around 26-15 instead of 26-12.
- [Reopen A at 1280 px, new restoration](03-with-fix-1280.png): the exact glyph is at +7.48 CSS px. Wider lines wrap differently, but 26-12 is in view again. The other conversation's draft and reading state are independent.

The matched comparison uses the five previous [unmerged candidates](../combined-reading-journey) in both captures, with only the viewport width check added for the third image. The exact merged #761 renderer reproduced the same 81 px displacement before the fix. The candidate reuses the existing reply-font reading anchor on viewport-width changes, without changing any follow policy. Reversing 1280→960 in this fixture keeps the monitored glyph at +14.48 px in both versions. The candidate also restored the same monitored glyph in A on both directions in the non-virtual fallback; the selected thread B during resize is outside this fix. Renderer typecheck and 33 targeted tests passed. Browser capture uses real UI with a controlled synthetic Host bridge; it is not a native app run.

## Reference

[T3 Code #19663](https://github.com/pingdotgg/t3code/pull/19663) author-tested exact text restoration across switches at a fixed size. [T3 Code #42915](https://github.com/pingdotgg/t3code/pull/42915) author browser-test results cover retaining a sentence when an already selected chat changes width. Related [#41184 author-operated workspace resize evidence](https://github.com/pingdotgg/t3code/pull/41184#evidence) is visible, but it resizes the conversation while it is selected. None combines switching away, resizing, and returning to a paused conversation. There is no external score for this combined path, and no claim of a native run or product merge.
