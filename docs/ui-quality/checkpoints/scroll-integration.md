# Local UI / PR #748 integration verification

Status: complete. Clean local integration; 398/398 focused tests, fixture follow-up 11/11, prepared build and node/renderer typechecks pass.

## Isolation and inputs

- Detached worktree: `/workspace/scratch/72527d3ea90a/ui-quality-scroll-integration`
- Main: `d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a`
- PR #748: `0d6a106614db9135b66b4d6fd443f1e664b57d36`
- Local merge: `0a232f363c97326cb5e995931c6b89726e5ab5e9`
- Main+#748 tree: `b94d90f63a375bae7e9be8f9c34a9f3c7b61ff51`
- Merge was clean. No original branch was changed, and nothing was pushed or published.
- Dependencies are external third-party symlinks. First-party workspace and CLI links point to this worktree. Builds use this worktree and `/tmp/ui-quality-scroll-npm-cache`.

## Planned checks

- Fork feedback, fork boundaries, history-page ordering, reading state and unread acknowledgments.
- Pending tray, fullscreen primary visibility, hidden transcript/read behavior, virtual transcript layout.
- Sidebar interaction contracts, settings controls, room onboarding, editable and plugin information surfaces.
- Plugin preparation, ZenX typecheck and prepared production build.

## Limits

This is synthetic Node/DOM/source-contract testing and build verification, not native CUA evidence. Parent owns native acceptance. No CI or remote checks were initiated.

## Final integrated sources

- UI commit: `00efffddbfd492dbc16f51487eaacf36b5952d88`
- UI tree: `7e0bf3553017ebba5f7093e22c7d7abece507212`
- Combined local merge commit: `627192e1018a6d89dfbe84792781233e6b69da22`
- Combined source tree: `2b7b55286c3309f46dc07b841c28a53d5dd3da50`
- UI merged cleanly without manual conflict resolution. Shared `styles.css` changed in disjoint rules; the integrated diff against UI retains #748 fullscreen geometry/visibility rules. `git diff --check d7f93b83 HEAD` passed. Working tree clean after tests/build.

## Completed verification

- Main+#748 baseline: 26/26 passed before adding UI, in `scroll-integration-baseline-tests.log`. This is a separate baseline, not included in the final combined 398 count.
- First-party plugin preparation: passed, all 16 tarball variants created locally (`scroll-integration-prepare.log`).
- Combined focused suite: `node --import tsx --test --test-concurrency=2` across 35 files, **366 passed, 0 failed, 0 skipped**, 131.29 seconds. Full test names/results: `scroll-integration-tests.log`; exact file manifest: `scroll-integration-test-files.txt`.
- Adjacent suite: same Node runner/concurrency across 5 files, **32 passed, 0 failed, 0 skipped**, 22.34 seconds. Files: `thread-history-cache.test.ts`, `fork-feedback-preview.test.mjs`, `message-fork.test.ts`, `sidebar-resource-races.test.mjs`, `fleet-onboarding-ui.test.ts`. Full names/results: `scroll-integration-adjacent-tests.log`.
- Final combined total: **398/398 across 40 files**, no skips.
- Prepared production build: `npm run build:prepared --workspace @zen/zenx` passed; Electron main/preload and production renderer generated. Full output: `scroll-integration-build.log`.
- Initial `npm run typecheck:prepared --workspace @zen/zenx`: process killed with exit 137 during concurrent tests/build, no TypeScript diagnostic emitted. Original log preserved: `scroll-integration-typecheck.log`. Serial retry: **passed node and renderer typechecks** (`scroll-integration-typecheck-serial.log`). This retry began on the initial combined tree; the fixture-only commit arrived during its execution. To remove any snapshot ambiguity, node/test typecheck was rerun from the final fixture tree and also **passed** (`scroll-integration-final-fixture-typecheck.log`, exit 0). Renderer and production code are unchanged between these trees.

## Relevant tested behavior

- Copied Fork boundary identity/order and DOM cue, paginated history, fork feedback/message fork, cached-history retention.
- Pending queue/steer grouping, reordering/unknown mutation safety, labels and scroll ownership.
- Reading-state follow/pause/anchor restoration, hidden fullscreen geometry, primary/resource tab visibility, hidden acknowledgments.
- Sidebar ordering, pinning, archive stability, information interaction, late-resource races, question attention and layout contracts.
- Settings radio/selection behavior, persistence, late save/error handling; Room onboarding/clarity; editable and plugin information layouts.

## Original fixture outcomes

The exact committed tests were used unchanged. The Room fixture race mentioned by the parent did not reproduce at test concurrency 2. No test was omitted because of that known race, edited, or silently retried. The fixture correction is not part of the initial combined `627192e1018a6d89dfbe84792781233e6b69da22` tree tested by the 398-test run; it is included in the final `2499ab3074046572bf31f39db7679a655201c7f1` tree below.

## Test-fixture follow-up

- Parent supplied fixture-only commit `f143a18031078144787ecbb6328c5870226988f7`, which changes only `apps/zenx/test/editable-information-panel.test.ts` and its timing documentation.
- Clean local cherry-pick: `2499ab3074046572bf31f39db7679a655201c7f1`; tree `f3885ed612a4a73860c001f9a06b482fb17ef89c`. Production source is identical to the tested/built combined tree above.
- Follow-up Information suite on this final fixture tree: **11/11 pass**, no skips, 8.78 seconds; full names/results `scroll-integration-information-fixed.log`. The original 398-test outcomes remain recorded for the previous exact tree; the full suite was not rerun for fixture-only changes.
- Parent's controlled-delay reproductions are reported separately in its fixture timing document; this worker did not independently inject delays.

Final verification: `git diff --check d7f93b83 HEAD` passes and the detached integration worktree is clean. No native CUA, CI, remote merge, push or publication was performed.

## Native streaming follow-up

Actual Electron capture subsequently ran this final integration tree with a fresh
isolated, production-validated synthetic profile and controlled local FakeModel.
Nine original screenshots are indexed by integrated-native-manifest.json. Bottom
following advanced checkpoint8→21. Reading checkpoint28 held at the same offset
while output receipts advanced30→70, survived sidebar thread switch/return and
collapse, then Back to live resumed following146→166. Stop completed through
the actual UI, and the isolated app was closed. No external service/credentials.
This native run excludes the later pending-only Fork status-label slice.
