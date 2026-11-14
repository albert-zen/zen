# Fourth UI / PR #748 integration verification

Status: complete. The requested three commits integrated cleanly. The fourth-slice 553 focused tests and 8 bounded App tests passed; all 161 distinct final-tree caption/Sidebar/profile checks have passing outcomes after the documented npm-cache correction. Final node/web types, prepared production build, formatting, protected #748 comparison, and clean-worktree checks passed. Native acceptance and full aggregate checks were not run.

## Isolation and exact sources

- Existing detached worktree: `/workspace/scratch/72527d3ea90a/ui-quality-scroll-integration`.
- Starting commit: `2499ab3074046572bf31f39db7679a655201c7f1`; starting tree: `f3885ed612a4a73860c001f9a06b482fb17ef89c`. The worktree was clean before integration.
- Starting sources already include main `d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a`, #748 `0d6a106614db9135b66b4d6fd443f1e664b57d36`, prior UI through `00efffddbfd492dbc16f51487eaacf36b5952d88`, and fixture timing correction `f143a18031078144787ecbb6328c5870226988f7`.
- Fork pending-label input `9ac08c5792e375d1b6cdbe27c5960176e5eccf5a` cherry-picked as `df56b2e15c53a3261978b43d0e62b536ce3eada3`.
- Delivery-check/readability input `0a72293a9f60c2e48671da0dbd580fdfa7b01ac3` cherry-picked as `516b128e89baffbbb8c413c519802dee0b09cea3`.
- Both cherry-picks completed cleanly. No conflict resolution or production-code alteration was performed by this verifier.
- Verified fourth-slice commit: `516b128e89baffbbb8c413c519802dee0b09cea3`.
- Verified fourth-slice source tree: `71acd12df810ae509e46495f4159e5f00935fd55`.
- Node `v24.22.1`; npm `11.9.0`.

No original branch, main worktree source, native app, or shared dependencies were modified. No dependency installation, push, PR, merge to a published branch, CI request, native launch, or CUA action was performed. Profile tests use their own disposable synthetic directories, not a user or native-acceptance profile. Existing isolated first-party plugin preparation is reused; no first-party package source changed from the previously prepared integration.

## Completed checks on the fourth-slice tree

- **Focused suite: 553/553 passed**, zero failed/cancelled/skipped, across **46 files**, 129.71 seconds. This reruns the prior 40-file set and adds delivery-check, send readability, ThreadView component, composer-state, immediate-send feedback, and compaction feedback coverage. Exact files: `fourth-scroll-integration-test-files.txt`; full TAP: `fourth-scroll-integration-tests.log`; command/source/timestamps: `fourth-scroll-integration-tests.metadata`.
- **Bounded real-App regression: 8/8 passed**, zero failed/cancelled/skipped, 15.23 seconds. Includes exact late receipt reconciliation, same-watermark/newer bounded history windows, usable/unavailable/failed delivery reads, explicit unknown-send recovery, admission/canonical identity feedback, and stable dock/popover historical grids. Full TAP: `fourth-scroll-integration-app.log`; exact name pattern and source: `fourth-scroll-integration-app.metadata`.
- **Formatting passed** for all 18 files changed by the two new commits. `git diff --check d7f93b83 HEAD` also passed. Log: `fourth-scroll-integration-format.log`.
- Source hashes for all 18 changed files: `fourth-scroll-integration-source.sha256`. The five delivery authority/ThreadView/i18n hashes agree with the implementation checkpoint's frozen hashes.

### Protected #748 comparison

The true #748 merge base is `238d0abb9f6da00cc25aa0e90e76a08277397303`. Its 15 changed paths were compared against the integrated tree:

- All **14 non-CSS files are identical to #748**, including `auxiliary-panel.tsx`, `conversation-read-state.ts`, all #748 preview/native fixture scripts, its workflow, and its focused tests.
- The complete **36-line CSS postimage hunk**, including context, is retained byte-for-byte. It preserves fullscreen width/display geometry behind resource tabs, selected-primary visibility, and descendant hiding for painting/hit testing/keyboard navigation.
- The remaining `styles.css` delta versus #748 contains only Fork pending/history and appearance-control rules. The latest two commits add only the Fork pending CSS there.
- Full protected comparison and CSS diff: `fourth-scroll-integration-protected.log`.

## Final Sidebar-caption integration

- Caption input: `58df4ea3852e4826d3aa31a931c3383258bc0c47`.
- Clean local cherry-pick: `7c5813f474c3bace74fd30fed9fd0f0b75abe431`.
- **Final source tree: `4a24efab6c84e0880fe4214a295414979cc60438`.**
- The five-file delta adds the localized Sidebar column caption, its CSS and tests, and the documented presentation rule. It changes no existing switch action, runtime ownership, pending delivery, scrolling, or fullscreen implementation.
- The original node/web check finished before this cherry-pick, exit 0; log `fourth-scroll-integration-typecheck.log`, source/timestamps `fourth-scroll-integration-typecheck.metadata`.
- No caption path overlaps any #748 changed path. The previous exact protected-source comparison therefore remains valid on this final tree; log `fourth-scroll-integration-caption-protected.log`.
- Caption-file Prettier and final whitespace checks passed: `fourth-scroll-integration-final-format.log`.
- Final changed-file manifest and hashes: `fourth-scroll-integration-final-source-files.txt` and `fourth-scroll-integration-final-source.sha256`.

### Final-tree caption and Sidebar checks

- **160/161 passed on the first 21-file run**, zero cancelled/skipped, 29.39 seconds. All caption and Sidebar assertions passed. The sole failure was the first `subagents-profile.test.ts` packaging test: its npm child exited 1 and reported that it could not write the default `/home/agent/.npm/_logs` directory. This is preserved, not silently discarded, in `fourth-scroll-integration-caption-tests.log` and `.metadata`.
- **The unchanged two-test Subagents profile file then passed 2/2**, zero failed/cancelled/skipped, 3.75 seconds, with `npm_config_cache=/tmp/ui-quality-scroll-npm-cache`. No implementation or test source was edited. Retry evidence: `fourth-scroll-integration-caption-profile-cache.log` and `.metadata`.
- Thus all **161 distinct final-tree caption/Sidebar/profile checks have passing outcomes**, but there was not a single clean 161-test first run. This is not combined into the earlier 553+8 count because the source snapshots and overlapping tests differ.
- Exact 21-file manifest: `fourth-scroll-integration-caption-test-files.txt`. Coverage includes English/Chinese caption placement and single occurrence, empty/unrelated/archived child filtering, absence without trusted sidebar context, unchanged exact-child Hidden/Shown switches, profile-backed visibility, and the existing Sidebar ordering, Pin/archive, attention, presentation, resource, and state contracts.

## Coverage and explicit limits

The completed suite covers Fork pending/repeat/error behavior and boundary identity/order, paginated/cached history, live following and paused-reader restoration, hidden fullscreen geometry and read acknowledgments, pending tray ordering/identity/labels, delivery-check local feedback and authority, settings interactions, Room/information fixtures, and Sidebar interaction contracts.

This is synthetic Node/DOM/source-contract verification. **Native acceptance on the final combined source was not run.** Prior native evidence from an earlier integration must not be relabeled as final-version acceptance. For a later native run, use this worktree's final prepared output and a new disposable, production-validated synthetic profile with a recorded source identity. No such profile has been seeded here.

The 553-test suite and bounded 8-test App suite were not rerun after the final caption-only commit; their exact earlier tree is identified above. The complete App test file, including its previously reported 5000-turn SIGKILL case, was deliberately not rerun. No full App-suite, repository-wide `npm test`, aggregate `npm run check`, platform-native smoke suite, or CI success is claimed. The broader prior incomplete run is historical evidence only, not a failure from this verifier's current bounded run.

## Final build and source state

All following checks ran on final commit `7c5813f474c3bace74fd30fed9fd0f0b75abe431`, tree `4a24efab6c84e0880fe4214a295414979cc60438`:

- **Node and web typechecks passed**, exit 0. Command: `npm run typecheck:prepared --workspace @zen/zenx`. This runs node then web TypeScript checks serially. UTC interval: 2026-11-09 17:42:41–17:44:00. Evidence: `fourth-scroll-integration-final-typecheck.log` and `.metadata`.
- **Prepared production build passed**, exit 0. Command: `npm run build:prepared --workspace @zen/zenx`. UTC interval: 17:44:00–17:44:22, after the typechecks ended. Electron main/preload and production renderer were generated locally. Evidence: `fourth-scroll-integration-build.log` and `.metadata`.
- These commands used the existing isolated writable `/tmp/ui-quality-scroll-npm-cache`. The npm environment emitted its existing `Unknown env config "http-proxy"` warning; no TypeScript diagnostic or build failure occurred.
- **Final whitespace check passed and worktree is clean**, confirmed at 17:44:22 UTC: `fourth-scroll-integration-final-state.log`.
- Complete generated-output SHA-256 manifest: `fourth-scroll-integration-build.sha256`.

Primary prepared outputs:

- `apps/zenx/out/main/index.js`: `3c3927332a1352aa8d07b832bdd3c8a87742d7508278e4a3663e5ed059b7778f`
- `apps/zenx/out/preload/index.cjs`: `9adcc3bec4de755c0e4758db2fca95cc212277f7b5dc94ad2705b1ac5f7750b7`
- `apps/zenx/out/renderer/index.html`: `5633a923965e36db8bf0627b608b4319ab93daaf5af90a59d3e683c93351fab0`
- `apps/zenx/out/renderer/assets/index-Bj1UaKW-.css`: `6d6ea1aa58ac585994ae0565c876ee4ab9922a9efc88e632fd4b674b49326cea`
- `apps/zenx/out/renderer/assets/index-ijScZcCZ.js`: `5f9163ec6181b785f71e0669168fc3be3e77bfc3a33e6bf0804396920702f89a`

No pending verification stage remains in the assigned non-native scope. The report and logs are only in `/workspace/shared/ui-quality-evidence/`; no report was added to the parent's repository by this worker.

## Addendum: final combined native reading-flow validation

After the original non-native verification above, the lead completed a bounded
native run on the same final `7c5813f474c3bace74fd30fed9fd0f0b75abe431` build with a
fresh isolated synthetic profile. Eight original JPEG screenshots show live 017,
Reading checkpoint 28 retained during later output and after Thread return and
Sidebar collapse, Back to live resuming at 091 and continuing to 099, then
“Stopped Progress kept.” Persisted receipts confirm interruption after 100 outputs
and a durable `turn_aborted` result. All 640 source files and 58 built files were
rechecked against the recorded fingerprints; the integration remains unchanged.

See [the native validation](final-integrated-native-validation.md) and
[original-image manifest](final-integrated-native-manifest.json). This supersedes
“native acceptance not run” **only for that bounded reading/following/Stop flow**.
The original report and automated-test scope are preserved. No native fullscreen,
hidden-window, cross-platform, full aggregate, CI or release acceptance is added.
