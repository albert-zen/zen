# Image preparation UI evidence: capture blocked

Status: **not visually accepted locally; CI capture pending**.

The production target is PR #674, published commit
`d584ef32944cda0c6b5b54b7a7b56ecffc4319b9`, local equivalent
`8e767d356593da9f2bf60336adf59da50cecc9f7`, tree
`4ae2919e17cf5bbe8267aed66c7e40ad1994e88f`. Production source is unchanged.
That was the original blocked local attempt, whose raw receipts are retained
unchanged. Subsequent feature/integration commits must not reuse that original
tree label. The builder now derives the actual checked-out HEAD and tree and
records exact source/bundle hashes. The fixture displays that derived revision.
This checkpoint adds only synthetic fixture/capture support, contract tests,
the bounded capture step in the existing Ubuntu ZenX job, and this account of
the current evidence boundary. It does not change product or Core source.

## What was checked

- The actual production `ThreadView` consumes synthetic persisted-style
  `itemList` snapshots through its normal `ImagePreparationNotice` slot.
  The fixture imports the real projection, translations and CSS. It contains
  no real image payloads, user trace, configuration, credentials or inbox data.
- The fixture and production renderer typecheck together. The 10 focused
  notice/projection tests pass. The fixture bundles successfully; its builder
  emits source and bundle SHA-256 hashes in `source.json`.
- The existing full-App acceptance launchers were inspected. They explicitly
  require macOS or Windows; this Linux fixture does not claim to run them.

## What did not run

The intended screenshot scenes are English/light and Chinese/dark at
1100 × 820 and 390 × 600. Intended interactions cover pointer expansion,
Enter/Space toggling, duplicate/latest-sample filtering, removal after
compaction or a later media-unavailable marker, retained-only selection and
switching to another Thread. These browser assertions have **not executed**.

The existing Ubuntu ZenX CI job now runs this capture after its existing
dependency and authenticated CJK-font prerequisites. The step has a three-minute
limit and uses an existing installed Chrome/Chromium executable, following the
repository's established candidate order. A missing executable fails with a
retained prerequisite diagnostic. The existing artifact upload action runs even
on failure and retains the source manifest, screenshots if any, and lifecycle
receipt. No permissions, secrets, schedules or existing coverage are changed.

The supported cloud browser could not reach the execution workspace's
loopback fixture server (`ERR_CONNECTION_REFUSED`). An attempt to bind the
resulting browser error tab was stopped when its `chrome-error://` current
protocol was rejected by the browser URL policy.

A separate, explicitly approved bounded local test then launched installed
Chromium with its sandbox enabled and an isolated synthetic profile. Chromium
aborted before DevTools/page readiness with:

```text
process_singleton_posix.cc:297
socket() failed: Operation not permitted (1)
signal=SIGABRT
```

The raw lifecycle receipt records `phase: devtools-port`, `captureStatus:
failed`, `cleanupComplete: true`, and no retained profile. The acceptance
manifest records `ok: false`, empty `cases` and empty `screenshots`. No browser
security controls were disabled, and no alternative executor was used to
avoid this restriction. Capture retries stopped at this boundary.

## Reproduce on a permitted capture runner

```sh
node apps/zenx/scripts/build-image-preparation-preview.mjs "$EVIDENCE_DIR"
node apps/zenx/scripts/capture-image-preparation-preview.mjs "$EVIDENCE_DIR"
```

`EVIDENCE_DIR` and `TMPDIR` should be outside any checkout. `CHROME_PATH` may
identify the runner's installed Chromium/Chrome executable. The capture script
does not download a browser or disable Chromium's sandbox. Successful execution
must produce `acceptance.json` with `ok: true`, screenshots and a successful raw
lifecycle receipt. Inspect those screenshots and link the actual images in the
PR before treating the repository's screenshot requirement as satisfied.

Even a successful fixture capture is production-component browser evidence,
not full App, packaged, native Host, macOS, Windows, real attachment persistence
or live model-dispatch acceptance.
