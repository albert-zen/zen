# UI quality iteration

Workstream baseline: `d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a` (2026-11-09).
This work is isolated on `tod/ui-quality-iteration`. Product semantics remain
owned by `apps/zenx/docs/ui-ux.md`; this folder records experiments and evidence,
not another design authority.

## Stage plan

1. Verify current product rules, prior work, competing product names, public
   references and historical design iterations. Capture the real current app.
2. Freeze a reference pack and have Sol and Terra evaluate it independently
   using the same rubric. Do not provide a desired score or threshold, another
   reviewer's score, or the implementation author's assessment.
3. Select the highest-impact evidenced problems; implement reversible slices
   and repeat identical capture tasks. Preserve conversation authority,
   pending-send semantics, drafts, keyboard operation and scroll behavior.
4. Add Astra and Luna at a later frozen checkpoint for independent challenge,
   not score averaging. Resolve findings from evidence and user tasks.
5. Run focused behavioral tests, aggregate checks and visual regression tasks.
   Save commits, push the authorized working branch and verify the exact remote
   SHA. Do not open a PR or merge without separate authorization.

## Protected concurrent work

- Baseline includes the merged unified pending tray (#743).
- #748 / #747 contain separate sidebar and reading-position work. Do not copy,
  overwrite or reset those branches. Changes touching their surfaces require
  explicit comparison against their final versions before integration.
- Browser submit and native computer capture fixes have other owners.
- Profile, journal and application launch data used for captures are isolated,
  deterministic QA data, never the user's active profile.

## Required journeys and states

| Journey              | States / behaviors to capture and verify                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| Thread navigation    | New and existing thread, long titles, pinned/project rows, collapsed sidebar, switch away/back         |
| Conversation         | User/agent hierarchy, work-duration row, tool/reasoning groups, finished/error/interrupted states      |
| Fork                 | Existing history vs new branch boundary, source navigation, return and focus                           |
| Composer / pending   | Draft, preparing/admitting, queued and steer states, edit/recall, failed/unknown outcome, repeat click |
| Reading position     | Follow while at bottom, hold while reading, jump to latest, switch/return, sidebar resize              |
| Information          | Card hierarchy, agent communication, source/switch action, customize, empty and unavailable            |
| Models               | Default/title/current identity, provider editor, validation, unsaved changes, cancel/reopen            |
| Account              | Connected/unavailable state and next action, no real sign-in or data transmission in QA                |
| Appearance           | Light/dark, accents/contrast, immediate preview, keyboard and reload                                   |
| General              | Language, send mode, grouping and save feedback, narrow layout                                         |
| Global accessibility | Keyboard order, visible focus, target size, long strings, narrow layout, reduced motion                |

A state not reached is marked **not tested**, never assumed from code or a
neighboring screenshot. Static production-component fixtures supplement native
app evidence, but do not prove native persistence, actual delivery, or platform
integration. Marketing screenshots are references, not audited competitor flows.

## Capture record

Each accepted image must identify source URL or local commit, actual UI or
fixture type, timestamp, theme, viewport, route/state, and actions used to reach
it. Inspect saved pixels before review. Preserve matched states and viewport in
before/after pairs. Keep screenshots unaltered; no generated visual is evidence.

## Review scale

Review `rubric.md`. Scores summarize observed evidence, not an acceptance gate.
Functional regressions, false state claims, inaccessible essential actions and
missing verification remain blockers regardless of scores. Keep each review
independent and tie it to an immutable commit/evidence manifest.

## Checkpoints and evidence

- First implementation: `checkpoints/first-slice.md`, with native manifests and
  independent baseline Sol/Terra reviews.
- Independent paired challenge: `reviews/paired-astra.md` and
  `reviews/paired-luna.md`. Factual corrections remain explicit; scores are not
  combined into a target or acceptance number.
- Second implementation: `checkpoints/second-slice.md`, source
  `00efffddbfd492dbc16f51487eaacf36b5952d88`, with seven native candidate captures
  described in `checkpoints/second-slice-candidate-manifest.json`.
- Reproducible public-API canonical journey seed: `scripts/README.md`.
- The native screenshots, published reference images and recoverable Git bundle
  are retained together in the separately delivered evidence archive. Manifests
  record actual decoded file formats and hashes; historical PNG extensions do
  not override the capture API's actual JPEG encoding.
