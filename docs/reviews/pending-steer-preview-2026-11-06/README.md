# Pending steer preview evidence

These two unmodified synthetic screenshots show production ThreadView canonical messages (above) and the waiting-for-model shelf (below), integrated with App Shot. No user images or data are included.

Source head: `fd47fafc1aa6e4cf276a17bf8af9f9284809ef7a`.
Tested merge: `96e81978c58669c6c2efe6027d33542c9ef97162`.
Tested tree: `0a215bd6757992f1a92f7eddf270e98eeda2242c`.

[CI artifact](https://github.com/albert-zen/zen/actions/runs/42241853065/artifacts/13517037260) passed all 24 scenes with 120 screenshots and 15 trusted acknowledged settled wheel receipts, no browser exceptions, Chromium sandbox enabled and cleanup complete. The selected PNG hashes match the artifact manifest. See source.json for provenance. The source run finished with all 10 CI jobs successful.

![Desktop two-image preview](desktop-two-images.png)

![Narrow two-image preview](narrow-two-images.png)

Coverage includes desktop/narrow, one/two images, short/long questions, pending/held/recall failure, actual image/body visibility and canonical alignment. This is production renderer acceptance with synthetic records, not end-to-end native Host/provider delivery. The source above predates the final CI shard integration; its success does not claim a new integration tree has passed.
