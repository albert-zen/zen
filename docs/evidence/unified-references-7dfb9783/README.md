# Unified reference layout evidence

Synthetic data only. Source PR456 head: `7dfb9783d657e3822fa86ad6cba92acac4811fd9`; CI checkout: `68547d6b8900fd2e7b5eded5ca131070ce533379`. [CI run](https://github.com/albert-zen/zen/actions/runs/39532646828), artifact `12315453545`.

Actual Ubuntu Chrome capture with explicit desktop-input capability emulation, not physical native hardware. Both alternatives show all five reference categories in draft and sent layout studies. No production send UI is claimed. Capture asserts hover/fine media, 28px tokens, exact excerpts, draft-only removal and no horizontal overflow. The screenshots were visually inspected for Chinese glyphs, wrapping and full context. Dark/narrow/combined variants and exact adapter requests remain in the source run artifact.

Self-contained HTML SHA256: `e368b59cb4fe4930ddcc61f3895636d13a1b5e179bc2429382659ca3a2d5bb96`, identical locally and in CI.

[Actual current model-context examples and implementation limits](../../../apps/zenx/docs/quote-layout-comparison.md).
