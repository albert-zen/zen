# Pending steer preview evidence

These two unmodified synthetic screenshots show production ThreadView canonical messages (above) and the waiting-for-model shelf (below). No user images or data are included.

Source head: `985402c1be85c44dc4192235575f2cbd62ab9ca4`.
Tested merge: `1d3adf87f529e667d6b1f452a2a23b7c69688c60`.
Both source and tested merge have tree `d7abd3a2e8a25be3f01042d740386df4686331c0`.

[CI artifact](https://github.com/albert-zen/zen/actions/runs/42202355199/artifacts/13495217073) passed all 24 scenes with 120 screenshots, no browser exceptions, Chromium sandbox enabled, and cleanup complete. The selected PNG hashes match the artifact manifest. See source.json for provenance.

![Desktop two-image preview](desktop-two-images.png)

![Narrow two-image preview](narrow-two-images.png)

Coverage includes desktop/narrow, one/two images, short/long questions, pending/held/recall failure, actual image/body visibility and canonical alignment. This is production renderer acceptance with synthetic records, not an end-to-end native Host/provider send. The commit retaining this evidence changes documentation only; the screenshots are explicitly attributed to the source head above.
