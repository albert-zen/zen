# File workspace before/after (2026-10-26)

Screenshots come from the actual ZenX renderer bundle built from this branch and
from the same bundle built without the fix, both launched as Electron with an
isolated `--user-data-dir` and `ZENX_DATA_DIR`. The workspace only contains
synthetic files (`docs/design.md`, `src/pipeline.ts`, `README.md` and two
generated copies); no personal workspace, credentials or Host data are shown.
The fake local model produced the single "Echo" turn that creates the Thread.

- `before-markdown.png` — production CSP drops the CodeMirror sheet: the editor
  is an unconstrained column that clips the document and cannot scroll.
- `after-markdown-scrolled.png` — the same document after a mouse wheel.
- `before-source.png` — the code surface renders line numbers only; the text is
  pushed outside the pane and no token carries a colour.
- `after-source.png` — line numbers, layout and syntax colours are back.
- `after-tab-rail.png` — five open files: every visible tab keeps its icon and a
  shortened title instead of leaving a clipped, icon-less fragment.

These are not OS-level acceptance evidence: no fullscreen transition, physical
pointer or native window-control overlay is exercised here.
