# Appearance readability follow-up

## Decision and saved source

Source checkpoint: local 292a768e720e4b2843d87060e00c08893f35cde2,
published as fed20ea7f12ff9ce521ed7c34be73b6c73c7a451 on
`tod/ui-quality-contrast-followup`. Both trees are
0e1144f980d0e94784cc0b27a3550f012c500ff7. The earlier experimental source is
preserved as local ab52d87f / remote 448a50a0, tree
b849fa506dc86ce497b3fba28240fae8ea93ae15. The original UI branch is unchanged.

Final net change since 403584e4: available Appearance option labels use the
secondary text role instead of muted text, and option labels use the 13px label
size instead of 12px caption size. Existing checks, selected outlines, focus
styles, layout and runtime behavior remain. The first experiment reduced
selected borders; independent reviewers identified a loss of current-value
recognition, so that part was reverted. No new design authority or product
semantics were introduced.

## Independent visual evidence

The original A/B report is `../reviews/contrast-native-original.md`. The new
P/Q reviews are `../reviews/appearance-primary.md` and
`../reviews/appearance-challenge.md`. Each received the same fixed rubric and
four images, without source mapping, earlier review scores or a target score.
Both reviewed P before Q, so order bias remains. Both preferred the clearer
selected outlines for current-value scanning while noting stronger available
labels in the other candidate. All six scored dimensions remained 3/4.

R combines those strengths. Both reviewers found it an acceptable/local
improvement within the same score anchors, not a score increase. R addenda were
written after their earlier findings and are not a fresh independent randomized
trial. Remaining questions include small helper text, equal prominence of the
two remembered preset groups and the button-like decorative preview sample.
Do not change remembered-preset semantics merely to make a screenshot quieter.

Complete source mapping, hashes and original JPEG dimensions are in
`../evidence/appearance-followup-20261109/capture-manifest.json`.

## Native component actions

Ran production SettingsView in isolated sandboxed Electron, with synthetic
local account/settings ports and loopback-only fixture assets. This tests actual
rendered production controls, but not the full Host, real account or OS theme.
No user desktop, account, existing profile or external provider was used.

On final R in the foreground dark window, actual keyboard input:

1. From Dark mode, Tab focused Light preset. Right selected Cobalt without
   changing the current dark theme; Left restored Graphite.
2. Tab focused Dark preset. Right selected Cobalt and the current surfaces
   changed; Left restored Graphite.
3. Tab focused Accent. Right selected Iris and selection/preview colors changed;
   Left restored Azure.
4. Tab focused Contrast. Right selected High and boundaries/text changed;
   Left restored Standard.
5. Tab focused Reset appearance, whose separate offset focus ring was visible.

Five focus screenshots and four changed-value screenshots document those
states. The Light preset focus screenshot is in dark mode; its name does not
mean light-theme focus. A reviewer separately saw a distinct offset focus ring.
X11 exposed only the window, so this is not assistive-technology semantic proof.
Reset activation, light-theme focus, persistence/restart and System following
were not newly native-tested in this slice. Source tests cover controller
persistence/system changes separately.

Earlier P background-window focus attempts are retained but are not counted as
visible-focus passes. A requested 398×636 native window and a subsequent native
resize attempt both remained 1180×812 in observed output. `R-narrow-top.jpg`
records that failed attempt; it is **not narrow-layout evidence**. No responsive
pass is claimed. No security restriction was changed to force a resize.

## Checks and #748 compatibility

- Final source: Appearance 12 plus theme policy 6, **18/18**, zero skipped;
  focused run 2698.800735 ms. Fixture bundle builds succeeded.
- Independent combined candidate cc071d25ddee1399e6fe5b770e25b9d299087839,
  tree 51e98686510c5f3f987440554a0b473d4ee31f63: **245/245** tests across
  12 complete files, no skips, 102691.666634 ms; web typecheck, own-worktree
  prepared build, formatting and whitespace checks passed.
- All 14 protected #748 files, its exact 36-line fullscreen CSS hunk and frozen
  main workflow remained identical. The frozen worktree's 640 source and 60
  build hashes matched before and after. See `appearance-748-verification.md`.
- An initial tsx CLI invocation failed before tests on IPC `EPERM`. Its log is
  retained. Standard `node --import tsx` ran the same complete file list and
  passed without changing source or suppressing tests.

This is not a full repository aggregate, hosted CI, fullscreen native acceptance,
all-platform accessibility audit or evidence that all user journeys are done.
Token contrast assertions are source/compositing math, not a WCAG certification.

## Publication safety

Ordinary git push was unavailable because the HTTPS credential was absent.
The authorized GitHub connector wrote verified blobs/trees and a fast-forward
branch update with expected-head protection. A subsequent fetch and whole-tree
diff confirmed the published source equals the local final tree. No PR, merge,
deployment, profile, credential, IPC token or dependency was published. Full
runtime profiles and bundled temporary executables are excluded from evidence.
