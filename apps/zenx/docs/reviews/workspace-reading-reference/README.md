# Keep the reading line when the right workspace opens

**Evidence only.** Main baseline: merged ZenX production renderer from [#761](https://github.com/albert-zen/zen/pull/761), merge `9e65c3493b668e25d34c3942974716b7360b2e7e`, source tree `6982b4f87a4f65af15f46a98120eb22ffeb107d4`. Candidate: the same tree plus isolated changes to App, ThreadView and a workspace text anchor; change set SHA-256 `aab4d6867fa2fb02ffeb7aa5eaa5417736a2a359eee8855ec42556a6b17d0cd9`. The fix is not on main or in this evidence commit.

## Completed reply, comparable to T3 Code

Cloud Linux Chromium 131, 1440 × 1000, light, DPR 1. Open the synthetic Release checks thread, enter but do not send the same draft, wheel upward 780 px from latest, then use the main toolbar to open and close the right workspace. Follow the same character in the synthetic reply labeled Release section 14 (text offset 909), measured relative to the transcript top. The initial and after-closing frames match across builds byte for byte.

| Stage | Main | Isolated candidate |
| --- | --- | --- |
| Workspace closed initially | [+6 px, original](completed-before-opening.png) | Same original |
| Workspace open | [−129 px, offscreen](completed-open-main.png) | [+6 px, same line still in view](completed-open-candidate.png) |
| Workspace closed again | [+6 px, original](completed-after-closing.png) | Same original |

Draft and pause state survived; the arrow stayed available, and explicitly returning resumed following. No real Host, external requests or page errors.

**Reference:** [T3 Code #41184, author-captured originals and recording](https://github.com/pingdotgg/t3code/pull/41184#evidence), cloud Linux Chromium, light, 1440 × 1000, their own synthetic conversation. Base `27ab8d49eb`, head `4f3b2e98d8`. Old view moves from around sentence 20 to 15; corrected view keeps sentence 20 near the top. Same interaction and display size, different contents and split sizes. This is the author's browser run, not a local run of T3 Code. The comparison is about reading stability, not app-wide aesthetics. No independent scores yet.

## Extension: response still streaming

At 1540 × 900, light, the real renderer accepted eight additional synthetic native item_delta paragraphs after the workspace opened. The original character was y=3 → −51 → 3 px on [main](streaming-open-main.png), vs 3 → 4 → 4 px on the [candidate](streaming-open-candidate.png). Explicitly returning and appending more text kept the tail gap at zero. At 1100 × 850 dark both held the same heading during this stream test. The T3 originals above do not cover this stream condition.

Follow-up checks retained transcript selection under keyboard panel activation (selection created by fixture), allowed immediate real wheel input to override correction and preserved the existing workspace-closed 961 → 960 → 961 resize behavior. This covers primary toolbar workspace open/ordinary close in the renderer; not all entry points, code/text selection positioning, or native macOS and Windows.
