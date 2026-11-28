# Copy a long code block without losing your reading place

**Same task and input.** Read partway into the same 86-line synthetic Markdown fence, including one over-wide line. Try copying the whole block without going back to the beginning. No real conversation, provider, files or operating-system clipboard. Original images are unedited viewport PNGs. Linux Chromium 131.0.6778.0 at DPR 1, offline builds; not a native Windows or macOS capture.

## ZenX: exact #761 vs local CSS-only candidate

| Theme and viewport | Already merged `9e65c3493b668e25d34c3942974716b7360b2e7e` | Candidate, not merged |
|---|---|---|
| Light, 1280 × 800 | [Original](zen-light-base.png) | [Original](zen-light-candidate.png) |
| Dark, 960 × 820 | [Original](zen-dark-base.png) | [Original](zen-dark-candidate.png) |

1. Open synthetic Thread one; enter the draft “The command stays in this draft.” Scroll to completed reply 26. Start with the top of its fence about 90px below the conversation viewport top.
2. Wheel down 555px inside the reply. In both renders the fence starts ~465px above the transcript and the viewport scroll position is identical. The original toolbar is off-screen and cannot be clicked. The candidate keeps one Copy/Wrap toolbar within the block at the viewport top; its solid theme background covers about 39px of code at that edge. It scrolls off with the end of its own block, never continuing into the next reply.
3. Copy by mouse. The intercepted clipboard receives all 86 original lines including the over-wide one, exactly as rendered, and the scroll position does not move. Tab then Space toggles line wrap; Space again restores horizontal scrolling. A horizontal wheel moves the code 235px without moving the transcript vertically or the page horizontally. Opening Find temporarily relinquishes the sticky top edge; Escape restores the toolbar without movement. Unsent draft unchanged. No new action, nested vertical scrollbar, change to unfinished fences, or new send behavior. Tested the exact source and separately exercised the candidate with the eight local changes.

## Same code and wheel action, Vercel Streamdown

- [2.3.0, original from this run](streamdown-2.3.0.png). In a standalone render of the published package, the 555px wheel moves the outer viewport; only the Copy/Download group stays pinned. Copy receives 86 lines without moving the outer viewport. [PR #401 author recordings](https://github.com/vercel/streamdown/pull/401) show earlier implementation of this operation, with different synthetic text.
- [2.8.1, original from this run](streamdown-2.8.1.png). The same wheel moves a 398px-tall *inner* code viewport 555px, not the outer viewport. The controls stay above the inner area and Copy receives 86 lines. [The 2.7.0 release](https://github.com/vercel/streamdown/releases/tag/streamdown%402.7.0) describes the move from sticky overlay to absolute controls after nested-scroll click problems. ZenX leaves vertical scrolling with the single transcript and keeps the existing action strip rather than adopting the extra inner vertical scroller or replicating the old pointer-events overlay.

These are actual same-task reference component renders, not a live T3, ZCode or Streamdown desktop app. Host chrome, exact typography and available controls are not comparable; no full-design or whole-app score is reported. This archive contains evidence, not product code.
