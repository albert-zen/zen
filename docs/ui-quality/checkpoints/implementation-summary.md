# Implemented UI quality checkpoint

This is a reviewable working branch, not a release or merge approval. The product
source checkpoint is `58df4ea3852e4826d3aa31a931c3383258bc0c47` on
`tod/ui-quality-iteration`. Main was rechecked at
`d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a`; the separate #748 head was rechecked at
`0d6a106614db9135b66b4d6fd443f1e664b57d36`. Neither was modified by this work.

## What changed

1. Account's unconfigured state now has a real route to existing model settings.
   PAW setup is quieter without removing setup/dismissal. Appearance captions use
   readable shared tokens and selection has non-color checks. Information has an
   explicit heading and a truthful, receipt-gated empty hint.
2. Copied Fork history has a provenance-backed boundary. It never guesses from
   text or a full-context view, and includes all provably inherited rendered
   rows even in a legacy out-of-order projection. Appearance selection controls
   reserve marker space without clipping labels.
3. Pending Fork activation has a readable localized Forking label, duplicate
   protection and reduced-motion treatment, preserving existing failure/retry
   and newer-navigation rules.
4. Pending inputs retain the single bounded tray, with a native overflow thumb
   visible at rest when needed. The running Send menu uses 13px labels and 12px
   explanations, viewport containment, keyboard-reachable internal scrolling,
   44px preference control and compact reflow.
5. Check delivery has exact-input, disposable progress/result feedback. A usable
   read does not claim rejection from absence. An independently reproduced
   window/full-history bug is fixed by reconciling exact accepted identities
   from the full read without replacing a newer bounded transcript or changing
   compaction/submission order.
6. Subagents Information names the Sidebar column explicitly in English and
   Chinese without changing child-name widths, switch behavior or native
   profile persistence.

A separate test-fixture timing correction replaces two fixed sleeps with bounded
exact-owner readiness waits. It does not weaken assertions or change product
behavior.

## Evidence navigation

- `first-slice.md`, `second-slice.md`, `third-slice.md`: implementation decisions.
- `fourth-delivery-validation.md`, `fourth-native-validation.md`: authority,
  lifecycle tests and final native unknown-delivery/repeat/navigation evidence.
- `fourth-presentation-validation.md`: actual production-component captures,
  390px iframe and native 200% zoom, with exact scope limitations.
- `native-agent-information.md`: authentic bundled Subagents/native history,
  sidebar toggle, source navigation, owner isolation and split popover.
- `sidebar-caption-validation.md`: final caption code and native evidence.
- `scroll-integration.md`, `fourth-scroll-integration.md` and
  `final-integrated-native-validation.md`: protected #748 comparison and exact
  integration versions. The final combined native build retains Reading
  checkpoint 28 across later output, thread return and Sidebar collapse, then
  resumes explicit live following and stops cleanly.
- `../reviews/`: independent Sol/Terra assessments and later Astra/Luna challenges.
  Scores stay tied to frozen evidence; factual corrections and follow-up
  closures are explicit. There is no averaged or target acceptance score.
- `../scripts/`: reproducible source-only fixtures. Native screenshots remain
  original bytes in the delivered archive; manifests record actual encoding,
  dimensions and hashes. No profiles, credentials or raw runtime journals are
  published.

## Important limits and next work

- Full App aggregate testing did not complete: the existing 5000-Turn case
  encountered process/V8 memory termination after earlier passing tests. A fresh
  isolated 5000-history tool-results case also exhausted the default heap, so
  suite accumulation is not the only explanation. The canonical-append case
  passed in an isolated 4 GiB-heap process; its default-heap attempt has an
  unknown outcome after executor session loss. See
  `large-history-isolated-verification.md`. These are test-process findings,
  not a proven product regression. Bounded regressions, final types/builds and
  integration evidence are reported separately, never as a full repository or
  CI pass.
- Native captures are Linux Electron. They do not establish macOS/Windows,
  physical touch, screen-reader or measured WCAG conformance. The 390px test is
  an explicit component iframe, not whole-app mobile support.
- A black native frame occurred once after workspace dismissal/scrolling in the
  earlier Information journey. Its original image is retained separately.
  Later attempts succeeded; the cause is unproven and remains a diagnostic task.
- Unknown local recovery copies remain deliberately non-restart-persistent,
  as the existing UI explicitly warns. Durable recovery design needs its own
  retention/authority work; this styling effort did not silently change it.
- A pre-existing legacy Turn ordering issue can render inherited order 0,2,1.
  The Fork boundary now handles that safely; chronological sorting itself was
  not rewritten in the scroll-sensitive area.
- Remaining P3 research concerns include queue/source icon discoverability,
  archived-name disclosure, and overflow cues while zoomed. These are testable
  follow-ups, not a reason to redesign the shell or change runtime semantics.
- The Theo/T3 council and hill-climb research is source-linked in
  `../research.md`. “Zio”, “PlotCode” and “DeepSea Harness” are not silently
  treated as verified aliases; ambiguity and published-reference limits remain.

No PR, merge, deployment, account connection or permission expansion was performed.
The authorized branch is saved incrementally with exact tree readback and
recoverable Git bundles/patches.
