# Later local delivery: preparation only, not permission to execute now

The user's one-time local replacement permission applies **only after** the entire
cloud implementation, prior feature/bug regressions, migration/recovery and packaged
acceptance have completed. This document creates no thread, accesses no computer,
and performs no installation. Root owns the eventual authorization gate and actively
reads any later child results; a child cannot be assumed to send a special parent API
notification. No paid model APIs are authorized at any stage.

## Before any local operation

- Review exact cloud-tested source SHA, package hash, provenance, dependency/licenses,
  runtime/OS support and all explicit test boundaries. A source-only test pass is not
  a packaged application pass. Do not rebuild a different untested variant locally.
- Keep missing/unimplemented coverage visible, including OCR (AX budget is not OCR),
  actual locked/screen-off operations, focus stealing/background behavior and activity
  indications. The user's machine cannot be used to fill missing cloud acceptance.
- Have a verified rollback package and complete data/profile backup plan. Retain old
  app version/source identity, package hash, full profile layout and original source
  file counts/hashes. No irreversible real-data action without separately established
  authority; unknown schema or permissions stop and return to root.

## If and only if the gate is explicitly released later

1. Preflight the exact existing application/version/profile without guessing the
   executable, schema or machine. Preserve unsaved drafts. Gracefully stop only that
   application and confirm its Host/model/tool/file I/O has drained. Never kill all
   Electron/Node processes. A busy file or new authority requirement stops the work.
2. Back up application and complete profile while stopped; validate the copies and
   restoration. Rehearse migration on a **copy**, offline, with logs as source truth.
   Preserve unknown effects; never replay tool work or fabricate historical requests.
3. Install only the exact cloud-validated package hash. Initial smoke tests use an
   isolated synthetic profile with no real credentials/accounts/plugins/scheduled
   tasks/IM receivers. Merely launching a production profile can trigger work and
   paid calls, so it is not an authorized test shortcut.
4. Report exact results in the same child thread. Root reads them, fixes failures in
   cloud, validates the new package again, and only then coordinates any further
   authorized local action. No local hotpatching or silent retries with new variants.
5. On failure, stop new writes. Preserve all new ItemList/Trace/product-state bytes
   before restoring the matching stopped backup into a separate profile. Do not
   overlay an old binary onto new schema files or discard new history.

There is no unconditional “200% safe” claim. The release decision requires explicit
passed, untested, simulated, platform-limited and unimplemented coverage, with any
remaining critical gap resolved before user-machine access.
