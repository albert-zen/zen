# Packaged Legend native UI evidence

These four unchanged screenshots come from [native run 41726008884](https://github.com/albert-zen/zen/actions/runs/41726008884) on 2026-11-03.

**Result: FAILED at the strict clipboard-versus-Selection raw-string equality assertion. These screenshots are partial evidence, not overall acceptance.**

## Source and environment

- Product source: [7ffcc0f3db9081c2f21ef6ab20b8bfe82330eb9d](https://github.com/albert-zen/zen/commit/7ffcc0f3db9081c2f21ef6ab20b8bfe82330eb9d).
- Product tree: `81ae1c701bed3ac8bbcafc5c9142c3b40557ba2d`.
- Diagnostic driver: [e769703a82a4f0861c8a0ebcda35c2578fd03f99](https://github.com/albert-zen/zen/commit/e769703a82a4f0861c8a0ebcda35c2578fd03f99).
- Platform: packaged native macOS arm64 app, 1280-pixel-wide window.
- Fixture: an owned offline fake-provider workspace with 5,000 prior synthetic turns (10,000 messages) and three real Enter-key sends. All displayed conversation content and the temporary workspace path are synthetic.
- Source artifact ID: `13275448173`; ZIP SHA-256: `f114c078e1e0dbae4fce84fa1799baed00d16d6239524dcc360b561012729d56`.

## Screenshots and limits

1. [messages-10000-sample-0-after.png](messages-10000-sample-0-after.png): settled view after the first sampled Enter-key send, including the synthetic request and fake-provider echo. It is not a capture of the pending frame.
2. [virtual-find-wrapped-tail.png](virtual-find-wrapped-tail.png): Find at the wrapped tail match, showing “5000 of 5000” and the highlighted synthetic user text.
3. [virtual-selection-before-scroll.png](virtual-selection-before-scroll.png): selected synthetic text and the floating Copy/Quote/Add to side chat controls before scrolling.
4. [send-latency-failure.png](send-latency-failure.png): captured state at the later failed strict Copy comparison, with broad visible text selection. It does not establish clipboard equality or passing Copy behavior.

The run stopped at the strict Copy comparison. Clear/restore, reopen, image behavior, and narrow-screen acceptance were not completed. The screenshots do not establish pending-frame pixels or full acceptance.

## Integrity

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| messages-10000-sample-0-after.png | 131514 | `fe608280956d2a50b13306f107b9bb38f824caabbffb613df47a9213660291b4` |
| virtual-find-wrapped-tail.png | 146975 | `929b66091f6cf229964c2fe2208b89b932d28c4f62143709d1f7e4f9cb71e4e8` |
| virtual-selection-before-scroll.png | 148224 | `cd67a40026d34c3be25c781c61a37236e8ab15b308112417ddce34301a3b7fd0` |
| send-latency-failure.png | 151971 | `af75823769fb6246d97ee6f84ff0e4ba83db10e046d2020f0bfd1dedf21b8ae5` |

This evidence-only branch adds the four PNGs and this README to the exact product source tree; it does not change the product source branch, PR head, or main.
