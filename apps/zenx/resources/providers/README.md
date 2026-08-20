# ZenX bundled provider release inputs

`provider-lock.json` is the release lock. The release assembly fetches only the
listed official archives, verifies both npm SRI and SHA-256, extracts bounded
assets, adds the pinned Node runtime and browser archive, and writes the final
`manifest.json`.
The raw provider payloads are intentionally not committed; a release artifact
must be reproducible offline after this deterministic provisioning step.

The assembled artifact includes `LICENSE`/`THIRD_PARTY_NOTICES.txt`, provider
versions, runtime version, platform, archive hashes, and the final manifest
digest. Missing network, archive, runtime, browser payload, or integrity
verification is an explicit build failure; there is no PATH fallback in bundled
mode.

Pinned archives are acquired as bounded streams and atomically published into a
SHA-256-addressed immutable cache after verification. Every cache hit is hashed
again before use; partial, oversized, timed-out, or mismatched responses never
become cache entries. Provider assembly writes only to the caller's private run
staging directory.

The browser archive URL, Playwright revision, version, executable path, and
per-platform SHA-256 are part of the same release lock. Assembly acquires that
archive through the verified artifact cache, extracts it directly, and never
invokes Playwright's downloader. The final provider manifest pins both the
browser executable and a deterministic digest of the complete extracted
payload; bundled-provider selection and launch verification re-hash them. The
manifest explicitly excludes only Playwright's root `DEPENDENCIES_VALIDATED`
host-validation state file; all archive entries and any other additions remain
inside the fail-closed digest boundary. The complete directory is re-hashed at
selection and immediately before each browser launch; later commands against
that running browser continue to re-hash the provider, runtime, browser
executable, and ordinary companion assets without rescanning the large tree.

The Playwright provider also records every shipped transitive package in
`provider-lock.json` with its exact tarball URL, npm SRI, and SHA-256. Assembly
validates npm's resolved entries against those pins and writes the deterministic
`DEPENDENCY-LOCK.json`; npm's platform-specific generated lockfile is not the
release trust anchor.
