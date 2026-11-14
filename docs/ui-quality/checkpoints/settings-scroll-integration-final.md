# Final Settings / PR #748 integration verification

Status: complete for the assigned non-native scope. All 250 focused/bounded tests, final node/web typechecks, the single prepared production build, formatting, protected #748 comparisons and final clean-worktree checks passed. The recovery bundle verifies, and the complete binary patch reconstructs the exact final tree without changing the real index. The finished build has been handed to the native worker.

## Exact source and isolation

- Detached worktree: `/workspace/scratch/72527d3ea90a/ui-quality-scroll-integration`.
- Clean starting commit: `7c5813f474c3bace74fd30fed9fd0f0b75abe431`; tree `4a24efab6c84e0880fe4214a295414979cc60438`.
- Only requested Settings input `0b166ecd4b35a7d75595e691edd5dcc3027a14e6` was cherry-picked as `92bf9c8ea39528776624e516b74e2e592721b53a`, followed by input `901e135def108be6ddf01b834be40bdf2f5afbff` as `4893830a2139e074e9091d5d5a22651bb9e03032`.
- **Final commit: `4893830a2139e074e9091d5d5a22651bb9e03032`.**
- **Final source tree: `a60532bbfb805d4b17abb761e33ff05062a78fa8`.**
- Both cherry-picks were clean. The only new changed paths are `SettingsView.tsx`, `settings-interaction.test.ts`, and the one-line Settings contract addition in `apps/zenx/docs/ui-ux.md`. No conflict resolution or implementation rewrite was performed here.
- Main remains `d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a`; #748 remains `0d6a106614db9135b66b4d6fd443f1e664b57d36`, open/draft and unmerged according to the lead's fresh GitHub readback. This verifier did not repeat that remote query.
- No docs-only `bd27` commit or #748 changes were merged into the UI branch. No other worktree source, older acceptance report, remote branch, PR, or CI state was changed. This task used no CUA or native app launch.
- Heavy checks began only after the Settings native worker confirmed that the UI branch's final node/web typecheck had exited 0. The checks and build below run serially, with test-file concurrency limited to 2.

Exact Settings hashes, also independently compared against commit `901e135d`:

- `apps/zenx/src/renderer/src/SettingsView.tsx`: `aa4e6439671f796cf2080ad96f8c7a118c4e7315124d287a3bfa43185fe723e1`
- `apps/zenx/test/settings-interaction.test.ts`: `fd5c93a324f0613385e66d5ec0579aaefb601de9e05068a204e1e0a927167746`

Source metadata and the three changed-file hashes are in `settings-scroll-integration-source.metadata` and `settings-scroll-integration-source.sha256`.

## Completed checks

All current checks use the exact final commit/tree above:

- **242/242 focused tests passed**, zero failed/cancelled/skipped, 69.69 seconds, across 16 files. This includes the complete Settings interaction suite, model settings, provider model admission/deletion, conversation/Thread reading state, history cache/pages, fullscreen visibility/geometry source and fixture contracts, transcript width/layout, and Sidebar presentation/latency/responsive/resource races. Exact files: `settings-scroll-integration-test-files.txt`; full results and command/source/timestamps: `settings-scroll-integration-tests.log` and `.metadata`.
- **8/8 bounded App regressions passed**, zero failed/cancelled/skipped, 8.50 seconds. Covers exact pending-delivery reconciliation, same-watermark/newer cached windows, usable/unavailable/failed checks, explicit unknown-send recovery, honest admission feedback, and stable dock/popover historical grids. Exact name filter and results: `settings-scroll-integration-app.metadata` and `.log`.
- **250 current-tree tests passed in total.** These are not mixed with earlier-tree results.
- Prettier passed on all three newly changed files: `settings-scroll-integration-format.log`. Whitespace check passed.
- All **14 non-CSS #748 paths remain byte-for-byte identical** to #748. Its complete **36-line fullscreen CSS postimage**, including context, is preserved exactly; SHA-256 `ceed6394260debd57588877b8a733d8bbfe3dbf88d7a29e8ef2b7debb91357a6`.
- `.github/workflows/ci.yml` is byte-for-byte identical to main `d7f93b83`. The separate #748 fullscreen workflow remains identical to #748.
- Full comparisons: `settings-scroll-integration-protected.log`.

The complete App test file and its known 5000-turn resource-heavy case were deliberately not run. No full repository test/aggregate, cross-platform, CI, or native acceptance is claimed here. The separate native worker owns native actions and will use this combined output; earlier `7c5813f4` screenshots are not relabeled as Settings-final evidence.

## Final prepared build

- **Node and web types passed**, exit 0, 2026-11-09 18:33:02–18:34:36 UTC. Command: `npm run typecheck:prepared --workspace @zen/zenx`. Evidence: `settings-scroll-integration-typecheck.log` and `.metadata`.
- **Prepared production build passed**, exit 0, 18:34:36–18:35:09 UTC, after typechecks finished. Command: `npm run build:prepared --workspace @zen/zenx`. Evidence: `settings-scroll-integration-build.log` and `.metadata`.
- The build and complete fingerprint were ready at **18:35:10 UTC** and immediately handed to the native worker. No further build or source edit is planned by this verifier.
- Fingerprint inventory: `settings-scroll-integration-build-fingerprints.json`, SHA-256 `ea441f8774f6a28fed3d517003617752daeb4f18d5c0c09cc98ade6efb2f0e18`.
- **640 production source files**, fingerprint `bc8d4d6e72dd5ae3afe083fdd037571ec78c9434ff3d7df43c7b7d4bd6a6263f`.
- **60 built JS/CJS/MJS/CSS/HTML files**, fingerprint `a566f52c92d7fbf1948b71e0fc69b4e741f5df1db33080a57c51c529b066ae24`. Unlike the earlier 58-file JS/CSS/HTML fingerprint, this scope explicitly includes preload CJS files.
- The fingerprint algorithm is SHA-256 of sorted UTF-8 records: relative path, NUL, file SHA-256, newline. Full generated-file hashes are also recorded in `settings-scroll-integration-build.sha256`.
- Final protected-file/CSS/CI, whitespace and clean-worktree checks were repeated after the build at 18:36:05 UTC: `settings-scroll-integration-final-state.log`.
- npm emitted its existing unknown `http-proxy` environment-config warning and an available-version notice; no TypeScript diagnostic or build failure occurred. npm was not updated.

Primary built artifacts:

- `apps/zenx/out/main/index.js`: `3c3927332a1352aa8d07b832bdd3c8a87742d7508278e4a3663e5ed059b7778f`
- `apps/zenx/out/preload/index.cjs`: `9adcc3bec4de755c0e4758db2fca95cc212277f7b5dc94ad2705b1ac5f7750b7`
- `apps/zenx/out/renderer/index.html`: `eede4a6c1d3200dfc767e5a1ab32ef4764c5eb8891c80afbe32cca6138dbc8c0`
- `apps/zenx/out/renderer/assets/index-Bj1UaKW-.css`: `6d6ea1aa58ac585994ae0565c876ee4ab9922a9efc88e632fd4b674b49326cea`
- `apps/zenx/out/renderer/assets/index-VL64IrlM.js`: `027bf0cf2e74947250e548b5263ca81a3fb96eca42608f8e1e508b1a44f3c2f3`

The prepared build replaces only this isolated worktree's generated `apps/zenx/out`. Earlier reports and captured hashes remain historical evidence for their exact source versions; they are not claims about the replaced current output directory. No dependency installation or shared dependency mutation is performed.

## Verified recovery artifacts

Fixed **local-only** ref: `refs/checkpoints/ui-quality-final-settings-integration` → `4893830a2139e074e9091d5d5a22651bb9e03032`. It has not been pushed.

Baseline: `d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a`.

- `/workspace/shared/ui-quality-evidence/ui-quality-final-settings-integration.bundle`
  - 134,146 bytes.
  - SHA-256: `4969a1140d13bbd348948e9ed4152ca4f3a3c8f95bddd2536001d6c9297d3ae8`.
- `/workspace/shared/ui-quality-evidence/ui-quality-final-settings-integration.patch`
  - 340,323 bytes.
  - SHA-256: `7d4fa2b2a26dca7af479363b1b5b1799f75a84ef9f527398b3997dab2c3900c5`.

The bundle is incremental, not a standalone clone. `git bundle verify` passed and lists these prerequisite commits:

1. `d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a`
2. `238d0abb9f6da00cc25aa0e90e76a08277397303`
3. `5778d01be38327143641c5495a31c191f3143744`

The latter two were verified as ancestors of the baseline, so a complete clone containing its history has all prerequisites. A shallow clone containing only the baseline object may not. The bundle restores the original commit history; the patch restores the exact tracked source tree but does not recreate original commit identities. Neither contains dependencies, native profile data or generated build output.

The patch was produced with `git diff --binary --full-index --no-renames` from the baseline. Applying it to an independent temporary index initialized from that baseline produced **exactly `a60532bbfb805d4b17abb761e33ff05062a78fa8`**. The real integration index remained unchanged, SHA-256 `116caa8b40e8e8cadd70673cd11fc3f4109e507089a50314b783eaa82513158d` before and after. Full output: `settings-scroll-integration-recovery.log`.

### Reproduce the independent-index patch verification

This verifies the patch against the baseline without touching a checkout or the real index. Set `repo` to a clone containing the baseline and `archive_dir` to the saved evidence directory:

```sh
tmp=$(mktemp -d)
GIT_INDEX_FILE="$tmp/index" git -C "$repo" read-tree   d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a
GIT_INDEX_FILE="$tmp/index" git -C "$repo" apply --cached --binary   "$archive_dir/ui-quality-final-settings-integration.patch"
GIT_INDEX_FILE="$tmp/index" git -C "$repo" write-tree
rm -f "$tmp/index"
rmdir "$tmp"
```

Expected tree: `a60532bbfb805d4b17abb761e33ff05062a78fa8`.

### Restore the exact commit from the bundle

Use a full upstream clone with the three prerequisites. Set the paths below to the saved archive directory, existing clone and a new destination directory:

```sh
archive_dir=/absolute/path/to/saved/evidence
repo=/absolute/path/to/full-upstream-clone
restored=/absolute/path/to/new-restored-integration
bundle="$archive_dir/ui-quality-final-settings-integration.bundle"

git -C "$repo" bundle verify "$bundle"
git -C "$repo" fetch "$bundle" \
  refs/checkpoints/ui-quality-final-settings-integration:refs/heads/recovered-final-settings-integration
git -C "$repo" worktree add --detach "$restored" \
  refs/heads/recovered-final-settings-integration
git -C "$restored" rev-parse HEAD 'HEAD^{tree}'
```

Expected output is commit `4893830a2139e074e9091d5d5a22651bb9e03032` and tree `a60532bbfb805d4b17abb761e33ff05062a78fa8`.

### Restore the same source tree with the patch

Use a different new destination and the same baseline-capable clone:

```sh
patched=/absolute/path/to/new-patch-restoration
git -C "$repo" worktree add --detach "$patched" \
  d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a
git -C "$patched" apply --index --binary \
  "$archive_dir/ui-quality-final-settings-integration.patch"
git -C "$patched" write-tree
```

Expected tree: `a60532bbfb805d4b17abb761e33ff05062a78fa8`. The worktree is intentionally staged on the baseline; the patch does not claim to reconstruct the original HEAD.

### Reproduce the verification after normal repository setup

After the restored checkout's normal dependency and first-party-plugin preparation, run from its root. The external file manifest accompanies this report/log set:

```sh
node --import tsx --test --test-reporter=tap --test-concurrency=2 \
  $(cat "$archive_dir/settings-scroll-integration-test-files.txt")
node --import tsx --test --test-reporter=tap --test-concurrency=1 \
  --test-name-pattern='late canonical queue ID settles only|delivery check|unconfirmed Send keeps|send presentation shows honest pending|real App (dock|popover) pending Send keeps historical rows' \
  apps/zenx/test/app-project-picker-interaction.test.ts
npm run typecheck:prepared --workspace @zen/zenx
npm run build:prepared --workspace @zen/zenx
```

Run memory-heavy checks and the build serially. In restricted environments, use an explicitly writable npm cache as this verification did (`npm_config_cache=/tmp/ui-quality-scroll-npm-cache`).
