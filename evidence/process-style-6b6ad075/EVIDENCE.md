# Process styling: synthetic renderer evidence

- Tested source head: `6b6ad0752f9932c532da5a70ae8ca7545de176e3` ([draft PR #452](https://github.com/albert-zen/zen/pull/452)).
- GitHub CI run: [39394146672](https://github.com/albert-zen/zen/actions/runs/39394146672).
- Actions artifact: `12251520179`, `zenx-process-style-c8f2072919fc152b26fd5b9d8f6498bf368e1d88`.
- CI merge ref: `c8f2072919fc152b26fd5b9d8f6498bf368e1d88`.
- Artifact ZIP SHA256: `d2aff91371c0fa173a4baf3f009414047a1234145ba4f1b083fcf5d8f160b2a7`.
- Offline HTML SHA256: `02a6b66be2511699ac3a740c8809ca4985c3ec0ff2025d63e743280bd65a992d`.

These are full-viewport screenshots of actual production Sidebar, ThreadView,
ActivityText, theme and styles. Data is synthetic and read-only; no Host is
connected. Chrome is the runner's existing binary. Official Ubuntu Noto CJK
fonts were installed only in the ephemeral capture environment. No production
dependency or execution/state/grouping/folding behavior is replaced.

## Verified

- Four scenes: thinking/light/1280, waiting/dark/1280,
  thinking/dark/420, waiting/light/420.
- Group icon-to-label gap: exactly 6px in all four scenes.
- Total elapsed is above history, never inside per-item history.
- Same mounted turn completes without moving its top metadata: header Y remains
  171.6875px at width 1280 and 162.140625px at width 420.
- Default completion can collapse history, exactly as before this styling patch;
  existing user-inspection/focus protection remains covered by component tests.
- Computed sweep mask is a valid linear gradient, not `none`.
- Thinking row differs between animation times 700ms and 1100ms in actual Chrome
  screenshots. Independent pixel checks on the downloaded full captures found:
  light icon 142 and label 221 changed pixels; dark icon 136 and label 217.
- Reduced motion hides the decorative overlay. Base text and glyphs remain.
- No document overflow in the narrow captures, no renderer exceptions.
- Exact downloaded bundle also passes DOM smoke across 10 states and four live
  completion transitions. It has the same SHA256 as the locally built bundle.

The earlier `aba246ce` captures showed a solid overlay due to an invalid inherited
mask. They were layout evidence only and are NOT the motion evidence in this
branch. The regression rejects the old mask and browser gates verify the fix.

## Scope and limits

T3 Code inspired the shared overlay choreography, 4.5rem band, 2.2s steps(30)
and 6px spacing. Existing aggregate tool-category glyphs and labels remain:
a shell-containing group can display a terminal glyph with a thinking label.
Existing waiting labels and completion-fold defaults are not redesigned.
This is synthetic renderer evidence, not a live Host session or merge approval.
Broader repository CI status is separate from the passing screenshot step.

This branch stores review evidence only. Do not merge it into the product branch.

## Offline interactive preview

`process-style-preview.html.gz` is the exact self-contained HTML, compressed only for repository storage. Download and decompress it (for example, `gunzip process-style-preview.html.gz`), then open the resulting HTML in a browser. The controls switch scenes/theme/width and finish the same mounted turn. Its decompressed SHA256 is listed above; no external asset fetch is needed.
