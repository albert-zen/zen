# Owned Trace source fence (not activated in Domain)

This checkpoint coordinates source publication only. It does not cache verified source history, grant model/tool dispatch, repair files, weaken fsync, or activate incremental Domain admission.

## API and ordering

FileTraceStore.openOwnedSources(realOwner, exactJournalDirectory, threadId) returns a closeable session. session.run(action) enters one canonical Trace-directory / Thread source lane and supplies an expiring scope with generation, explicit full read(), and appendSource(event). The scope accepts only this Thread's runtime_item/context_source facts and bypasses only the already-held source lane, not validation, the existing Trace queue, file sync or final directory sync.

Lock order: Domain operation (future integration) -> source lane -> Trace queue -> semantic append. Public source record/batch/import acquires the source lane BEFORE entering the Trace queue. A callback must use scope.appendSource, never recursively invoke public source record or await session.close from within the scope. No callback acquires Domain operation. Ordinary observation records retain their existing queue and do not wait for the source lane.

Public record and recordBatch snapshot before waiting; authoritative imports snapshot the input array and hold the source lane for the whole import. An import still preserves individual record validation and degraded receipts. Queued work begun before owner registration drains through the same lane. Canonical realpath identity shares coordination across store instances; owned sessions also pin Trace-root inode and require a real exact-namespace journal owner. Different active journal owners cannot register the same Trace Thread.

Accepted scope writes are joined even if the callback forgets to await them. Expired scopes reject new writes. Any nondurable source receipt or owner loss following accepted source writes is unknown, never success. Session close drains accepted runs before retiring its registration; the Domain owner must close all sessions/capabilities before releasing its OS lock.

Generation changes on source writes and failed capture. It is only an invalidation signal. Capture gaps retain existing recovery semantics, not a new permanent-disable policy. Idle unowned lanes retire. Warm coordination itself performs no historical payload read; only explicit scope.read performs the existing full strict read.

## Remaining activation gates

No Domain imports this session yet. A verified source projection must still establish and track exact source-file stamps under real writes, preserve strict explicit reads, handle external mutation and cold/reopen state, and perform source-backed incomplete-semantic-tail recovery without effect replay. Owned assertRecoverySafe must use that same verified contract or ordinary admission will still reread history. The actual AppServer ordinary-send test must count full source reads and semantic rewrites across admission, not merely test a low-level append handle.

Eight real-file tests cover snapshot timing, cross-instance source exclusion, observations progressing independently, queued-before-registration lock ordering, scope expiry, exact owner/Thread, ignored-write drain, capture-failure invalidation, import/batch exclusion and owner loss. Hosted execution is required; no local test pass is claimed.
