# Native Recent ordering acceptance — 2026-11-02

Product: `e5c3fe9bf91ce0385bf730cd364b3035a82fa461` (PR619).
[Native run 41406567098](https://github.com/albert-zen/zen/actions/runs/41406567098), job 125149830296: **passed**.
[Focused run 41405245728](https://github.com/albert-zen/zen/actions/runs/41405245728): root and ZenX typecheck passed; 70/70 focused tests passed; independent formatter six files unchanged.

## Actual full-App scenario

Disposable owned native Mac Electron, real production App and Host, private fake-provider profile, production DomainThreadJournal seed. Native mouse/keyboard and left-sidebar wheel only; no injected UI arrays, fake ACKs or JS draft/scroll mutations.

Three persisted synthetic Threads initially sort **C, B, A**. A has a newer non-message instruction (`updatedAt=00:16:40`) but its accepted final's original time is `00:00:03`; B/C finals are 00:00:13/23.

1. Native A send starts a real shell tool that waits 12 seconds: **A, C, B**, A running.
2. Native B send reaches its exact admitted Turn's canonical completed fact: **B, A, C**.
3. Twelve observations over 1.8 seconds keep that order, A's live running indicator and its original receipt recency.
4. A's exact admitted Turn completes: **A, B, C**, while **B remains selected**.
5. Reloaded complete App DOM still orders **A, B, C**.

The tool call occurs before B. The stable interval has no guaranteed intermediate canonical event, so this is **not isolated proof of post-B tool-result suppression**; type-specific suppression is covered separately by Core tests. This is correctness evidence, not send-latency acceptance.

After owned Host shutdown, independent read-only production-storage reopening verifies both actual client identities exactly once, admitted Turn completion, matching canonical event and ItemList IDs, A's real tool call/result, complete Trace and zero compaction attempts/facts. Exactly two native sends occurred.

## Full-page screenshots

[Artifact-only image readback 41407040036](https://github.com/albert-zen/zen/actions/runs/41407040036), job 125151315769, reads original native artifacts without running the App again. Three full-page images were actually inspected:

| File | SHA-256 |
|---|---|
| recent-01-cold-original-message-order.png | 0f4524e686190e4f9a37fa7a7744f7146fb6d290bd33d5ee40c2fd8c739ad2f5 |
| recent-02-background-tool-does-not-reorder.png | 625a620027ba55110b89f614eff2cab1a7a3938ca6df2cea1fe7d1b9776c9ad6 |
| recent-03-final-bumps-without-stealing-selection.png | 64ceb970d435bf3ee20c5f6afa52915d83ef6b8fea22d1cc155756a7d9a42d96 |

They visibly show initial C/B/A, B selected while A runs below it, and A moving above B without changing selection. The fourth reload screenshot has Recent below the fold after scroll reset: **reload order is supported by DOM assertions, not by that screenshot**. No claim is made that it visually displays the Recent order.

Earlier focused run 41404253272 had 70/70 tests passing but failed ZenX typecheck on the newly added Sidebar fixture's union return type. The author corrected fixture typing and applied exact hosted formatting; the successful e5c3 checks above retain all assertions. Full repository CI and merge approval remain separately owned.
