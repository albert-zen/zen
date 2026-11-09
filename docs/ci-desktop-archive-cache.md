# Desktop archive cache

This build-only cache stores complete Electron ZIP and RTK tarball files, never
node_modules, extracted applications, temporary downloads, transaction directories
or a remote checksum manifest. A cache hit is not test or native acceptance.

## Checksum authority

The Electron projection in `scripts/desktop-archives.lock.json` was obtained from
`https://registry.npmjs.org/electron/-/electron-43.2.0.tgz`. The complete tarball's
SHA512 was verified against the root package-lock integrity before extracting
`package/checksums.json`. The checked-in projection contains the ordinary Electron
ZIP entries from that authenticated file. It was not inferred from downloaded ZIP
bytes or an unverified installed cache. Before installation the helper requires
exact agreement with the root lock's version, official package URL and integrity.
Before saving it additionally compares the installed package's version and
checksum. Updating Electron requires repeating this procedure; a mismatched pin
fails explicitly rather than silently reusing the old ZIP.

RTK retains the existing audited v0.48.0 archive and extracted-binary SHA256 pins;
its preparation script and the CI cache now consume the same lock. Its existing
transactional acquisition and extracted-binary checks remain unchanged.

Each Actions key includes platform, architecture, version and archive SHA256.
Only the exact complete archive path is restored/saved, with no prefix restore
keys. Restored bytes are untrusted and rehashed; corrupt ordinary files are
reported and removed so the original downloader can obtain a fresh archive.
Symlink/nonordinary paths fail closed. Saving independently rehashes bytes even
when an installation or an earlier cache-restore action succeeded.

The Electron installer's `electron_config_cache` and packager's `cacheRoot` share
one workspace-local directory in CI. Outside CI their existing default remains.
Alternate mirrors, remote checksum overrides and target overrides are explicitly
unsupported by this cache helper, rather than being reported as verified hits.

## Workflow coverage and costs

Electron 43.2.0 has no npm `postinstall`: its `index.js` lazily invokes
`install.js` on first `require("electron")` when the executable is missing.
Installing its npm package does not mean a ZIP was downloaded. The 32 wired jobs
are possible entry points, not 32 proven archive consumers. For example, PR quick
units and the WinApp adapter smoke can finish without using Electron. A cold
restore followed by `save: miss` in those jobs is expected and creates no cache;
it is not evidence of a verified hit, download failure or path mismatch.
No eager Electron download is added merely to manufacture a save. A real consumer
that fails its cold download also has nothing valid to save; partial bytes remain
ineligible. Cache usefulness must be established from a real consumer's verified
archive save and subsequent restored-byte verification, not job success alone.

The composite action restores before each normal root `npm ci` and independently
validates/saves after work in all 32 existing root-install job definitions across 20
workflows (matrix executions add more jobs). This includes the nine main CI
potential consumers, including Android's root install, plus app-shot, native information,
file navigation, user questions and Windows diagnostics. The contract discovers
all ordinary root install entries so adding one without cache wiring fails. The
existing `--ignore-scripts` selection/fast-feedback installs and the mobile-only
install are not changed. RTK restoration is enabled
only on darwin-arm64, matching the existing preparation script. Other targets
save no RTK archive. Provider archives retain their separate existing cache.

Existing triggers, lane-selection conditions, validation commands, timeouts and
required-result gates are unchanged. New restore/save invocations each have a
five-minute upper bound; a failed test is still failed even if a verified archive
can be saved afterward. No application, browser or native test is retried. The
separate user-question workflow's pre-existing retired macOS runner is outside
this cache change and remains a limitation, not an acceptance claim.

Logs and job summaries distinguish the Actions key hit from independent archive
byte validation and identify the checksum authority. Restoration does not trust
Actions hit status. Invalid bytes never qualify for saving. Exact-hit immutable
caches cannot be overwritten; a corrupt remote entry remains rejected on later
runs until its key is invalidated. No broad fallback key is used.

Cache transport and hashing add work, while a valid hit removes an external
release-archive request. Concurrent first runs can all miss; Actions cache scope,
retention, eviction and PR branch isolation still apply. No hosted time saving or
resolution of an observed HTTP 504 is claimed from local synthetic tests. A cold
or evicted cache still uses the original downloader and can fail with 504.

This change adds no HTTP retries. A narrowly bounded archive GET retry could be
implemented separately, but Electron's installer and packager need one consistent
downloader policy; retrying the entire `npm ci`, build or smoke command would also
repeat unrelated work or effects and is not used here.

## Local installer validation and test isolation

In addition to synthetic downloader tests, the locked Linux x64 `install.js` was
run against the official 43.2.0 archive in an isolated package copy. It created
the planned 124,904,101-byte ZIP and passed the pinned SHA256. A second fresh
installer with `fetch` disabled succeeded from that cache, and the packager's
actual `downloadArtifact` call reused it without a network request. No Electron
application was launched. This is local Linux installer evidence, not a hosted
Actions warm-hit or cross-platform claim.

Temporary CLI fixtures explicitly remove inherited `electron_config_cache`,
`GITHUB_ENV`, `GITHUB_OUTPUT` and `GITHUB_STEP_SUMMARY`. Their regression supplies
hosted-like values and verifies that the real runner files are not changed.
Production cache-root validation remains fail-closed.
