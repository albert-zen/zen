# Native history browser acceptance

This screenshot uses only synthetic history and an unsent synthetic draft, rendered by production ThreadView in Chrome 156. It is not a native Electron/platform capture.

Source head: fbc7dbe070d555c5df7da80dc5f238e722ae9113
Tested PR merge: 0695fa59acf8671826724ded8e0981c0a50ca2ae
Exact source tree: 8ee186a2b915075986740e6fab1d5e8ce1b84bb6
Successful run: https://github.com/albert-zen/zen/actions/runs/42075990960
Raw measurements and lifecycle receipt: artifact 13439185958 in that run.

The fixture backfilled all 256 Turns through 12 reads, then Find materialized and highlighted the exact oldest answer while preserving the draft. Only 10 Turns were mounted. Before and after prepend, the same anchor key and -608 px offset were observed. Initial 256/1200-Turn native responses were 109091/109732 bytes.

This evidence-only branch does not alter the tested PR head and is not intended for merging.
