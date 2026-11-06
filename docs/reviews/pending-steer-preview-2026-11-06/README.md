# Pending steer preview evidence

These unmodified synthetic screenshots show production ThreadView canonical messages (above) and the waiting-for-model shelf (below). No user images or data are included.

Source product head: `e45423b5844006322d4ed7abb6b5848e8e3a7725`.
Tested merge: `505465273c9531e03fcc455574bfa74be9fe130a`.
Both have the exact same tree: `5b1c337ef6709f8ced0ebbb4e90fcfb3e6d3eb75`.

[Source artifact](https://github.com/albert-zen/zen/actions/runs/42251786082/artifacts/13521595956) passed all 24 scenes with 120 screenshots, 72 painted/unobscured image measurements (minimum 91.43%, original 90% threshold), and 15 trusted acknowledged settled wheel receipts. No browser exceptions, Chromium sandbox enabled, cleanup complete. The selected PNG hashes match the artifact manifest. See source.json for exact provenance and source hashes, including the reader cancellation patch.

![Desktop two-image preview](desktop-two-images.png)

![Narrow two-image preview](narrow-two-images.png)

Coverage includes desktop/narrow, one/two images, short/long questions, pending/held/recall failure, image/body visibility and canonical alignment. The reader cancellation fix prevents initial or deferred library positioning from surviving user scroll ownership; no replacement offset is queued. Deterministic real-ESM regression and a deferred-readiness harness additionally cover that race.

## Full CI limitations

The source run is not fully green: eight jobs succeeded, including aggregate, conversation/layout UI, real macOS Playwright, Windows packaged, Windows WinApp, Core and Android. Overflow UI failed before product interaction because Chromium did not publish DevToolsActivePort within 30000 ms. Windows attached-browser acceptance failed on Page.captureScreenshot after transport acceptance (id754, 10001 ms with a 10000 ms bound); no input was replayed. macOS packaged capability remained queued then was cancelled, so it has no acceptance result. The compatibility gate failed. Original failed runs remain available and are not relabelled as passes.

This is production renderer acceptance with synthetic records, not end-to-end native Host/provider delivery or proof of every production scroll path. The evidence-only commit retaining these files does not claim a fresh full-tree CI pass.
