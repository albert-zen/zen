# Cold entry and alternating between two long conversations

**Existing behavior, verified without changing the product.** ZenX source is [the exact merged #761 commit `9e65c349`](https://github.com/albert-zen/zen/commit/9e65c3493b668e25d34c3942974716b7360b2e7e), not the unmerged reading candidates. Screens are original Linux Chromium 131 captures at 1280 × 800 light English and 960 × 820 dark Chinese, DPR 1. The actual renderer ran offline, with a controlled bridge and two separate 30-turn synthetic conversations. This does not verify native window chrome, real Host history, incoming streaming deltas, or persistence across app restart.

## Reproduce

1. From the loaded sidebar, first open thread A and then later open thread B once each. Cold entry in both conversations shows the actual newest reply, whose last list item is visible above the composer. Both geometries settled at 0 CSS px from the physical end, with no return arrow.
2. Before leaving A, type an unsent draft and wheel up 2050 px. Before leaving B, type a distinct draft and wheel up 2900 px. Reopen A, then B, via the sidebar. The exact earlier reply heading and its viewport-relative offset are unchanged in each thread. B was blank before its own draft was entered, and the drafts never cross.
3. On returned B, use the one down arrow (mouse click in the wide run, Enter after focus in the narrow run). The last reply appears, the arrow vanishes, and physical bottom distance stays 0 for 30 measured animation frames. Switch to A again: same earlier heading, offset and draft, with its own arrow still visible. Switch back to B: 0 px from the end, own draft, no arrow.

| Reading checkpoint | 1280 light before → return | 960 dark before → return |
| --- | --- | --- |
| A | reply 27, 669.6875 → 669.6875 px | reply 27, 446.6875 → 446.6875 px |
| B | reply 25, 127.6875 → 127.6875 px | reply 26, 519.6875 → 519.6875 px |

The viewport may re-estimate virtual heights when a conversation remounts, so compare the visible reply and its offset, not the raw scrollTop. No browser exceptions or external requests occurred.

## Original PNGs

- 1280 light: [first open](base-light-1280-01-cold-a.png), [A paused before leaving](base-light-1280-02-paused-a.png), [A returned](base-light-1280-04-return-a.png).
- 960 dark: [B restored at its paused position](base-dark-960-06-b-before-arrow.png), [B after Enter on the down arrow](base-dark-960-07-b-live.png), [A remains paused when reopened](base-dark-960-08-a-still-paused.png).

## External reference and what it proves

[T3 Code #19663](https://github.com/pingdotgg/t3code/pull/19663), head `714165ea`, author-operated integrated Linux Chromium 1280 × 800 light with synthetic stored messages. I inspected both [original before](https://gh-file-drop-api-prod-mi5fy3sowv63ufte.pinglabs.workers.dev/f/52c5a24e81167276/browser-screenshot-localhost-mveo7uia-c73f8624.png) and [original after](https://gh-file-drop-api-prod-mi5fy3sowv63ufte.pinglabs.workers.dev/f/63297df8697cef43/browser-screenshot-localhost-mveo8l73-6e9dae1e.png): the final visible block changes from the beginning of synthetic section 13 to its last paragraph 13.44 above the composer. The author measured the cold-entry distance improving from 2152 px above the end to 0, with the existing exact reading restoration preserved across switches. The external PNGs specifically show cold entry, not the return to two separate paused drafts. No self-run T3, equivalent complete interaction images, or cross-product score is claimed. Reference verified a behavior, not a reason to copy its visuals. Zen passed with no product change.
