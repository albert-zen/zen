# Appearance / #748 final compatibility verification

## Result

Focused local verification passed. No source regression found. This is not repository aggregate, hosted CI, native interaction, or cross-platform acceptance.

- Worktree: /workspace/scratch/72527d3ea90a/ui-quality-appearance-748-verification
- Exact HEAD: cc071d25ddee1399e6fe5b770e25b9d299087839
- Exact tree: 51e98686510c5f3f987440554a0b473d4ee31f63
- Base: d52b68577b0f3c24085dc09b3f9381be9d7267d1
- Applied source-only commits e31f093 -> 0c0c062a45e9a06af0a1046c60055873481dfd21; ab52d87 -> baa6bab942a22eb1c65b3f3f905b1cd39fba6f31; 292a768e -> cc071d25ddee1399e6fe5b770e25b9d299087839. All cherry-picks clean; no docs applied; final git status clean.

## Net source review

Only apps/zenx/src/renderer/src/styles.css, apps/zenx/src/renderer/src/theme.css, and apps/zenx/test/appearance.test.ts changed (164 insertions, 7 deletions). Reviewed full net diff: stronger secondary text and label typography for Appearance choices, selected supporting text readability, and separate error-text token with stronger light-mode danger foreground. Existing selection borders/focus cues remain. No state, lifecycle, layout geometry, persistence or protocol code changed. Added assertions cover 36 theme/preset/accent/contrast combinations and alpha-composited error/selected backgrounds. JSDOM token/source tests are not full browser cascade or native visual acceptance.

## Protected proof

All following 14 files byte-match frozen PR #748 0d6a106614db9135b66b4d6fd443f1e664b57d36 AND combined base d52b6857:

- .github/workflows/fullscreen-primary-chat-ui.yml SHA-256 279801a9c31f9b815a5d2a2d99aec2ebd6faf548244eca92cbe2e5bf7b80371c
- apps/zenx/scripts/build-fullscreen-primary-chat-preview.mjs SHA-256 d4311735895eae5787eb365fe357fb37a1e29e8553ecb6c132f3838900d84e0a
- apps/zenx/scripts/build-fullscreen-primary-native.mjs SHA-256 8fcd2d222b4bb976d4b7f4645fcc7f47b450d23c143faefc48d04ffd1b4bab73
- apps/zenx/scripts/capture-fullscreen-primary-chat-preview.mjs SHA-256 d8555d5ef68d8572f38c5cbf2c3630122306ed3eec157adb6b93a280b08be810
- apps/zenx/scripts/capture-fullscreen-primary-native.ts SHA-256 75e5d9414d7b3f736e2b4bf86d39c5e58dcf5f14681963ffe9b7c5f872a88012
- apps/zenx/scripts/fullscreen-primary-chat-preview.tsx SHA-256 0a6bce173718ac8ce55e90465289af7b1813c5ff331982714eeb6d07b05b2e5e
- apps/zenx/scripts/fullscreen-primary-native-preload.cjs SHA-256 00c89a6237606d1035ede5f9bbf053be022c4242b1213442f827596d9607ff9a
- apps/zenx/scripts/verify-fullscreen-primary-native.mjs SHA-256 1a9b04c9dea5a4db1b0578e9e7297be5586b610cd9a8625b3477f1988e9aafa8
- apps/zenx/src/renderer/src/auxiliary-panel.tsx SHA-256 420268d5a116ba97a582530f712e0089e995df767d2903e17959428a10f7aa0d
- apps/zenx/src/renderer/src/conversation-read-state.ts SHA-256 4570df15d24418e626c450e81fcefda989699bfa317d340654cd03d7bdfde7c6
- apps/zenx/test/conversation-read-state.test.ts SHA-256 f0264e1a97f14eb31919ca77703d29c3213cc6ffa7604bcd05fc2f6f593d1ca5
- apps/zenx/test/fullscreen-primary-conversation.test.ts SHA-256 de193a7492a80b8d9ad575bd1d1c1cc04566a528a446977e5107e8ede5234cf2
- apps/zenx/test/fullscreen-primary-native-fixture.test.mjs SHA-256 65e4dbfdae5b6b07d8c6eeff937decb2cd8441a9fd365ebc931ccc93695a3b2e
- apps/zenx/test/virtual-transcript-layout.test.mjs SHA-256 9d847e13c0a287747bd328d83138fb73635d3cbaba275065b1b801859c29af20

Exact 36-line fullscreen CSS postimage remains contiguous at line 12464; SHA-256 ceed6394260debd57588877b8a733d8bbfe3dbf88d7a29e8ef2b7debb91357a6. Main workflow .github/workflows/ci.yml byte-matches frozen main d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a. Detailed evidence: ../evidence/appearance-followup-20261109/verification-protected.json.
Frozen original worktree HEAD/build were never modified. Independently checked all 640 source and 60 build entries from committed round-six-combined-build-fingerprints.json before and after verification, zero mismatches. That preserves frozen renderer index-poBsTopS.js / index-B2IsHlDh.css and original build fingerprint d695703b94dea3aacb7f4768796421215d11984dabd5b83c9a233dff75189150.

## Checks and original launch failure

- Original command: npm_config_cache=/tmp/appearance-748-npm-cache node_modules/.bin/tsx --test --test-concurrency=1 $(cat /tmp/appearance-748-evidence/test-files.txt). Exit 1 before tests due to tsx CLI IPC listen EPERM on /tmp/tsx-1000/43.pipe. Original log/exit preserved as verification-tests.txt / verification-tests.exit. No source correction, dependency change or suppressed test.
- Equivalent standard loader command: npm_config_cache=/tmp/appearance-748-npm-cache node --import tsx --test --test-concurrency=1 $(cat /tmp/appearance-748-evidence/test-files.txt). Exit 0: 245 passed, 0 failed, 0 skipped, 0 cancelled; 102691.666634 ms. Twelve complete files, no test-name filters. verification-tests-node-import.txt preserved.
- After tests completed: node_modules/.bin/tsc -p apps/zenx/tsconfig.web.json --noEmit --pretty false. Exit 0, web typecheck passed. No claim of node typecheck.
- After web typecheck completed: npm_config_cache=/tmp/appearance-748-npm-cache npm run build:prepared --workspace @zen/zenx. Exit 0. Exactly one build in own worktree, not frozen worktree. Existing npm http-proxy warning and version notice only; no build failure.
- node_modules/.bin/prettier --check apps/zenx/src/renderer/src/styles.css apps/zenx/src/renderer/src/theme.css apps/zenx/test/appearance.test.ts: exit 0, all three passed.
- git diff --check d52b6857 HEAD: exit 0.

The existing dependency overlay is linked from an ignored local node_modules directory; .cache/.vite-temp not linked, avoiding shared build-cache writes. No installs or shared dependency edits.

## Exact tested manifest

Selected complete Appearance + theme policy, both Settings files and all eight reading/history/fullscreen files from committed round-six-combined-test-files.txt:
apps/zenx/test/appearance.test.ts
apps/zenx/test/theme-source-policy.test.ts
apps/zenx/test/settings-interaction.test.ts
apps/zenx/test/model-settings.test.ts
apps/zenx/test/thread-reading-state.test.ts
apps/zenx/test/conversation-read-state.test.ts
apps/zenx/test/thread-history-cache.test.ts
apps/zenx/test/thread-history-pages.test.ts
apps/zenx/test/fullscreen-primary-conversation.test.ts
apps/zenx/test/fullscreen-primary-native-fixture.test.mjs
apps/zenx/test/transcript-fullscreen-width.test.ts
apps/zenx/test/virtual-transcript-layout.test.mjs

## Own build

Renderer assets: index-C_vYvWd1.js and index-CXgpHEdG.css. Build contains 60 JS/CJS/MJS/CSS/HTML files. Sorted path + NUL + file-sha256 + newline fingerprint: fdb9b4eeb1b212bf5291ceed131d02810203315808d96c466110e119e312e9b7. Full manifest: ../evidence/appearance-followup-20261109/verification-final-build-manifest.json. Source diff and changed-file manifest retained beside it.

## Limits

Original earlier run logs were unavailable; used committed round-six-combined-validation.md, round-six-combined-test-files.txt and round-six-combined-build-fingerprints.json as the prior evidence, without rewriting old failure evidence or rerunning all old tests. Prior 506/507 run plus Project test correction is not retroactively a clean aggregate pass. This verification does not run the whole App/5000-turn test, repository aggregate, hosted CI, native interactions/fullscreen acceptance or assistive technology. No push, PR, merge, accounts or network side effects performed.
