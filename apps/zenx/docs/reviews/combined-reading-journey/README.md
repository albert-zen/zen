# Combined reading journey (unmerged candidates)

This is an integration check, not a new product revision or whole-app rating. The product baseline is the [merged #761 tree at `9e65c349`](https://github.com/albert-zen/zen/commit/9e65c3493b668e25d34c3942974716b7360b2e7e). The capture ran that renderer with the workspace-reading, viewport-first Find, image actual-size, reply-size and Settings-return candidate patches applied in that order. Each includes links to its own isolated comparison below. No product code is included in this evidence directory.

Actual Linux Chromium 131 renderer, with a controlled bridge for a synthetic 22-turn conversation and an internally generated ordinary 1200 × 2200 PNG. Dark English 1440 × 900 and light Chinese 960 × 820, DPR 1. Sandboxed, offline, no native Electron shell, provider, real project or personal data. Network and page-exception counters were zero in both runs.

## Same session, without reloading

1. Open the synthetic thread, type but do not send a draft, then wheel up 1450 px from the latest reply. Ctrl+F for `covers the synthetic release checklist`. Initial selection is 329/396 and 343/396 respectively with identical scroll offsets before and after typing (6851 and 7660). Enter moves to the following hit; Shift+Enter returns to the match identity; Escape focuses the composer. The next/previous operation can intentionally scroll to reveal a match.
2. Settings → Appearance → Largest → Back to conversation. Only the reply body in this run changes from 15 to 21 CSS px. The same original reply and glyph are visible, with the glyph 9.39 CSS px lower in both layouts after reflow. The composer regains focus and retains the draft. Searching again starts from the current view without moving it.
3. Open the right workspace and press Escape to close it. Wide: the same measured glyph is at 171.875 px relative to the top of the view before, during and after panel display. Narrow: the workspace replaces the conversation while open; closing it returns the glyph to the same 211.875 px. Neither path discards the draft.
4. Use the paperclip to attach the synthetic image, open its thumbnail and choose Actual size. The image occupies 1200 × 2200 CSS px. End reaches the bottom inside the preview, not in the transcript (1396 px wide / 1476 px narrow preview scroll). Ctrl+F while the modal has focus does not open transcript search. Escape returns focus to the thumbnail and leaves the transcript scroll and draft intact in both widths.

## Original PNGs

| State | Wide / dark | Narrow / light |
| --- | --- | --- |
| After changing font and returning | [02](dark-1440-02-font-return.png) | — |
| Workspace opens | [03](dark-1440-03-workspace-open.png) | [03](light-960-03-workspace-open.png) |
| Workspace closes | [04](dark-1440-04-workspace-return.png) | [04](light-960-04-workspace-return.png) |
| Actual-size image reaches last row | — | [05](light-960-05-image-actual-end.png) |
| Preview closes, returning to draft and thumbnail | — | [06](light-960-06-image-return.png) |

## Isolated before/after controls and references

This combined sequence has no like-for-like external original, so no cross-product or whole-app score is reported. The prior independent workspace scores remain scoped to that isolated comparison. The evidence packs distinguish author-operated reference captures from our offline renderer and from source-only observations:

- [Wide workspace reading, T3 author-run comparison and independent ratings](https://github.com/albert-zen/zen/tree/5e3c70fcbb744a7d110511401e2cf689bc2a33de/apps/zenx/docs/reviews/workspace-reading-reference) and [narrow workspace controls](https://github.com/albert-zen/zen/tree/26ea1c59ed2e859f30818d59a04f636116edc6d7/apps/zenx/docs/reviews/narrow-workspace-return).
- [Viewport-first Find](https://github.com/albert-zen/zen/tree/c6ca7fc6992658237cb3145e2de5e947c2103c58/apps/zenx/docs/reviews/find-visible-first), including the limitations of the T3 reference.
- [Image preview actual size and DSH community plugin author’s video](https://github.com/albert-zen/zen/tree/7b6cb836c2cc14cac21d96b3c820fae84ddf5a9d/apps/zenx/docs/reviews/image-preview-actual-size).
- [Reply size and T3 author’s typography trial](https://github.com/albert-zen/zen/tree/2a351f04b8d63661eda8c937f20caf33cd45d00f/apps/zenx/docs/reviews/reply-text-size).
- [Return from Settings and the T3 author’s modal/prompt example](https://github.com/albert-zen/zen/tree/82fa85c3e30a2eb81d5caf48582c961681266efc/apps/zenx/docs/reviews/settings-return-to-thread).
