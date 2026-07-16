# Long-Term Optimization 004 Evidence

## Codex Worker Note

Round: 1
Issue: long-term-optimization-004 Replace snapshot rewrites with durable append-only ThreadJournal
Local tracker state transition: Ready -> Agent Review
Branch: codex/long-term-optimization-004
PR URL: not configured
Base revision/diff scope: 80b6a22a0d082838305059de9eb313120b27f6fa -> d2581918187bb35a65a8ab436e94fda4da6c7027; persistence seam/adapter, ThreadManager/AppServer commit-flush integration, focused tests, and issue evidence/tracker only
Summary of behavior delivered: Replaced legacy FileThreadStore snapshot replacement with FileThreadJournal versioned JSONL Item envelopes. Creation uses exclusive write plus sync; each thread has an independent serialized writer; terminal notifications wait for flush; failures are typed and sticky; replay returns retained-success/corruption outcomes and repairs truncated final tails.
Final scope summary: Issue 004 only. No UI, projection, module group, dependency/gate, or issue 005+ implementation changes.
Changed files/modules: src/thread-journal.ts; src/app-server.ts; src/thread-manager.ts; src/provider-runtime.ts; src/index.ts; src/dogfood-acceptance.ts; persistence and affected lifecycle tests
Tests added/updated: test/thread-journal.test.ts covers real-temp durable replay, reversible filenames, independent queues, sticky failures/close aggregate, final-tail recovery/interior corruption, and 500-delta linear records/bytes. test/app-server-journal.test.ts covers terminal publish after flush. Snapshot-store tests were removed as intentional breaking-format removal; affected lifecycle expectations were updated.
Acceptance criteria status: versioned JSONL and no legacy decoding complete; creation durability complete; per-thread queue/one encode path complete; terminal publication flush ordering complete; sticky failures and aggregate close complete; tail recovery/interior corruption outcomes complete; 500-delta O(n) regression complete.
Commands run and results: npx vitest run test/thread-journal.test.ts test/app-server.test.ts test/app-server-journal.test.ts passed (13 tests); npm test passed (31 files, 197 tests); npm run typecheck passed; npm run build passed; git diff --check passed after final whitespace fix.
Validation log paths: none
Required check status or local-check handoff reason: Current required local gates passed. Web gates were not run because protocol/proxy behavior was not changed; existing transport and Web-adjacent unit tests passed in npm test. No GitHub remote/check handoff is configured.
Evidence links/paths: docs/implementation/long-term-optimization-004-evidence.md; docs/implementation/long-term-optimization-tracker.md
Decisions made: thread.created is a durable internal Item, intentionally excluded from snapshot/UI projection; FileThreadJournal replay is the explicit corruption-reporting public seam; legacy .json snapshots are not decoded.
Standards notes: ItemList remains authoritative; ThreadSnapshot is replay/projection only. The journal is a single deep persistence adapter behind a small interface with explicit failure behavior.
Reviewer notes: Ready for fresh-context review; no self-review performed.
Open questions: none
Known residual risks: Journal file names are reversible base64url and therefore can be long for unusually long thread IDs; no compaction policy is part of issue 004.
Blocker or context escalation details: none

## Codex Review Note

Round: 1
Issue: long-term-optimization-004 Replace snapshot rewrites with durable append-only ThreadJournal
Reviewer context: fresh
Reviewer edits: none
Reviewed branch: codex/long-term-optimization-004
Base revision/diff scope: 80b6a22a0d082838305059de9eb313120b27f6fa -> a4d0fbcede189d0af56669b46f336ca4b78f35d0
Standards Review blocking: AppServer queued persistence operation failures were swallowed by the ordering tail and could return successful operations.
Standards Review non-blocking: none
Standards Review missing evidence: public faults for create, append, and terminal flush; byte-offset short-write behavior.
Spec Review blocking: Replay failures were filtered before AppServer, so corruption was not visible through the public result; string slicing by bytesWritten could corrupt multibyte JSONL records.
Spec Review non-blocking: none
Spec Review missing evidence: valid-plus-corrupt startup outcome.
Local tracker state decision: Rework
State decision reason: All three accepted findings are material durability and explicit-failure requirements.

## Codex Worker Note

Round: 2
Issue: long-term-optimization-004 Replace snapshot rewrites with durable append-only ThreadJournal
Local tracker state transition: Rework -> Agent Review
Branch: codex/long-term-optimization-004
PR URL: not configured
Base revision/diff scope: a4d0fbcede189d0af56669b46f336ca4b78f35d0; accepted review findings only: AppServer exact operation failures, replay result visibility, UTF-8 short writes, focused tests, and append-only evidence/tracker
Summary of behavior delivered: AppServer now keeps a swallowed ordering tail separately from each exact operation promise and stores the first thread persistence failure, returning typed PERSISTENCE_FAILURE responses for create, append, terminal flush, and subsequent same-thread requests. Provider startup carries journal corruption outcomes to thread/list and known-corrupt thread/read. JSONL records are encoded once as UTF-8 Buffers and written with byte-offset subarrays.
Final scope summary: Rework findings for issue 004 only. No UI feature implementation, projection work, module moves, dependency/gate work, or issue 005+ work.
Changed files/modules: src/app-server.ts; src/app-server-protocol.ts; src/thread-manager.ts; src/provider-runtime.ts; src/thread-journal.ts; web/src/demo-app-server.ts protocol fixture; focused persistence/protocol tests; this evidence/tracker
Tests added/updated: test/app-server-journal.test.ts now covers create, append, and terminal flush faults, sticky observability, no terminal notify after failed flush, and valid/corrupt startup listing. test/thread-journal.test.ts adds multibyte injected short-write replay verification. Transport/demo fixtures carry empty persistenceFailures results.
Acceptance criteria status: All original 004 criteria remain complete. Review finding 1 complete: exact failures are typed and sticky through AppServer. Finding 2 complete: thread/list exposes contextual corruption failures while valid threads load; known corrupt reads return typed errors. Finding 3 complete: Buffer byte-offset partial writes preserve multibyte content.
Commands run and results: npx vitest run test/thread-journal.test.ts test/app-server-journal.test.ts test/app-server.test.ts passed (16 tests); npm test passed (31 files, 200 tests); npm run typecheck passed; npm run typecheck:web passed because thread/list protocol changed; npm run build passed; git diff --check passed.
Validation log paths: none
Required check status or local-check handoff reason: Required local gates passed. No GitHub remote/check handoff is configured.
Evidence links/paths: docs/implementation/long-term-optimization-004-evidence.md; docs/implementation/long-term-optimization-tracker.md
Decisions made: Runtime persistence failures use PERSISTENCE_FAILURE with the journal cause message; startup corruption uses THREAD_JOURNAL_CORRUPTION with path, record number, and identifiable thread id. Ordering tails remain swallowed only for scheduling, never for caller-visible settlement.
Standards notes: Failure state is explicit and per-thread; valid replay results remain available without suppressing corrupt-file evidence. Buffer writes preserve the adapter's UTF-8 byte invariant.
Reviewer notes: Ready for a new fresh-context reviewer; no self-review performed.
Open questions: none
Known residual risks: Journal filenames can be long for unusually long thread IDs; compaction is outside issue 004.
Blocker or context escalation details: none
