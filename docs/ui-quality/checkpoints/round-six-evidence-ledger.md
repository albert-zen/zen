# Round six evidence and saved slices

This is an active iteration ledger, not whole-application acceptance. Each code
checkpoint is recoverable before its final native validation. Earlier focused
results must not be treated as a complete suite or CI pass.

## Frozen evidence

- 01–36: native Projects/Rooms navigation, Account unconfigured, Models/provider
  management, General and Appearance. Source `bebe9276ac303f0d2f85cbf7008c3d8711e7b80c`.
- 37–45: native Information/subagent navigation and visibility using isolated
  synthetic local fake-model histories, same source.
- 46–55: actual production Information components in isolated native fixtures.
  Before is the same baseline; after is only the Information fix
  `f6ac97200cb9db21d3e98fbc97cd984da9431f03`. These do not constitute a complete
  integrated candidate or live Host failure test.
- 10 additional Account images: actual Settings/Account components at the frozen
  baseline, with synthetic read/auth ports and fictional identities. Pending,
  rejected, retry, navigation and theme states are component evidence, not a real
  connected account or successful remote sign-out.

All captures retain original pixels, file hashes, action records and native or
fixture boundaries in their frozen manifests. No authenticated competitor access,
real credentials, permission changes or external model traffic was required.
Five additional published T3 reference originals have exact public sources in the
reference manifest. They are development PR examples, not current shipped-state
claims. The Account-specific competitor evidence gap remains explicit.

## Independent baseline review

Sol and Terra received the same fixed ten-dimensional 0–4 rubric and originals,
not desired scores, prior scorecards or one another's assessments. Their reports
are `../reviews/round-six-baseline-sol.md` and
`../reviews/round-six-baseline-terra.md`. Both preserve the first 13-image review
and distinguish the expanded 36-image scope; no aggregate average is computed.
A broader scope with more weak journeys is not a measured regression from an
older, narrower scorecard.

In rubric order, the expanded-scope vectors are:

- Sol: 2, 3, 3, 2, 2, 2, 2, 3, 3, 3.
- Terra: 2, 3, 3, 2, 2, 2, 2, 3, 2, 2.

Actionable shared findings are weak Project ownership/disclosure cues,
indistinguishable same-prefix Room names, an empty Rooms creation instruction
without a direct visible entry, provider management identities hidden before
Edit/Delete, and a provider-only save message implying global completion while
General is still dirty. Terra also identified untranslated functional Appearance
choices. Dark text contrast is a measurement question, not a screenshot-proven
WCAG failure. Native Account fixtures separately reproduced duplicate pending
sign-out dispatch and absent pending feedback.

## Remote checkpoints

Each receipt verifies exact tree, changed blobs and modes, parent and remote
readback. Local and remote commit IDs can differ due to metadata while their trees
match. “Remote verification receipt” refers to Git identities and checks, never
authentication credentials. CI status and workflow lists returned empty; no CI
pass is inferred.

| Slice                            | Local commit                             | Remote commit                            | Exact tree                               |
| -------------------------------- | ---------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| Information initial-read errors  | f6ac97200cb9db21d3e98fbc97cd984da9431f03 | f189c221f05781f5d6bc0763a7a0d11466e0e0d0 | f60ebc369ff3b3abb34279edb95e543e1e9a6170 |
| Scoped provider feedback         | a206ae00a389cf9405e6fbd4347c080e0ea6288f | f7c3ab62ceeb83870d71402100a7e5e0ea68bb1c | bdf87a0473a85dc7eb45948fa3b57bd59d9c7cbf |
| Initial empty Room entry         | a9e4b494baefa18d813c46a8ff010afdfe987daa | 4ef5081bb7711f4ece235752095773822dffb61a | 66db54e1d68f6e98639dadc4a98112f6ace137eb |
| Provider identities / Appearance | 3a444ed1d946154bfe116fa556478c884e162797 | 282f53662c2f2ebd90e168cc3f673704ebb24ae4 | 56cb7944dbdb0d0ad2a5094b7368bb6981487a19 |

Sidebar identity/hierarchy is also saved: local `5413b8d948a272a3c99682ccb11689b807da0214`, remote `b6155b4e99b0ae59f945a539104c880e730bce2c`, exact tree `0d295deeda325a57a97a6c007675752bbcddbb02`. Its five-file identity, bundle and patch restoration were verified. Native candidate review remains pending.

The initial empty Room entry checkpoint is not accepted as-is: independent review
found mutation/read-error and late-read ownership boundaries, followed by a
current-read-failure dismissal-focus case. Fixes and regressions are being
completed before native acceptance. Saved checkpoints are not claims of merge
readiness. Account action exclusion and sidebar identities also require integrated
native checks after source freeze.

## Next acceptance boundary

Freeze the reviewed candidate, combine it with latest verified main and #748 in
an isolated worktree, preserve the fourteen protected files and exact fullscreen
CSS hunk, run the bounded joint regression suite and build, then capture matched
native journeys. Review the resulting evidence independently and iterate on real
remaining defects. Full App/large-history resource gaps, other platforms,
assistive technologies and post-Stop recovery limits remain open.

## Reviewed candidate and recovery update

The source candidate is frozen at local
`f1a19f19bd941d06eb924618664e89ed399404ac`, tree
`6c8a56d312c452c94dab1492d227f8bece014b71`. Its verified remote checkpoint 18 is
`d39a3b990fd8c5b2934261abf5ee79e539f9e415`. Five final changed files, parent,
blob identities/modes and non-force branch readback match; fixed bundle and
isolated-index patch restoration reproduce the exact tree. The intervening
checkpoint 17 remote is `1d89c84769d48ad32244c4a9f3bd9b31bfcca5a3`, with tree
`77a8a0665909e5ca08b34609d6203334a59b01b0`.

The earlier Room issues above have now been addressed in reviewed commit
`b0967e80a6ec1c63656d2cd138872e0407cb7bd6`: 32 focused tests cover mutation
warnings, stale read settlement and current-read failure/recovery dismissal
focus. Independent Terra source re-review found no further actionable issue in
scope. Account commit `e75a1db1a3457057a23b40a0bf1e8ae6a9feceab` supplies
synchronous action exclusion, localized pending feedback, owner fencing and
Account-local errors without losing General drafts. Author and independent Sol
runs each passed 158 Settings tests. Concurrent Node typechecks were killed with
exit 137 under resource pressure; those outcomes remain recorded. A subsequent
Node-only serialized check passed, as did renderer types and scoped formatting.

Independent Sol also reproduced a new sidebar menu/name-preview dismissal
regression against the exact old baseline. It was corrected in `f1a19f19`, with
23 Room tests and the reviewer's original two-case comparison plus three affected
cases passing. Escape now dismisses the menu once and returns focus; previews
resume after it closes. Full findings and source hashes are retained in
`../reviews/round-six-room-entry-terra.md` and
`../reviews/round-six-sidebar-account-sol.md`. These are code/test reviews, not
native visual certification.

The isolated combined candidate is
`c9d9d635259d774b60456c1d515f2addb9992478`, tree
`23ae20d17e714b6630bbdebb15d254b30e79ddbe`. Eight authorized source commits
applied without conflict. Fourteen non-styles changed files exactly match the
UI candidate; the fourteen protected #748 files, 36-line fullscreen CSS block
and main CI workflow remain unchanged. The 43-file focused suite, two bounded
App groups, types and one build are running serially. Their final outcome and
matched native after evidence are still pending at this entry.

## Completed-evidence archive

The separate immutable baseline backup
`zenx-ui-quality-round-six-baseline-evidence.zip` has 81 entries, 6,922,452 bytes,
SHA-256 `f1facb9cbd9dcdfd96282e2c5c7a42317e6a5ab6cac27a9ef588985a765741ab`.
It preserves the 65 original Zen QA JPEGs, five original public-reference PNGs,
manifests, safe assertions and independent baseline reports. Independent audit
verified all entry/image hashes, performed OCR on all 70 images and manually
inspected 18 originals. No actual credential or user-private identity was
identified; the declared Account identity is fictional `qa@example.test`.
This is bounded screening, not an absolute guarantee or final-candidate archive.
QA paths/timestamps and public publisher context remain visible. Two public PNGs
retain original date metadata; the originals were not altered or described as
fully synthetic or metadata-free. Raw profiles, auth files, Trace, runtime
journals, executable fixtures and underlying tool-result files are excluded.

## Measured next-iteration questions

`../reviews/round-six-source-contrast.md` resolves source tokens and alpha
compositing across 36 theme combinations. Ordinary General/Account/Models copy
exceeds the inspected text targets; there is no evidence for globally brightening
that copy. Narrower pairs require native confirmation and focused follow-up:
selected Appearance supporting text at 4.10–4.26:1 in dark Graphite Standard,
light tinted error text at 4.25–4.49:1, and some dark select boundaries at
2.44–2.85:1. Border ratios alone do not establish WCAG failure. No theme change
was made to the frozen candidate. Source calculations, screenshots, native
computed styles and accessibility certification must remain separate evidence.
