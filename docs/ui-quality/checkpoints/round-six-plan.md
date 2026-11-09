# Round six: extend the journey coverage

Checkpoint 11 is a recoverable stage, not completion of whole-application UI
improvement. This round continues from local `f830cc31dc6cbdf8db5229365ff909e796903b31`
and verified remote `9cdbcbeada64f07725d5f8d376e21cb5f025b6bc`, with production
code `1ebcb0501f0e5f3d8886b6e8288921adff78fb68`.

The separate combined baseline is `bebe9276ac303f0d2f85cbf7008c3d8711e7b80c`,
containing main `d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a` and #748
`0d6a106614db9135b66b4d6fd443f1e664b57d36`. The UI branch does not absorb #748.
Both remain protected during this iteration; new source slices need a fresh
combined build and affected joint regressions before their acceptance.

## Journeys being added

1. **Projects and Rooms navigation:** populated and empty sections, multiple
   objects, long names, selected/hover/keyboard focus, menus and cancellation,
   returning to context, collapse/expand and light/dark surfaces.
2. **Models and Account:** provider identity and model retrieval, default/title
   distinction, unrelated unsaved General drafts during provider save, validation,
   cancel/reopen and unconfigured Account. Real sign-in, credentials and remote
   providers remain outside isolated QA. An expired access token is not inferred
   to mean a signed-out subscription when refresh credentials remain valid.
3. **General and theme parity:** setting groups, descriptions, errors, saved vs
   draft state, light/dark contrast risks, locale and keyboard focus. Actual
   contrast measurement, where performed, is distinguished from visual opinion.
4. **Agent communication and Information:** current owner/source, navigation,
   healthy empty vs failed initial reads, Retry, existing data, selection changes,
   and readable contextual actions without replacing product authority.

## Evidence and iteration

- Capture actual native product states using fresh isolated fake-only histories.
  Label production-component fixtures separately. Preserve original pixels,
  exact build/source identity, safe field-only assertions and failed states.
- Freeze each useful batch. Independent Sol and Terra reviews receive the same
  rubric, images and factual reference captions, without desired scores,
  previous scorecards or the implementation author's verdict. Use dimensions,
  confidence, image IDs and falsifiable next checks, never an aggregate target.
- Reproduce behavior findings with focused production-component regressions.
  A clearly reproduced failure can be corrected while the broader visual audit
  continues; a static-code suspicion is not presented as a proven UI defect.
- Implement bounded, reversible slices, then recapture matched tasks/themes and
  test repeated/cancel/late-response/owner-transition behavior. Later challenge
  reviews examine the integrated result rather than merely repeat ratings.
- Commit and push each inspectable slice with exact remote tree readback and
  bundle/patch recovery. No PR, merge, account connection, permission expansion
  or deployment is authorized by this workstream.

## Reference addition

`../references/round-six-published-manifest.json` and
`../references/round-six-published-references.md` record five original official
T3 development images: General light/dark, Providers, model picker and context
panel. The settings PR is open and marked DO NOT MERGE. These images provide
real published layout examples, not current shipped behavior or successful
account-management evidence. Do not copy their shell, faint contrast or runtime
semantics wholesale. Existing official Codex, Linear and Geist references remain
available with their original provenance limits.

## Existing limits remain explicit

The incomplete full App/5,000-history checks, other-platform/assistive-technology
gaps, original black-frame diagnostic and untested post-Stop body recovery do not
become passes merely because another round starts. Freshly discovered gaps and
remaining polish are recorded rather than silently declared closed.
