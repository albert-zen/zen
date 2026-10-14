# Offline package size report

Run from the repository root with an **existing, immutable, unpacked** package or
provider-assembly resources directory. No build, download, extraction, install or
execution of payloads is performed. This is the measurement slice of #95, not an
optional-provider installer or a lightweight release mode.

```sh
node scripts/report-zenx-package-size.mjs \
  --root /path/to/existing/resources \
  --platform linux-x64 > /tmp/package-size.json
```

For an unpacked full application, point `--root` at its outer directory and set
`--providers-relative resources/providers` (or the actual slash-separated path,
e.g. `Contents/Resources/providers` on macOS). Paths are case-sensitive. The
remainder includes everything outside that assembly subtree; it is only a Core
size measurement when the selected root actually contains the complete app.
ASAR contents are not unpacked or attributed. Do not place the report inside the
measured root.

Optional `--provider-lock /path/to/provider-lock.json` selects the lock belonging
to that build. Optional `--cache /path/to/cache/artifacts` reads existing
`sha256/<digest>` files using the assembly cache convention. The explicit
`--platform` selects pins; it does not certify that the package targets that
platform. Never analyze a cache or package while it is being modified. This tool
is not a hostile-filesystem sandbox or an atomic snapshotter.

## Reading the JSON

- The existing assembly directories provide non-overlapping logical components:
  shared `runtime`, `playwright-cli` including its pinned dependencies,
  `playwright-browsers`, `microsoft-winapp-cli`, provider metadata, and application
  remainder. No second pack manifest or duplicated dependency registry is added.
- `logicalBytes` sums regular-file lengths per directory entry. Hardlinks count
  once per name here. `symlinkBytes` is separate; targets are listed and **never
  traversed**, including dangling, external and directory links.
- `allocatedBytes` sums filesystem-reported `st_blocks * 512`, including directory
  and link allocation, deduplicated by device/inode within each counter. It is
  `null` on Windows or when trustworthy allocation/identity is unavailable.
  Components sharing hardlinks can overlap in allocated bytes, so do not sum
  component allocations; use `total`. Sparse files can have much larger logical
  lengths. Reflinks, filesystem compression, metadata and external hardlinks mean
  this is reported allocation, not guaranteed physical usage or reclaimable disk.
- An absent component is `null`, not zero savings. An empty directory has known
  zero logical bytes. Missing manifest is `null`; present manifest shows schema,
  provider IDs and SHA-256 of its bytes, explicitly `verification: not-performed`.
  It does not verify executables, directory asset digests or readiness.
- Archive `compressedBytes` is present only after an existing cache file matches
  its lock SHA-256. Missing, corrupt and nonregular entries stay unknown and are
  never repaired. Archives are acquisition bytes, not the final compressed app:
  the Node archive contains files assembly does not copy, for example. Do not add
  repeated digests to estimate network transfer, or infer ZIP/DMG savings by
  subtracting unpacked component sizes. `estimatedSavingsBytes` stays `null`.
- Results have stable ordering and no timestamps. Filesystem-dependent allocation
  is expected to vary across machines. Unreadable/malformed inputs, special files
  and more than 200,000 entries fail explicitly rather than emit a partial total.

The synthetic regression fixture measures 5 logical bytes of runtime, 2 of
Playwright, 7 of additional Chromium, 4 of WinApp and 3 of application remainder,
plus the actual manifest bytes. These are intentionally tiny test values, **not
production measurements**. Real release sizes and achievable savings remain
unknown until this is run against a named release artifact and matching lock.

## Boundaries and future compatibility

ZenX's default shared Browser uses Electron. The extra Playwright/Chromium backend
is a distinct payload; missing it must not imply that built-in browsing is absent.
This report changes neither package assembly nor provider selection.

A future optional-backend proposal can extend the existing provider lock with a
versioned compatibility constraint (ZenX/provider protocol plus platform/arch),
while keeping the existing executable/runtime/asset digests as integrity authority.
This is a proposal only, not a new schema or an implemented readiness check.
Public default artifact, install ownership, trusted acquisition, update/rollback
UX and WinApp participation still need a product decision. #95 remains open.

## Official references and comparison

[Node filesystem stats](https://nodejs.org/api/fs.html#class-fsstats) distinguish
file lengths, links, inode identity and allocation metadata; the
[Linux stat reference](https://man7.org/linux/man-pages/man3/stat.3type.html) specifies
512-byte `st_blocks` units and sparse-file differences. We retain these separate
quantities instead of labeling a sum of file lengths as disk usage.
[Playwright's browser contract](https://playwright.dev/docs/browsers) requires
version-matched browser binaries. Zen therefore reports its existing pinned
browser revision and archive digests rather than proposing arbitrary system Chrome
as a smaller compatible replacement. None of these sources establish Zen's actual
release savings.
