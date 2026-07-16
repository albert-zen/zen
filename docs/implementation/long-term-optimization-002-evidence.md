# Long-Term Optimization 002 Evidence

## Codex Worker Note

Round: 1
Issue: long-term-optimization-002 - Derive lifecycle from Items and schedule turns FIFO
Local tracker state transition: In Progress -> Agent Review
Branch: `codex/long-term-optimization-002`
PR URL: not configured; local-branch workflow
Base revision/diff scope: exact base `05477f7b54829a10d9fd79e18ca9e5247f1bd418`; scoped to ThreadManager lifecycle/scheduling, protocol lifecycle projection, the AgentLoop terminal guard, corresponding tests, two manager-approved downstream expectation updates, tracker, and this evidence document
Summary of behavior delivered: Lifecycle Items are authoritative for turn/thread snapshots, same-thread turns execute FIFO with one active model execution, different threads execute concurrently, retries join the tail, interrupts cancel only the active turn while the queue continues, and startup repairs queued/running turns into recoverable failed facts.
Final scope summary: Removed ThreadManager's mutable turn list/status truth; added per-thread scheduling tails that carry execution work only; appended visible `turn.queued`, `turn.failed`, `turn.canceled`, and `turn.repaired` facts; retained AgentLoop as the `turn.started`/`turn.completed` writer while preventing completion facts after execution errors; projected turns, item IDs, errors, and ThreadStatus from Items; emitted compatibility lifecycle notifications from those projections.
Changed files/modules: `src/thread-manager.ts`; `src/app-server-protocol.ts`; `src/agent-loop.ts`; `test/thread-manager.test.ts`; `test/app-server.test.ts`; `test/app-server-protocol.test.ts`; `test/agent-loop.test.ts`; manager-approved expectation-only changes in `test/agent-interaction-session.test.ts` and `test/app-server-transport.test.ts`; `docs/implementation/long-term-optimization-tracker.md`; `docs/implementation/long-term-optimization-002-evidence.md`
Tests added/updated: Added public regressions for the reproduced same-thread `maxActive=2` race, cross-thread concurrency, queued Item ordering/projection, AppServer same-thread FIFO, explicit failure/cancel Items, queue continuation after interrupt, completion/interrupt race authority, retry-tail ordering with recovered input, queued/running startup repair, protocol lifecycle projection, and AgentLoop error terminal behavior; updated existing lifecycle sequences for visible `turn.queued`.
Acceptance criteria status: PASS - two same-thread starts are FIFO with model max concurrency one; PASS - different threads execute concurrently; PASS - queued/started/completed/failed/canceled/repaired facts are Items; PASS - ThreadSnapshot turns/itemIds/errors/status derive from Items; PASS - retry joins FIFO; PASS - interrupt targets active turn and queue continues; PASS - startup repairs queued/running turns to recoverable failed facts; PASS - no mutable ThreadManager turn list/status remains.
Commands run and results: RED `npm test -- test/thread-manager.test.ts -t "queues same-thread turns FIFO"` failed with `maxActive: 2` and both turns started before first completion; GREEN the same command passed after per-thread scheduling; cross-thread tracer `npm test -- test/thread-manager.test.ts -t "different threads"` passed with `maxActive: 2`; completion/interrupt race RED returned `canceled` after observing completed and GREEN returned `completed`; final targeted suites passed (`thread-manager` 13, `app-server` 6, protocol 4, `agent-loop` 10); final `npm run typecheck` passed; final `npm test` passed 27 files/160 tests; final `npm run build` passed; `git diff --check` passed (line-ending warnings only).
Validation log paths: none; command output captured in the worker task
Required check status or local-check handoff reason: All configured required local checks pass. GitHub checks/PR are not configured because this repository uses local-branch mode.
Evidence links/paths: `docs/implementation/long-term-optimization-002-evidence.md`; tests listed above
Decisions made: Used one promise tail per thread as scheduler bookkeeping without lifecycle state; made `toThreadSnapshot` the lifecycle projector; kept AgentLoop authoritative for started/completed and made ThreadManager authoritative for queued/failed/canceled/repaired; made an existing completed Item win over a racing late interrupt; manager approved expectation-only scope expansion to `test/agent-interaction-session.test.ts` and `test/app-server-transport.test.ts` for the visible queued Item and item-derived ordering, with no session/transport source changes.
Standards notes: Followed tracer-bullet TDD through public interfaces; preserved ItemList as source of truth; removed parallel mutable lifecycle state; kept scheduling behavior local behind the existing ThreadManager interface; did not weaken gates or add dependencies.
Reviewer notes: Review exact diff from `05477f7b54829a10d9fd79e18ca9e5247f1bd418`; verify lifecycle projection transitions and queue races. Issue 001 may share `test/app-server-transport.test.ts`; the integration agent will resolve that expectation-only diff while preserving issue 001 assertions conceptually.
Open questions: none
Known residual risks: Local persistence still stores whole ThreadSnapshot files and is intentionally unchanged for issue 004. The manager identified a shared integration diff in `test/app-server-transport.test.ts` with issue 001; integration owns conflict resolution.
Blocker or context escalation details: none

## Codex Review Note

Round: 2
Issue: long-term-optimization-002 - Derive lifecycle from Items and schedule turns FIFO
Reviewer context: fresh
Reviewer edits: none
Reviewed branch: `codex/long-term-optimization-002`
Base revision/diff scope: `7d09be81505944930fa1b198a959c6d227186328..2ad9e1f1a0b285b8acd1b0fd0c8797745d73a59f`
Standards Review blocking: none
Standards Review non-blocking: none
Standards Review missing evidence: public observer-rejection regressions for both `turn.failed` and `turn.canceled` terminal paths, including caller rejection, exactly one terminal Item, FIFO continuation, and active-turn cleanup through public behavior
Spec Review blocking: none
Spec Review non-blocking: none
Spec Review missing evidence: direct proof that failed and canceled terminal observer rejection preserve lifecycle authority and do not stall subsequent queued work
Local tracker state decision: Rework
State decision reason: Behavioral review passes, but the two terminal paths need bounded public regression evidence before handoff. Tracker transitioned `Agent Review -> Rework -> In Progress` for Worker Round 3.

## Codex Worker Note

Round: 3
Issue: long-term-optimization-002 - Derive lifecycle from Items and schedule turns FIFO
Local tracker state transition: In Progress -> Agent Review
Branch: `codex/long-term-optimization-002`
PR URL: not configured; local-branch workflow
Base revision/diff scope: Round 3 evidence work from `2ad9e1f1a0b285b8acd1b0fd0c8797745d73a59f`; changes limited to public ThreadManager tests, this append-only evidence document, and the issue 002 tracker row/state
Summary of behavior delivered: Added direct public evidence that observer rejection on both failed and canceled terminal paths rejects the caller without conflicting terminal facts, preserves FIFO continuation, and leaves no active turn after queued work completes.
Final scope summary: Closed all Review Round 2 missing evidence with no production code changes and no issue 001 changes.
Changed files/modules: `test/thread-manager.test.ts`; `docs/implementation/long-term-optimization-002-evidence.md`; `docs/implementation/long-term-optimization-tracker.md`
Tests added/updated: Added `turn.failed` and `turn.canceled` terminal observer rejection regressions through `ThreadManager.startTurn`, `ThreadManager.interruptTurn`, lifecycle snapshots, and a queued successor turn.
Acceptance criteria status: PASS failed path - caller promise rejects with `ItemObserverError`, turn 1 has exactly one `turn.failed` terminal Item, turn 2 executes after failure and completes, lifecycle order is failed before turn 2 started, and final `interruptTurn` reports no active turn; PASS canceled path - caller promise rejects with `ItemObserverError`, turn 1 has exactly one `turn.canceled` terminal Item, queued turn 2 starts only after cancellation and completes, and final `interruptTurn` reports no active turn; PASS - all prior issue 002 acceptance criteria and Round 2 regressions remain green.
Commands run and results: Focused new regressions `npm test -- test/thread-manager.test.ts -t "failed terminal observer rejection|canceled terminal observer rejection"` passed 2 tests; focused ThreadManager suite passed 19 tests; `npm run typecheck` passed; full `npm test` passed 27 files/166 tests; `npm run build` passed; `git diff --check` passed with line-ending warnings only.
Validation log paths: none; command output captured in the worker task
Required check status or local-check handoff reason: All configured required local checks pass. GitHub checks/PR are not configured because this repository uses local-branch mode.
Evidence links/paths: `docs/implementation/long-term-optimization-002-evidence.md`; `test/thread-manager.test.ts`
Decisions made: Kept production behavior unchanged because both missing-evidence tests passed against the Round 2 implementation; used only public methods and snapshots to prove lifecycle facts, FIFO continuation, and active-turn cleanup.
Standards notes: Tests assert observable lifecycle and scheduling behavior without private-state access or new mocks; no quality gate, dependency, or unrelated module changed.
Reviewer notes: Re-review `2ad9e1f1a0b285b8acd1b0fd0c8797745d73a59f..HEAD`; Round 2 reported no behavioral blocking or non-blocking findings, so this diff should contain evidence/tests and tracker notes only.
Open questions: none
Known residual risks: none identified beyond previously recorded issue 002 integration notes
Blocker or context escalation details: none

## Codex Review Note

Round: 1
Issue: long-term-optimization-002 - Derive lifecycle from Items and schedule turns FIFO
Reviewer context: fresh
Reviewer edits: none
Reviewed branch: `codex/long-term-optimization-002`
Base revision/diff scope: `05477f7b54829a10d9fd79e18ca9e5247f1bd418..7d09be81505944930fa1b198a959c6d227186328`
Standards Review blocking: (1) `queueTurn` publishes `turn.queued` before reserving the FIFO scheduler slot, so a synchronous reentrant observer can reserve first and execute turn 2 before turn 1. (2) `InMemoryItemList.append` commits before reporting observer failure, but scheduling happens only after append returns, so a committed queued Item can be stranded without start/terminal lifecycle. (3) An observer failure after `turn.completed` commits is caught as execution failure and appends `turn.failed`, creating conflicting terminal facts instead of preserving first-terminal-wins.
Standards Review non-blocking: none
Standards Review missing evidence: public regressions for reentrant FIFO, committed queue append rejection, terminal observer rejection, rejection queue continuation, and ID-collision behavior
Spec Review blocking: Same-thread FIFO is not preserved under synchronous reentrancy; committed queued facts are not guaranteed eventual execution or terminal failure; terminal lifecycle projection can be contradicted by a later failed Item after completion.
Spec Review non-blocking: none
Spec Review missing evidence: RED/GREEN evidence for each blocking race and the listed queue continuation/ID-collision cases
Local tracker state decision: Rework
State decision reason: The findings are bounded issue 002 lifecycle/scheduling races with clear public regression seams. Tracker transitioned `Agent Review -> Rework -> In Progress` for Worker Round 2.

## Codex Worker Note

Round: 2
Issue: long-term-optimization-002 - Derive lifecycle from Items and schedule turns FIFO
Local tracker state transition: In Progress -> Agent Review
Branch: `codex/long-term-optimization-002`
PR URL: not configured; local-branch workflow
Base revision/diff scope: Round 2 rework from `7d09be81505944930fa1b198a959c6d227186328`; changes limited to `src/thread-manager.ts`, public ThreadManager regressions, this append-only evidence document, and the issue 002 tracker row/state
Summary of behavior delivered: Scheduler slots are now reserved before visible queued Items are published, committed queue Items retain execution after observer rejection, first terminal lifecycle facts cannot be contradicted by later manager terminal Items, rejection does not stop later queued work, and generated Item IDs remain unique under collisions.
Final scope summary: Fixed all three blocking review findings and all five missing evidence areas without changing AppServer, protocol, AgentLoop, transport, session, or issue 001 source.
Changed files/modules: `src/thread-manager.ts`; `test/thread-manager.test.ts`; `docs/implementation/long-term-optimization-002-evidence.md`; `docs/implementation/long-term-optimization-tracker.md`
Tests added/updated: Added public regressions for synchronous reentrant enqueue FIFO, committed `turn.queued` observer rejection with retained execution and later FIFO continuation, terminal observer rejection with sole-terminal preservation and queue continuation, and turn/run/Item generator collisions.
Acceptance criteria status: PASS - same-thread FIFO remains max concurrency one under synchronous reentrancy; PASS - different threads remain concurrent; PASS - every committed queued fact retains reserved execution after observer rejection; PASS - later queued work continues after queue and terminal rejection; PASS - first terminal Item wins and no conflicting terminal Items are appended; PASS - observer/notification failure is reported through the public promise rejection; PASS - turn/run/Item IDs remain unique under colliding generators; PASS - all Round 1 issue 002 acceptance criteria remain green.
Commands run and results: Reentrant FIFO RED executed `turn-2, turn-1`, then GREEN executed `turn-1, turn-2`; committed queue rejection RED timed out with the committed first turn stranded, then GREEN completed turns 1 and 2 FIFO; terminal observer RED resolved a projected failed turn instead of rejecting, then GREEN rejected with the observer error while preserving only `turn.completed` and completed the next queued turn; ID collision RED produced 20 Items with 10 unique IDs, then GREEN produced 20 unique IDs; final `npm test -- test/thread-manager.test.ts` passed 17 tests; final AppServer/protocol/AgentLoop/transport targeted suites passed 27 tests; final `npm run typecheck` passed; final `npm test` passed 27 files/164 tests; final `npm run build` passed; final `git diff --check` passed with line-ending warnings only.
Validation log paths: none; command output captured in the worker task
Required check status or local-check handoff reason: All configured required local checks pass. GitHub checks/PR are not configured because this repository uses local-branch mode.
Evidence links/paths: `docs/implementation/long-term-optimization-002-evidence.md`; `test/thread-manager.test.ts`
Decisions made: Reserve each per-thread promise-tail slot before calling synchronous Item observers; rely on microtask scheduling so `turn.queued` commits before execution starts; preserve the reservation when append reports a committed observer failure; centralize manager terminal appends behind a first-terminal check; rethrow observer/notification failures after any terminal projection exists; wrap new-thread Item ID generation with the existing collision-resistant generator.
Standards notes: Each review finding was reproduced through the public ThreadManager interface before the minimal fix; ItemList remains authoritative; the scheduler still carries execution bookkeeping only; no quality gate or unrelated module was changed.
Reviewer notes: Re-review `7d09be81505944930fa1b198a959c6d227186328..HEAD`, focusing on synchronous reentrancy, committed append error semantics, first-terminal-wins, rejection continuation, and collision handling.
Open questions: none
Known residual risks: A caller whose queued Item observer rejects receives that rejection even though the committed turn retains execution; this is intentional to report observer failure while preserving lifecycle integrity. No issue 001 source was modified.
Blocker or context escalation details: none

## Codex Review Note

Round: 3
Issue: long-term-optimization-002 - Derive lifecycle from Items and schedule turns FIFO
Reviewer context: fresh
Reviewer edits: none
Reviewed branch: `codex/long-term-optimization-002`
Base revision/diff scope: `2ad9e1f1a0b285b8acd1b0fd0c8797745d73a59f..ee64e8003c2f60fa841228a7daa9f208c7a94dd0`
Standards Review blocking: none
Standards Review non-blocking: Evidence physical order is incorrect.
Standards Review missing evidence: none
Spec Review blocking: none
Spec Review non-blocking: none
Spec Review missing evidence: none
Local tracker state decision: Rework
State decision reason: Runtime/spec no findings; evidence physical order is incorrect. Preserve prior append-only text and add a canonical correction ledger before returning to Agent Review.

## Evidence Ledger Correction

Earlier notes were accidentally appended out of chronological physical order.

Canonical logical sequence:

1. Worker Round 1 - commit `7d09be81505944930fa1b198a959c6d227186328`; physical anchor line 3 heading `## Codex Worker Note`, with `Round: 1` at line 5.
2. Review Round 1 - reviews commit `7d09be81505944930fa1b198a959c6d227186328`; physical anchor line 68 heading `## Codex Review Note`, with `Round: 1` at line 70.
3. Worker Round 2 - commit `2ad9e1f1a0b285b8acd1b0fd0c8797745d73a59f`; physical anchor line 85 heading `## Codex Worker Note`, with `Round: 2` at line 87.
4. Review Round 2 - reviews commit `2ad9e1f1a0b285b8acd1b0fd0c8797745d73a59f`; physical anchor line 27 heading `## Codex Review Note`, with `Round: 2` at line 29.
5. Worker Round 3 - commit `ee64e8003c2f60fa841228a7daa9f208c7a94dd0`; physical anchor line 44 heading `## Codex Worker Note`, with `Round: 3` at line 46.
6. Review Round 3 - reviews commit `ee64e8003c2f60fa841228a7daa9f208c7a94dd0`; physical anchor line 109 heading `## Codex Review Note`, with `Round: 3` at line 111.

All prior text is intentionally preserved and must not be treated as overwritten by this ledger. This section corrects only the canonical logical reading order.

Canonical current tracker state: `Agent Review`; branch `codex/long-term-optimization-002`; Worker Round `4`; Review Round `3`; evidence path `docs/implementation/long-term-optimization-002-evidence.md`.

## Codex Worker Note

Round: 4
Issue: long-term-optimization-002 - Derive lifecycle from Items and schedule turns FIFO
Local tracker state transition: In Progress -> Agent Review
Branch: `codex/long-term-optimization-002`
PR URL: not configured; local-branch workflow
Base revision/diff scope: Evidence-only correction from `ee64e8003c2f60fa841228a7daa9f208c7a94dd0`; changes limited to append-only issue 002 evidence and tracker round/state fields
Summary of behavior delivered: Appended Review Round 3, a canonical evidence ledger correction, and Worker Round 4 without changing or reordering prior notes.
Final scope summary: Evidence-order correction and Agent Review handoff only; no source or test changes.
Changed files/modules: `docs/implementation/long-term-optimization-002-evidence.md`; `docs/implementation/long-term-optimization-tracker.md`
Tests added/updated: none; runtime/spec passed Review Round 3 and this correction is documentation-only
Acceptance criteria status: PASS - Review Round 3 records runtime/spec no findings; PASS - incorrect physical order is explicitly disclosed; PASS - canonical Worker 1 -> Review 1 -> Worker 2 -> Review 2 -> Worker 3 -> Review 3 sequence includes immutable line anchors and commit hashes; PASS - prior text remains untouched; PASS - tracker is canonically `Agent Review` at Worker Round 4 / Review Round 3.
Commands run and results: `git diff --check` passed with line-ending warnings only; read-only evidence heading/order sanity command confirmed the immutable prior physical anchors, appended Review Round 3 -> Evidence Ledger Correction -> Worker Round 4 order, and tracker counters/state.
Validation log paths: none; command output captured in the worker task
Required check status or local-check handoff reason: Evidence-only correction; requested documentation checks pass. Runtime/spec gates remain accepted from Review Round 3.
Evidence links/paths: `docs/implementation/long-term-optimization-002-evidence.md`; `docs/implementation/long-term-optimization-tracker.md`
Decisions made: Preserved every existing note byte-for-byte and appended a correction ledger rather than cosmetically reordering history.
Standards notes: Append-only evidence discipline takes precedence over physical presentation order; tracker changes are limited to issue 002 round/state fields.
Reviewer notes: Verify the appended three-section order and use the ledger as the canonical logical sequence; do not reinterpret prior physical order as chronology.
Open questions: none
Known residual risks: none; the disclosed physical ordering remains intentionally preserved
Blocker or context escalation details: none

## Codex Review Note

Round: 4
Issue: long-term-optimization-002 - Derive lifecycle from Items and schedule turns FIFO
Reviewer context: fresh
Reviewer edits: none
Reviewed branch: `codex/long-term-optimization-002`
Base revision/diff scope: `05477f7b54829a10d9fd79e18ca9e5247f1bd418..f33336c401d210a6fd79738ddeca409998da69bb`
Standards Review blocking: none
Standards Review non-blocking: none
Standards Review missing evidence: none
Spec Review blocking: none
Spec Review non-blocking: none
Spec Review missing evidence: none
Local tracker state decision: Agent Review
State decision reason: STRICT PASS. Reviewer verified correction ledger/tracker, Round 4 docs-only scope, 39/39 targeted and 166/166 full tests, and no concealed unresolved finding. Integration is manager-owned, so tracker remains Agent Review.
