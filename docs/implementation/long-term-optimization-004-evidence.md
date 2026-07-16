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

Round: 3
Issue: long-term-optimization-004 Replace snapshot rewrites with durable append-only ThreadJournal
Reviewer context: fresh
Reviewer edits: none
Reviewed branch: codex/long-term-optimization-004
Base revision/diff scope: e40dd493ce5e1d40e1fdc100e2862e5d34ad2fcf -> bfd58e79161987bebf8cd9030b8c6b3c7793b3c9
Standards Review blocking: Shutdown still waited on non-cooperative model/tool async iterator next calls, so the producer barrier was not cancellation-bounded.
Standards Review non-blocking: none
Standards Review missing evidence: deterministic non-cooperative model and tool iterator shutdown cases.
Spec Review blocking: Late iterator values could be appended after abort, violating the shutdown terminal/cancellation boundary.
Spec Review non-blocking: none
Spec Review missing evidence: no late Item/write/notification after releasing a pending iterator after close or interrupt.
Local tracker state decision: Rework
State decision reason: The two findings are one material abort-consumption boundary defect.

## Codex Worker Note

Round: 4
Issue: long-term-optimization-004 Replace snapshot rewrites with durable append-only ThreadJournal
Local tracker state transition: Rework -> Agent Review
Branch: codex/long-term-optimization-004
PR URL: not configured
Base revision/diff scope: bfd58e79161987bebf8cd9030b8c6b3c7793b3c9; accepted Round 3 abort-aware iterator boundary, focused tests, and append-only evidence/tracker only
Summary of behavior delivered: Added the shared abortable async-iterator consumption boundary used by model-gateway and tool-runtime. It races next() against AbortSignal, abandons pending or later values after abort, and invokes iterator return best-effort without awaiting non-cooperative cleanup. Abort reaches ThreadManager promptly, which emits exactly one durable canceled terminal Item before journal close.
Final scope summary: Rework findings for issue 004 only. No UI feature implementation, projection work, module moves, dependency/gate work, or issue 005+ work.
Changed files/modules: src/abortable-async-iterator.ts; src/model-gateway.ts; src/tool-runtime.ts; test/app-server-journal.test.ts; abort lifecycle expectations in test/thread-manager.test.ts, test/approval-race.test.ts, and test/app-server-transport.test.ts; this evidence/tracker
Tests added/updated: test/app-server-journal.test.ts now uses deterministic model and tool iterators whose pending next() and return() never resolve before shutdown. It proves close/interrupt settle without release; later release produces no Item, write, or notification; cancellation persists and replay excludes late delta/output. Existing interruption assertions now require canceled terminalization without post-abort tool/approval events.
Acceptance criteria status: All original 004 criteria remain complete. Round 3 finding 1 complete: both model and tool consumption share an abort-aware next boundary and do not await non-cooperative return cleanup. Finding 2 complete: close/interrupt terminalize promptly, preserve pre-abort facts plus one canceled terminal record, and reject all later iterator values without writes or notifications.
Commands run and results: npx vitest run test/app-server-journal.test.ts test/model-gateway.test.ts test/tool-runtime.test.ts test/thread-journal.test.ts passed (24 tests); npm test passed (31 files, 202 tests); npm run typecheck passed; npm run typecheck:web passed; npm run build passed; git diff --check passed.
Validation log paths: none
Required check status or local-check handoff reason: Required local gates passed. No GitHub remote/check handoff is configured.
Evidence links/paths: docs/implementation/long-term-optimization-004-evidence.md; docs/implementation/long-term-optimization-tracker.md
Decisions made: Abort is a control-flow boundary, not a tool/model error fact: model/tool loops rethrow the shared abort sentinel so ThreadManager alone records the canceled terminal lifecycle Item.
Standards notes: The async-iterator module centralizes the non-obvious cancellation rule and prevents it from drifting between model and tool adapters. Item-first lifecycle ownership remains in ThreadManager.
Reviewer notes: Ready for a new fresh-context reviewer; no self-review performed.
Open questions: none
Known residual risks: Best-effort iterator return cleanup can leave an external adapter resource running after the server has safely detached; adapter implementations should honor AbortSignal and iterator return for resource reclamation. Journal filename length and compaction remain outside issue 004.
Blocker or context escalation details: none

## Codex Review Note

Round: 2
Issue: long-term-optimization-004 Replace snapshot rewrites with durable append-only ThreadJournal
Reviewer context: fresh
Reviewer edits: none
Reviewed branch: codex/long-term-optimization-004
Base revision/diff scope: a4d0fbcede189d0af56669b46f336ca4b78f35d0 -> e40dd493ce5e1d40e1fdc100e2862e5d34ad2fcf
Standards Review blocking: AppServer close could snapshot event tails while active turns still emitted Items, allowing journal close before producers quiesced.
Standards Review non-blocking: none
Standards Review missing evidence: deterministic active-turn shutdown and rejection of new requests while closing.
Spec Review blocking: ThreadManager filtered replay failures without thread ids from the public result.
Spec Review non-blocking: none
Spec Review missing evidence: invalid/undecodable filename outcome retained with valid replay.
Local tracker state decision: Rework
State decision reason: Both accepted findings are material shutdown and corruption-observability requirements.

## Codex Worker Note

Round: 3
Issue: long-term-optimization-004 Replace snapshot rewrites with durable append-only ThreadJournal
Local tracker state transition: Rework -> Agent Review
Branch: codex/long-term-optimization-004
PR URL: not configured
Base revision/diff scope: e40dd493ce5e1d40e1fdc100e2862e5d34ad2fcf; accepted Round 2 shutdown barrier and complete replay-failure propagation only
Summary of behavior delivered: AppServer atomically enters closing state, rejects all new requests, invokes ThreadManager producer shutdown, then drains persistence tails and closes the journal. ThreadManager cancels queued work, declines pending approvals, aborts active turns, and waits for its final turn tails before persistence shutdown. Replay now reports every file failure, including invalid filenames without a thread id.
Final scope summary: Rework findings for issue 004 only. No UI feature implementation, projection work, module moves, dependency/gate work, or issue 005+ work.
Changed files/modules: src/app-server.ts; src/thread-manager.ts; src/thread-journal.ts; test/app-server-journal.test.ts; this evidence/tracker
Tests added/updated: test/app-server-journal.test.ts adds deterministic active-turn close race with a late model delta, persisted cancellation/replay verification, no post-close request acceptance, and broker pending cleanup. The replay test now retains an invalid legacy filename alongside a valid journal and an interior-corrupt journal.
Acceptance criteria status: All original 004 criteria remain complete. Round 2 finding 1 complete: close establishes a producer barrier before persistence tails/journal close, cancels work and approvals, and rejects requests while closing/closed. Finding 2 complete: thread/list retains every replay failure with path/context and optional threadId while valid threads remain available.
Commands run and results: npx vitest run test/app-server-journal.test.ts test/thread-journal.test.ts test/app-server.test.ts passed (17 tests); npm test passed (31 files, 201 tests); npm run typecheck passed; npm run typecheck:web passed; npm run build passed; git diff --check passed.
Validation log paths: none
Required check status or local-check handoff reason: Required local gates passed. No GitHub remote/check handoff is configured.
Evidence links/paths: docs/implementation/long-term-optimization-004-evidence.md; docs/implementation/long-term-optimization-tracker.md
Decisions made: close waits on ThreadManager's producer lifecycle before taking the persistence-tail barrier; malformed non-journal files are explicit replay failures rather than ignored compatibility artifacts.
Standards notes: Shutdown preserves Item-first terminalization and concentrates cancellation/quiescence in ThreadManager. Persistence completion is sequenced after producers stop, eliminating write-after-close races.
Reviewer notes: Ready for a new fresh-context reviewer; no self-review performed.
Open questions: none
Known residual risks: If a provider ignores AbortSignal forever, shutdown waits for that producer by design; production model/tool adapters must honor cancellation. Journal filenames can be long for unusually long thread IDs; compaction is outside issue 004.
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
