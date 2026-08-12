# ZenX bundled provider release inputs

`provider-lock.json` is the release lock. The release assembly fetches only the
listed official archives, verifies both npm SRI and SHA-256, extracts bounded
assets, adds the pinned Node runtime, and writes the final `manifest.json`.
The raw provider payloads are intentionally not committed; a release artifact
must be reproducible offline after this deterministic provisioning step.

The assembled artifact includes `LICENSE`/`THIRD_PARTY_NOTICES.txt`, provider
versions, runtime version, platform, archive hashes, and the final manifest
digest. Missing network, archive, runtime, browser payload, or integrity
verification is an explicit build failure; there is no PATH fallback in bundled
mode.
