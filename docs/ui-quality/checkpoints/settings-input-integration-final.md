# Final numeric-input / PR #748 integration verification

Status: complete for this verifier’s non-native scope. The increment integrated cleanly; all 252 combined focused/bounded tests, final node/web types, the single prepared build, formatting, protected-source checks and exact-tree archive recovery passed. The final build has been handed to the native worker. Previous 489 evidence remains unchanged.

## Exact source and scope

- Worktree: `/workspace/scratch/72527d3ea90a/ui-quality-scroll-integration`.
- Clean previous version: `4893830a2139e074e9091d5d5a22651bb9e03032`, tree `a60532bbfb805d4b17abb761e33ff05062a78fa8`.
- Only requested input `1ebcb0501f0e5f3d8886b6e8288921adff78fb68` was cherry-picked, without conflicts, as **`bebe9276ac303f0d2f85cbf7008c3d8711e7b80c`**.
- **Final source tree: `746ff97626902500d8ae5f73cba6d706a4da9910`.**
- Production delta is only the Maximum tool rounds handler changing from `onChange` to `onInput`, with two explanatory comment lines. The accompanying 54 test lines add two validity-transition regressions. No other source was modified by this verifier.
- Exact `SettingsView.tsx` SHA-256: `2d48a680ad3e9bd9a989bf53b1f31956a99478ada6a0664d9284dd33c957401f`.
- Exact `settings-interaction.test.ts` SHA-256: `02c645b9d51c350a5a351015b200505ec38ca0542f43e28272ac611cf2e7360d`.
- Both files match the supplied hashes and exact `1ebcb050` Git blobs.

The lead/native worker reported that real Chromium could expose both unfinished `-` and a cleared numeric input as the same empty value, leaving React's deduplicated `onChange` path unaware of the validity transition. This increment observes each input event. Its added tests model the validity-only transition to empty/Unlimited and recovery to valid `18`, including Apply and preservation of another dirty setting. They are synthetic tests, not a claim of native typing validation.

The native worker confirmed its 147 focused tests and node/web typecheck session 9617 had exited 0 before this verifier started heavy combined checks. No CUA, remote operation, push or PR was performed here. The native worker owns the final real-input and bounded live-scroll journeys.

## Previous evidence preserved

All prior `settings-scroll-integration-*` artifacts and both `ui-quality-final-settings-integration` archives remain unchanged. Their SHA-256 values are recorded and checked in `settings-input-integration-prior-artifacts.sha256`. The old fixed ref still points to `4893830a`.

The new build necessarily replaces this worktree's generated output. Previous immutable reports/fingerprints remain evidence for the older source and captured native observations, not claims about the current output directory. Older successful native scopes and the discovered invalid-clear failure are not rewritten or relabeled as final-source acceptance.

## Verification

- The new run uses the same 16 focused Settings/model/provider and scroll/Sidebar files as the previous integration. Exact manifest: `settings-input-integration-test-files.txt`.
- The same eight bounded App regressions are selected by explicit name pattern. No full App or known 5000-turn case is run.
- Types and prepared build run serially after the test stages. All npm-invoking stages use the isolated writable `/tmp/ui-quality-scroll-npm-cache`.
- Formatting passed on both changed files: `settings-input-integration-format.log`.
- All 14 non-CSS #748 files are identical to `0d6a106614db9135b66b4d6fd443f1e664b57d36`; the complete 36-line fullscreen CSS postimage is retained exactly, SHA-256 `ceed6394260debd57588877b8a733d8bbfe3dbf88d7a29e8ef2b7debb91357a6`.
- `.github/workflows/ci.yml` remains identical to main `d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a`. The separate fullscreen workflow remains identical to #748.
- Exact source and protected comparisons: `settings-input-integration-source.metadata`, `settings-input-integration-source.sha256`, and `settings-input-integration-protected.log`.

### Final outcomes on `bebe9276`

- **244/244 focused tests passed**, zero failed/cancelled/skipped, 103.13 seconds, across the same 16 files. The two new numeric-validity regressions account for the increase from the previous 242. Full output and exact command/source/timestamps: `settings-input-integration-tests.log` and `.metadata`.
- **8/8 bounded App tests passed**, zero failed/cancelled/skipped, 7.73 seconds. Full output and exact name pattern: `settings-input-integration-app.log` and `.metadata`.
- **252 passing tests in total, all on this exact final tree.** Earlier-version results are not added to this count.
- **Node and web TypeScript checks passed**, exit 0, `2026-11-09T18:49:04Z` to `2026-11-09T18:51:16Z`. `npm run typecheck:prepared --workspace @zen/zenx`; evidence: `settings-input-integration-typecheck.log` and `.metadata`.
- **Prepared production build passed**, exit 0, `2026-11-09T18:51:16Z` to `2026-11-09T18:52:58Z`, after typechecks ended. `npm run build:prepared --workspace @zen/zenx`; evidence: `settings-input-integration-build.log` and `.metadata`.
- Build ready at **2026-11-09 18:52:58 UTC**; fingerprint captured at `2026-11-09T18:52:59.080349+00:00` and handed to the native worker immediately. No further source edit or rebuild is planned here.
- Protected files, fullscreen CSS, CI, supplied source hashes, whitespace and clean-worktree state were rechecked after the build: `settings-input-integration-final-state.log`.
- All prior 489 report/log/fingerprint/archive hashes passed again after the build: `settings-input-integration-prior-artifacts-verification.log`.

### Final source/build fingerprint

- Full inventory: `settings-input-integration-build-fingerprints.json`, SHA-256 `d4b94895beb2ff3a37c10a14ca023f315616bbefe0b9da05d01a82322a425062`.
- **640 production source files**, fingerprint `423f63603bd11117e74c91765a2d92c2f7171e7ac33cb6a7fdce988a8832151d`.
- **60 built JS/CJS/MJS/CSS/HTML files**, fingerprint `8ac22504f95551ccea66697bfff73af820adfeb77d43a5586c3f2f60a3c01d52`. Preload CJS files are included; maps and external dependencies are excluded.
- Algorithm: SHA-256 of sorted UTF-8 records consisting of relative path, NUL, file SHA-256 and newline. Complete generated-file hashes are also in `settings-input-integration-build.sha256`.
- Final renderer: `apps/zenx/out/renderer/assets/index-DJHKR4sn.js`, SHA-256 `8cb6638fb1ae1681d3ff7a12b9e30575db59bd80251df21597f36d7d0e9c12e2`.
- Renderer entry HTML: `9f75c01ec1285e229bc8a979c5530451a52161b8dae4dece77182180b0f06b44`.
- Main entry: `3c3927332a1352aa8d07b832bdd3c8a87742d7508278e4a3663e5ed059b7778f`; preload entry: `9adcc3bec4de755c0e4758db2fca95cc212277f7b5dc94ad2705b1ac5f7750b7`.

No check in the assigned final scope failed. The npm `http-proxy` environment-config warning remains non-fatal. The complete App/5000-turn case, full aggregate, cross-platform, CI, native fullscreen, hidden-window and release acceptance were not run here. Final real-input and bounded native-scroll evidence belongs to the separate native worker and must identify this exact source/build.

## Recovery artifacts

Fixed local-only ref: `refs/checkpoints/ui-quality-final-input-integration` → `bebe9276ac303f0d2f85cbf7008c3d8711e7b80c`.

Baseline: `d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a`.

- `/workspace/shared/ui-quality-evidence/ui-quality-final-input-integration.bundle`
  - 135,333 bytes.
  - SHA-256 `c0555d5e5b6659cb735ba464c51002a9987b287745febb4f65867293b94f1421`.
- `/workspace/shared/ui-quality-evidence/ui-quality-final-input-integration.patch`
  - 342,915 bytes.
  - SHA-256 `c5150461788da9db607dffedfb70952e5bb2bb073a8d133ef8867b8a886ad2ff`.

`git bundle verify` passed. This is an incremental bundle requiring the baseline and its ancestors `238d0abb9f6da00cc25aa0e90e76a08277397303` and `5778d01be38327143641c5495a31c191f3143744`. Use a full baseline-capable clone, not a shallow clone containing only the baseline object.

The full binary patch was generated with `git diff --binary --full-index --no-renames` from the baseline. A separate temporary index initialized from the baseline accepted it and produced **exactly `746ff97626902500d8ae5f73cba6d706a4da9910`**. The real index was not changed: SHA-256 `b00abad6741f45c6180c34a65aff4fc2162d2d00be2423105dc6336a166152b8` before and after. Verification output, prerequisite list, prior-evidence checks and sizes are in `settings-input-integration-recovery.log`.

The bundle restores the original commit/history; the patch restores its exact tracked source tree without recreating original commit identities. Neither archive includes dependencies, generated build output or native profile data. Separately packaged UI/evidence fixtures remain separate; no docs-only commit was imported into this integration.

### Restore the original commit

Set paths to the saved evidence directory, an existing full clone and a new restoration directory:

```sh
archive_dir=/absolute/path/to/saved/evidence
repo=/absolute/path/to/full-upstream-clone
restored=/absolute/path/to/new-input-integration
bundle="$archive_dir/ui-quality-final-input-integration.bundle"
git -C "$repo" bundle verify "$bundle"
git -C "$repo" fetch "$bundle" \
  refs/checkpoints/ui-quality-final-input-integration:refs/heads/recovered-final-input-integration
git -C "$repo" worktree add --detach "$restored" \
  refs/heads/recovered-final-input-integration
git -C "$restored" rev-parse HEAD 'HEAD^{tree}'
```

Expected commit: `bebe9276ac303f0d2f85cbf7008c3d8711e7b80c`; tree: `746ff97626902500d8ae5f73cba6d706a4da9910`.

### Restore or independently verify the patch

To restore the tracked source in another new worktree:

```sh
patched=/absolute/path/to/new-input-patch-restoration
git -C "$repo" worktree add --detach "$patched" \
  d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a
git -C "$patched" apply --index --binary \
  "$archive_dir/ui-quality-final-input-integration.patch"
git -C "$patched" write-tree
```

To reproduce the exact-tree proof without touching a real index or checkout:

```sh
tmp=$(mktemp -d)
GIT_INDEX_FILE="$tmp/index" git -C "$repo" read-tree \
  d7f93b83f54ba873b61f19bd72ac3a6f6010aa4a
GIT_INDEX_FILE="$tmp/index" git -C "$repo" apply --cached --binary \
  "$archive_dir/ui-quality-final-input-integration.patch"
GIT_INDEX_FILE="$tmp/index" git -C "$repo" write-tree
rm -f "$tmp/index"
rmdir "$tmp"
```

Both methods must print tree `746ff97626902500d8ae5f73cba6d706a4da9910`.

### Reproduce checks after normal repository setup

After the restored checkout's normal dependency and first-party-plugin preparation, run from its root:

```sh
node --import tsx --test --test-reporter=tap --test-concurrency=2 \
  $(cat "$archive_dir/settings-input-integration-test-files.txt")
node --import tsx --test --test-reporter=tap --test-concurrency=1 \
  --test-name-pattern='late canonical queue ID settles only|delivery check|unconfirmed Send keeps|send presentation shows honest pending|real App (dock|popover) pending Send keeps historical rows' \
  apps/zenx/test/app-project-picker-interaction.test.ts
npm run typecheck:prepared --workspace @zen/zenx
npm run build:prepared --workspace @zen/zenx
```

Run memory-heavy stages serially and use an explicitly writable npm cache when required by the environment.
