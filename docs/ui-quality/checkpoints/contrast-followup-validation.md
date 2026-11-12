# Contrast follow-up recovery and verification

2026-11-09. Active UI work, not whole-application acceptance.

## Recovery and isolation

Both original worktrees were clean: UI `c4fb90f3` and combined/native candidate
`d52b6857`. Remote UI was already `020571d7`, not the older handoff's `d39a3b99`.
Remote `020571d7` and local `e54ddcbd` have identical trees despite distinct commit
metadata. The six extra local c4fb90f3 files preserve the combined verification;
there were no lost uncommitted source edits to overwrite.

The new worktree/branch `tod/ui-quality-contrast-followup` starts at c4fb90f3.
Neither original worktree nor d52b6857's frozen build was modified. The reason
for the earlier interruption is not established by these checks.

## Source checkpoint and remote receipt

Local source commit: `e31f0936328ea14d29de3ff4917dce1e96cb2e7e`.
Exact tree: `b74384bdada38e41388035965df77dffec26ef3c`.
Remote checkpoint: `ba2acd4a7b743754187a3f743fbbd8beaadadd0c`, parent
`020571d71cc4d469d203df85f637fdf0cdc8686a`, on the new branch
`tod/ui-quality-contrast-followup`. Remote fetch/readback and whole-tree diff
confirmed identical source, modes and evidence. Original UI branch unchanged.

The ordinary Git push failed before publication because HTTPS Git had no username
provider. The connected GitHub API created the exact verified nine-file tree and
new branch. No force update, PR, merge, deployment, real account operation or
permission expansion occurred. Commit statuses and PR-triggered workflow queries
returned empty; **no CI pass is inferred**.

Production changes are confined to two semantic text roles:

- Selected Appearance supporting text uses existing secondary text; unselected
  copy, surfaces, labels, focus and checkmarks are unchanged.
- Plain Settings error banners use a dedicated danger-soft text role. Dark
  resolves to existing danger text; Light uses `#a93f3a`. General danger/status
  colors and error meaning are unchanged.

The third source file adds unrounded alpha-composition regression checks across
36 mode/preset/accent/contrast combinations. The original failing regression and
the intermediate test-parser whitespace failure remain in local logs. The
parser accepts the CSSOM's normalized slash spacing; final source checks pass.

## Final local verification

All below ran on e31f0936 production/test bytes:

- Full `appearance.test.ts`, `theme-source-policy.test.ts`, and
  `settings-interaction.test.ts`, serial: **175/175 pass**, no skips,
  81.316 seconds. This includes all 158 Settings cases.
- Earlier bounded Appearance/Account selection: **12/12 pass**; superseded in
  scope by the complete three-file run, not added to its count.
- Web TypeScript: passed.
- `build:prepared --workspace @zen/zenx`: passed in the new worktree only;
  output renderer is `index-9S5uAnpL.js` / `index-yMosWXWM.css`.
- Prettier for the three source/test paths and `git diff --check`: passed.
- Independent source reviewer: no introduced blocker; independently ran
  Appearance 11/11 and theme-policy 6/6 plus format/diff checks. See
  `../reviews/contrast-followup-source-review.md` for the cascade limitations.
- Independent and implementation calculations agree: selected-description
  minimum **6.1838:1**, error-on-card **5.1020:1**, error-on-main **4.9077:1**.
  Exact 36-state source values are `contrast-followup-token-values.json`.

No full repository aggregate, Node typecheck, whole App/large-history run,
new #748 integration, platform accessibility testing or CI job ran here. Earlier
failures and limits remain preserved in their original records.

## Rendered evidence boundary

The actual SettingsView fixture builds successfully from baseline and candidate
without rewriting production source. JSDOM mounted Appearance and Account, and
its actual Sign out control exposed the synthetic local rejection. The fixture
contains fictional identity/data and no remote account ports.

**New browser/native capture was not completed.** Browser `file:` navigation was
rejected by the protocol policy and not retried. Supported HTTP localhost
attempts returned connection refused, including a server in the CUA runtime.
Temporary servers were stopped. No screenshot was generated, no new visual
score is assigned, and no source ratio is described as native or WCAG acceptance.
The prepared fixture and its limits are under
`../scripts/contrast-followup/README.md`.

Next: use a working supported local preview/native launcher, capture matched
Appearance and plain Account errors, inspect computed colors/ancestors and focus,
then give identical original pixels/reference captions to independent reviewers
without targets or prior verdicts. Existing T3/Codex/Linear/Vercel references keep
their original published-image limits. Only after that step should this slice be
combined with the separate #748 candidate for fresh native acceptance.

## Recovery artifacts

The remote incremental bundle requires existing remote base 020571d7 and was
verified with `git bundle verify`. The source patch was applied to an isolated
Git index over c4fb90f3 and reproduced the exact e31f0936 tree.

- `ui-contrast-remote-ba2acd4a.bundle` SHA-256:
  `5bae833cd12c5668f4f4267968613d43c468f7dcecc5c1a92f0bc1fb031cffce`.
- `ui-contrast-e31f0936.patch` SHA-256:
  `b8a0f68ba1627d214674baf0373b0cbf28479819404eacb2d4036facc4ab3423`.

These contain authorized source/document/test changes, not profiles, Trace,
credentials or dependency trees. Generated fixture HTML is not included in Git.
