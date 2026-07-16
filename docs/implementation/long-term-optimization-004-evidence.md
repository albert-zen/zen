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
