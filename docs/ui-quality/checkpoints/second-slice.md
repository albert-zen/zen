# Second implementation slice

Builds on local first slice `5ebb6e83fa0f421357575b7a0a24f8ef401e1301`,
whose identical tree is preserved remotely at
`90e3511d1c96fdeb219a79b46c44a901b367265f`.

## Evidence and changes

- A genuine exact-prefix Fork in the native app had no visual boundary between
  copied history and new branch content. Add a localized, muted separator whose
  placement is proven from loaded canonical provenance, never guessed from time.
  Full-context continuations do not receive this separator. Unknown or mixed
  history suppresses it rather than making a false claim.
- Extend Appearance's non-color selection cues to mode and contrast. Keep actual
  radio controls, keyboard focus and profile persistence. Reserved check space
  prevents labels moving when selection changes.
- Native review caught contrast labels overflowing the existing 116px column.
  Fix the accidental grid constraint and size equal contrast pills by content.
  Preserve the rejected screenshot separately; it is not acceptance evidence.
- Preserve merged page item positions so a loaded Fork tail can be proven across
  history pages while retaining the existing continuation cursor.

## Independent review and corrections

Sol and Terra reviewed the baseline; Astra and Luna independently challenged
frozen A/B screenshots with the same ten-dimension rubric. No reviewer received
a desired score, threshold, another reviewer's score or intended winner. Scores
remain per-dimension, with evidence, uncertainty and task scope. They are not
averaged or used as an acceptance gate. See the separate review records.

Astra found better account navigation, empty-state explanation and readable
Appearance choices, and requested mode/contrast non-color cues. Both challenge
reviews retained a tradeoff: the old PAW card more clearly grouped onboarding,
while the new composition leaves more attention for current work. No further
PAW change is justified solely by competing aesthetic preferences.

Luna's first report misread several pixels. Reopening original images corrected
those specific claims, without asking for a higher score. The correction record
is preserved. The light Appearance pair is not mode-matched (System vs Light);
the dark pair is matched. Screenshot API JPEG bytes had historical PNG filenames;
manifests now record decoded encoding and dimensions without altering pixels.

Terra's correctness review reproduced a real Fork blocker: a copied older
aborted Turn could sort after the final inherited Turn because its synthetic
closure receipt follows the Fork marker. The first separator implementation
incorrectly labeled that copied Turn as new branch content. The revised
implementation places the divider after every provably inherited rendered row,
and suppresses mixed or unknown ordering. Independent re-review passed all nine
Fork boundary tests and found no remaining blocker in that change. The older
last-item ordering behavior predates this diff and is not silently redesigned.

## Native coverage added

The canonical synthetic seed is reproducible through public App Server APIs.
Actual native captures cover a genuine exact-prefix Fork and source navigation,
communication sender navigation to a child and back, grouped fake model choices,
24-turn reading position across thread switches and sidebar collapse, Back to
live, and reachable narrow General/Appearance settings. These prove local UI
behavior with synthetic data, not real provider authentication, autonomous agent
spawning or sustained stream timing. Frozen component fixtures retain their
separate, narrower evidence label.

## Verification scope

Related Fork/history regression suite: 33 passed. Independent Fork re-review:
9 passed. Appearance interaction suite: 109 passed before the native overflow
correction; focused Appearance coverage passed again after that CSS correction.
Both TypeScript projects passed for the Fork source changes. Final build and
native recapture are recorded with the candidate manifest.

Two aggregate reruns exposed fixed-sleep assumptions in the Information test
fixture: initial native layout read and retained-edit completion. Controlled
80 ms delays reproduced both failures. Bounded waits for the actual owner layout
and completed write preserve the original assertions and pass the delayed full
Information suite (11/11) and exact combined rerun (134/134). Original failures
and probes remain in the timing report. Combined latest main + #748 verification
runs in a separate local worktree; no remote merge or PR is authorized.

## Still open

- Actual sustained streaming, pending admission/steer transitions and failure
  timing in the native app need additional controlled capture.
- Real plugin-provided Information cards and true autonomous agent spawning are
  not demonstrated by canonical synthetic communication.
- Cross-platform native behavior and a full application test suite are not
  established by these focused checks.
