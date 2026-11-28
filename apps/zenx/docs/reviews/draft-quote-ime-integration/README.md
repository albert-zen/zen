# Draft journey after switching threads and resizing

This is a comparison between the exact merged #761 renderer (`9e65c3493b668e25d34c3942974716b7360b2e7e`) and eight local product candidates built together on that source. **No new source is in the draft PR or main.** Runtime: sandboxed Linux Chromium 131.0.6778.0, production React renderer with a synthetic, offline bridge. No actual message delivery, real conversations, Electron window, or system input method. All PNGs below are unedited screenshots.

1. Open the first of two 30-turn synthetic threads, type a draft, scroll up and select a distinctive phrase from a past assistant response, and add it as a quote. Click the standalone arrow to go to the latest reply.
2. Switch to the other thread and type an independent draft, change width, and return. The first draft and quote should be present. Activate its quote token to return to the source.
3. Focus the first draft, add the synthetic Chinese text, dispatch `Enter` with `keyCode=229` and `isComposing=false`, then use a separate ordinary Return if the draft is still present. Confirm the second draft remains untouched.

**Dark, Chinese UI, 960 → 1280 × 820:** Both focus reply 22 when opening the quote. The merged version has no attached phrase highlight; the candidate highlights the original excerpt at offset 340, including the wrap between lines. On the simulated confirmation, the merged renderer calls the stub sending bridge once and clears the draft, displaying its already-existing pending state. The candidate calls the stub zero times and retains draft, focus and quote without a newline; ordinary Return then calls it once with the right thread, quote and term exactly as composed. The second draft persists in both.

- Quote activation: [merged #761](base-01-quote-source.png) · [candidate](candidate-01-quote-source.png).
- Immediately after simulated confirmation: [merged #761](base-02-ime-confirm.png) · [candidate](candidate-02-ime-confirm.png).

**Light, English UI, 1280 → 960 × 800:** Both already highlight the correct excerpt in this variant (reply 19, offset 425). Simulated confirmation still triggers one submission attempt in merged versus zero in candidate; the candidate preserves the stopped draft and sends exactly once on ordinary Return. The second draft persists in both.

The merged renderer and candidate were run through these same steps with the same synthetic data. Additional checks on the eight-change stack reproduced the [earlier reading journey](https://github.com/albert-zen/zen/tree/9a5fe10fd822b2e10c9cdff6892e6d0e7ce2b769/apps/zenx/docs/reviews/combined-reading-journey) in dark/wide and light/narrow. A separate paused-thread width change retained the exact source glyph in both directions; row-heading position is not a valid proxy for a reflowed paragraph. The candidate now leaves existing active-composition handling in the editor intact and intercepts only the late 229/false signal at the editor itself. Renderer typecheck and 90 focused tests passed. The real OS input method, particularly the first distinct physical Return after confirmation, still needs native verification.

**Design reference and rating:** The [T3 quote author recording](https://github.com/pingdotgg/t3code/pull/22293) covers selection and editing, not reopening a quote after switching threads. [T3 #2817](https://github.com/pingdotgg/t3code/pull/2817) is a source-level IME comparison. Neither is a matched live or recorded reference for this combined journey. No visual score for this journey or new overall score.
