# Round-six UI + PR 748 combined validation

Completed 2026-11-09 UTC. This is focused local verification, not full aggregate, CI or native acceptance.

## Exact final source and build

- Repository: `/workspace/scratch/72527d3ea90a/ui-quality-scroll-integration`.
- Clean final HEAD: `d52b68577b0f3c24085dc09b3f9381be9d7267d1`.
- Final tree: `0e82e2a5e4540de034650832a9ed161a3ac08f31`.
- Main: `d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a`; PR 748: `0d6a106614db9135b66b4d6fd443f1e664b57d36` (open/draft/unmerged at the 20:03 UTC readback).
- Starting combined HEAD: `bebe9276ac303f0d2f85cbf7008c3d8711e7b80c`. Applied only the eight authorized source commits ending at UI `f1a19f19bd941d06eb924618664e89ed399404ac`, then test-only `d19bea0f163573c954aaee16022533bac35eb8c6`. No conflicts required resolution. No docs-only commits were applied.
- Commit mapping: `round-six-integration-cherry-pick.log` and `round-six-integration-test-correction-cherry-pick.log`. Final 16-file delta: `round-six-integration-final-changed-files.txt`.
- One prepared build completed at **20:20:55 UTC**, after serial node/web types. Build output: `apps/zenx/out`; renderer `index-poBsTopS.js` and `index-B2IsHlDh.css`. Output will be left untouched for the native owner.
- Source fingerprint, 640 files: `373d08d2b71b5d57492a8c345be8559db4b6813015b22bddf67eb8227aebd234`.
- Build fingerprint, 60 JS/CJS/MJS/CSS/HTML files: `d695703b94dea3aacb7f4768796421215d11984dabd5b83c9a233dff75189150`.
- Full manifest: `round-six-integration-build-fingerprints.json`, SHA-256 `68a9e068d1c6e34a3d7638e50e0d01a4791aa179abad81310b98e423f2b927b3`. Fingerprint algorithm is SHA-256 of sorted `relative-path + NUL + file-sha256 + newline` records; source roots/package inputs and build exclusions are explicit in the manifest.

## Tests: preserve the failure and correction

1. **Original 43-file focused run on `c9d9d635259d774b60456c1d515f2addb9992478` / tree `23ae20d17e714b6630bbdebb15d254b30e79ddbe`: 506 passed, 1 failed, 0 skipped, 507 total; 338.928 seconds.** Log: `round-six-integration-focused.log`. The sole failure was `project-row-actions.test.ts:88`, whose old total-SVG expectation was 3, while the approved folder-plus-disclosure presentation correctly has 6.
2. Applied the test-only correction after the original run finished. Verified that only `project-row-actions.test.ts` differs, all production/package inputs and the other 42 focused test files remain byte-identical, and the corrected file matches SHA-256 `4a30b5b6ce46210b334350f878923b88f26b8b2e3c3a3ae6d41e16ae0edb2207`. Evidence: `round-six-integration-test-correction-proof.log`.
3. **Complete corrected Project test file on final HEAD: 1/1 passed**, 2.621 seconds. Folder and expanded disclosure roles are asserted separately; the original creation, ordering and menu checks remain. Log: `round-six-integration-project-rerun.log`.
4. **Final-HEAD bounded App delivery/pending selection: 8/8 passed**, 15.734 seconds. Log: `round-six-integration-app-delivery.log`.
5. **Final-HEAD bounded App navigation/Information selection: 5/5 passed**, 26.767 seconds. Log: `round-six-integration-app-navigation.log`.

This is the original full focused run plus a corrected-file rerun and final-HEAD App checks. **It is not a clean 43-file run at the final HEAD.** The bounded completion preserves the original failure and verifies the exact test-only correction.

The exact 43-file manifest is `round-six-integration-test-files.txt`; the two App patterns and five literal names are in `round-six-integration-app-patterns.json`. Coverage includes Settings/Account action guards and drafts, provider feedback/identity, Rooms empty/error/focus/menu flows, Sidebar identity and ordering, Information failure/recovery, PR 743 pending identity/unknown-result behavior, and PR 748 reading/fullscreen geometry tests. All test processes used `--test-concurrency=1` and `npm_config_cache=/tmp/ui-quality-scroll-npm-cache`.

## Final-HEAD checks

- Changed-file Prettier: passed on all 16 changed files.
- `git diff --check bebe9276 HEAD`: passed.
- `npm run typecheck:prepared --workspace @zen/zenx`: passed, node then web, exit 0, 101.014 seconds.
- `npm run build:prepared --workspace @zen/zenx`: passed, exit 0, 21.819 seconds. Exactly one build was run in this phase.
- Commands, timestamps and exits: `round-six-integration-check-results.json`; serial transcript: `round-six-integration-check-sequence.log`. Corresponding `-prettier`, `-whitespace`, `-types` and `-build` logs are retained. npm emitted the existing unknown `http-proxy` environment-config warning; no type/build failure occurred.

## Protected changes and authority

- All 14 non-CSS paths changed by PR 748 are byte-identical to its frozen head, including fullscreen workflow/scripts, auxiliary-panel, conversation-read-state and associated tests.
- Exact 36-line fullscreen CSS postimage remains contiguous, SHA-256 `ceed6394260debd57588877b8a733d8bbfe3dbf88d7a29e8ef2b7debb91357a6`. The only styles.css delta from frozen UI f1a19f19 is the retained PR 748 fullscreen hunk; see `round-six-integration-css-vs-ui.diff`.
- `.github/workflows/ci.yml` equals frozen main. This is source parity, not a CI success claim.
- Other newly changed production/tests match frozen UI f1a19f19; the corrected Project test matches d19bea0f. Detailed final checks and hashes: `round-six-integration-final-protected.log`.
- Original `settings-input-integration-protected.log` is unchanged, SHA-256 `0087534c5ddf127b6367da1a87141c6e1a72b511ee79a6a08864a88c344526b0`. Old acceptance reports, fingerprints, bundles and failure evidence were not rewritten.

## Explicit limits and handoff

No whole App/5000-turn test, repository-wide aggregate, CI job/status, native interaction, fullscreen native acceptance, cross-platform or assistive-technology validation ran here. Source/component checks do not replace those. Earlier concurrent exit-137 typecheck outcomes belong to their original reports and are not retroactively converted into passes.

The exact build and fingerprint are frozen for separate native verification. This validation did not perform native interactions, publish or merge code, install dependencies, or mutate shared dependencies. Source and build remain unchanged while native evidence is collected.
