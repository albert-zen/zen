# Owned semantic append foundation (not activated)

This experiment adds no Domain admission fast path yet. Durable Trace facts and the existing semantic ItemList remain the only recovery authority. The capability is not dispatch permission and cannot be constructed from caller-supplied history, offsets, or file stamps.

## Boundary

A real StorageWriterOwnership for the exact journal directory may open one capability per owner/file. The factory itself reads and validates the existing complete JSONL prefix and records private identity/stat metadata and an ID set. The initial array returned to callers is a separate disposable copy. A new batch is snapshotted and validated before its ordered append. Every append checks the live owner, real directories, nonaliased file identity and exact expected size/mtime/ctime. It writes only new bytes and file-syncs; the namespace entry already exists and no replacement is performed. Any uncertain write, sync, close, or detected file change poisons this handle. No rollback, truncation, replay, or repair occurs here. Closing drains accepted writes before releasing the capability claim; callers must close capabilities before releasing the owner.

Default FileItemListStore behavior and all readonly paths are unchanged. DomainThreadJournal does not import this module.

## Activation prerequisites (separate checkpoints)

- A verified per-thread projection is reconstructed from source facts and semantic items once under the owned journal operation, not supplied by the capability caller.
- Each new source fact must be durable before its semantic suffix append; its admission receipt waits for both.
- Public Trace.record/importRecords authoritative writes and any failed capture invalidate that projection. Import, migration, appendContext, owner loss, close, and unexpected filesystem change cannot retain stale state.
- Explicit owned recovery alone may repair an incomplete semantic tail, only when the exact partial bytes match the missing suffix derived from accepted source facts. Readonly inspection never truncates. Unrelated corruption remains a failure.
- Crash/unknown-write recovery, cross-instance ownership, exact prefixes, no historical payload reads or full rewrites on warm admission, and native long-thread A/B must pass before enabling this foundation in Domain admission.

The implementation follows DeepSeek Harness's validated-new-batch, lifetime-owner, append-and-fsync pattern, not its live-event buffering or retry-on-rollback behavior. Reference: deepseek-ai/deepseek-harness ce7073d51254c26cd63b22a60835b8f948deb447, session-persistence-jsonl/src/storage.ts and index.ts.

Stat identity/size/time checks are out-of-band change fences, not a cryptographic proof against arbitrary historical-byte tampering with forged metadata; explicit public reads retain full validation. This foundation does not redefine supported editing or repair behavior.
