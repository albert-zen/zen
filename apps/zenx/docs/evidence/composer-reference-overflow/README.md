# Synthetic reference Composer overflow evidence

Captured from production ThreadView/InlineComposerEditor and production styles with newly synthetic text, reference identity and model labels. No private screenshot or private content is included. These are Chromium renderer captures, not packaged Electron or physical-device acceptance.

- Candidate: `f1f181053571b482f94a933372144747599da81b`
- Captured merge: `255605fce12170c570dcafcc48b5e48121c97ad7`
- Exact tree: `646f6236c1346466d13cab5e1bcec1974603e329`; dirty status empty.
- [Passing capture run](https://github.com/albert-zen/zen/actions/runs/40321170804), [complete artifact](https://github.com/albert-zen/zen/actions/runs/40321170804/artifacts/12649540801).
- Chrome 155.0.8059.39 on disposable Ubuntu CI. Actual Chinese glyphs used Noto Sans CJK JP. All 461 locally available bundle/driver/dependency source hashes matched the captured manifest.

The `before` scene uses the exact previous production CSP without a style nonce. The `after` scenes use the existing main per-document nonce transform. No CSS is injected or edited to fabricate either state.

| Observation (1000px) | Before | Current main policy |
| --- | --- | --- |
| Long editor / scrollport | 134px / 660px; overlaps toolbar | 134px / 134px; 660px internal content |
| Wheel scrollTop | remains 0 | 0 to 526 |
| Empty shell / editor after ordinary short Backspace | 108px / 36px | 108px / 36px |
| Empty shell / editor after selection deletion | 129px / 57px | 108px / 36px |
| Announcement node after selection deletion | NBSP, normal flow, 21px | same NBSP, fixed at -10000px |
| Runtime-style CSP violations | 1 | 0 |

The residual 21px in this synthetic sequence comes from the CodeMirror announcement node remaining in normal flow when its base theme is blocked. It is not intrinsically exclusive to long drafts: short selection deletion triggers it too, whereas ordinary Backspace does not. The long-text clipping and this empty-height symptom are both resolved by the already-merged nonce policy; this regression PR adds no new product implementation.

All five scenes completed. The four nonce scenes cover 1000px/420px, English/Chinese, light/dark, exact clipboard paste, wheel, Backspace and selection deletion, undo/redo, re-entry, reference removal, and pointer-opened model menus without draft mutation. At 420px the scrollport remained 134px over 1290px internal content, and all cleared editors returned to the pristine 108px shell / 36px input.

The font prerequisite did install and verify the expected package and glyphs. Its separate cache transport improvement is not inferred from these UI screenshots; see #527 for that infrastructure work.
