# Reading earlier replies while output arrives

Already-merged #761 renderer, exact source `9e65c3493b668e25d34c3942974716b7360b2e7e`. No product changes in this archive. Cloud Linux Chromium 131.0.6778.0 at DPR 1, production renderer, no external network/real account/Host. A synthetic bridge accepts the ordinary Enter send from the composer for one local prompt, then sends a canonical user item, Turn start, assistant-item start, multiple text deltas, and final item plus Turn completion events through the actual renderer's protocol subscriber. An independent ambient-turn control omits the user send and exercises the same deltas; its outcomes also matched the eight local candidates. Not a native macOS/Windows run or a real model stream.

All PNGs below are originals from the Enter-send path, using a 30-turn synthetic chat with a second unsent draft entered during the reply. Test a fresh chat per path. State is measured by the exact first visible glyph on the chosen message, not by distance from the bottom (which should grow when more text is appended).

| Task | Original PNGs | Result |
| --- | --- | --- |
| Read earlier text while the reply grows, then finishes | [While growing, light](01-light-paused-while-growing.png) · [Finished, still paused](02-light-still-paused-at-finish.png) | 1,198px off the edge after scroll; rose to 2,910px away at completion, but reply 29's glyph stayed at exactly the same Y position (158.69px in the light viewport, 97.69px dark). The isolated arrow remained. |
| Scroll down manually to rejoin a still-running reply | [Paused near the end, light](03-light-near-bottom-paused.png) · [After returning and receiving more output](04-light-manual-return-still-follows.png) | A 42px upward wheel moved away; after layout settled, distance was 90px. Two deltas did not move the anchored glyph. Downward wheel returned to the actual end (0px), the arrow disappeared, and another delta and completion both stayed at 0px with the final line visible above the composer. |
| Scroll with Page Up, then use the independent arrow by keyboard | [Paused by Page Up, dark](05-dark-paused-by-page-up.png) · [After activating the arrow and receiving more output](06-dark-enter-arrow-still-follows.png) | At 960 × 820 the original glyph stayed at 4.48px from the viewport top through both deltas. Enter on the arrow removed it and focused the transcript, not the composer; more output stayed at the end. Mouse clicking it separately also worked at 1280 × 800. |

Both themes passed for all tested routes. Unsaved draft stayed intact, and nothing was submitted beyond the one deliberate Enter into the in-memory bridge. The output stage and completion were tested, not fast screen-reader or physical trackpad gestures.

## Comparable behavior, not comparable pixels

- [T3 Code #5566](https://github.com/pingdotgg/t3code/pull/5566), author-tested Chrome with a 17-second model turn: earlier text stayed put through completion and the explicit return control restored following. No matching image supplied in that PR, and this ZenX run did not launch T3.
- [T3 Code #6519](https://github.com/pingdotgg/t3code/pull/6519) documents why manual wheel-to-bottom differs from clicking the return control in a just-sent turn. The author's PR explicitly has no visual record for that route. Both routes were independently exercised here; T3's internal anchoring mechanism is not assumed to be ZenX's.
- [T3 Code #17056](https://github.com/pingdotgg/t3code/issues/17056) is a public real browser recording of adjacent layout-change behavior including an iframe and its controls; it is not a new text-delta comparison.

No changes or score: the matched app-shell/reference captures are missing, and the baseline already passes the scoped interaction.
