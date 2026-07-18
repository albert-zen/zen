# Long-Term Optimization Global Remediation Evidence

Canonical tracker:
[`docs/implementation/long-term-optimization-tracker.md`](long-term-optimization-tracker.md)

Base revision: `606a6198c7a9a3263e55d06bef35b3c4e8fd2148`

Worker branch: `codex/long-term-optimization-global-remediation`

Review mode: all three issues enter one fresh Standards and Spec review after
their independent implementation and evidence commits are complete. No Linear
updates are made for this local remediation DAG.

## Remediation DAG

1. `long-term-optimization-008` Durability before activation.
2. `long-term-optimization-009` Lossless snapshot/stream handoff, after the 008
   AppServer and protocol boundary exists.
3. `long-term-optimization-010` Aggregate production shutdown, serialized after
   009 to avoid concurrent Node/browser resources.
4. Fresh review after all three issues reach `Agent Review`.

## Acceptance Criteria

### long-term-optimization-008: Durability before activation

- [x] Turn start uses an explicit prepare/queue, durability acknowledgement,
      and activate boundary. Model, tool, and retry effects cannot start before
      their initiating Items are durable.
- [x] The effect-boundary audit covers initial thread/turn start, retry,
      `tool.call.started`, and approval resolve/tool unblock.
- [x] A journal commit failure is global, sticky, and fail-stop. List, read, and
      mutations return `PERSISTENCE_FAILURE`; active work is fenced/aborted;
      the synchronous failure handler does not wait on its own event tail.
- [x] Injected queued, retry, tool-start, approval-resolution, and cross-thread
      mid-run failures have no forbidden model/tool effects. Normal FIFO,
      approval race, AgentLoop, and LocalToolRuntime behavior remains green.
- [x] Journal ownership remains in product/AppServer composition. The kernel
      receives only a generic async item appender and has no journal dependency.

### long-term-optimization-009: Lossless snapshot/stream handoff

- [x] Initial subscription buffers notifications while a thread snapshot is in
      flight, then installs the snapshot and replays by protocol order with Item
      id/seq idempotency. An older `i1` snapshot cannot overwrite SSE `i2`.
- [x] Native EventSource reconnect recovers dropped Items through an explicit
      protocol replay/cursor or resnapshot contract. Effectful requests stay
      gated until recovery completes, and stale generations cannot reactivate.
- [x] The synchronization contract handles reconnect deadlock, snapshot/event
      races, server restart/gap, and transport/browser/Node clients without
      presentation access to private transport state.
- [x] Tests cover initial handoff, offline terminal/approval/item recovery,
      request gating, gap/restart resnapshot, duplicate replay idempotency,
      reconnect failure, and existing atomic generation behavior.
- [x] `ItemList` snapshots remain the final recovery authority and no second
      source of truth is introduced.

### long-term-optimization-010: Aggregate production shutdown

- [x] `app-server-cli` and `web-dev-cli` own and invoke `AppServer.close()`.
      Aggregate shutdown quiesces ingress, drains AppServer/thread/journal, then
      closes transport, Vite, and handoff resources.
- [x] Shutdown is idempotent and uses all-settled aggregation so one cleanup
      failure cannot skip another and all failures are retained.
- [x] Composition wiring tests cover SIGINT, SIGTERM, startup failure, active
      abort, pending approval decline, queued cancel, journal close, and exactly
      once closure of transport/Vite/handoff resources.
- [x] A throwing close still allows every other close and produces an aggregate
      error. No `process.exit`, broad Node kill, or resource-ownership workaround
      is introduced.

## Codex Worker Note

Round: 1
Issue: long-term-optimization-008 Durability before activation
Local tracker state transition: In Progress -> Agent Review
Branch: `codex/long-term-optimization-global-remediation`
PR URL: not configured; local-branch mode
Base revision/diff scope: `606a6198c7a9a3263e55d06bef35b3c4e8fd2148..ec52adbeaf77de2076ec42316edb324a6714cfe3`
Summary of behavior delivered: AppServer now owns prepare/durable/activate turn
and approval boundaries, awaits every active Item commit before the next model
or tool effect, and trips one global sticky persistence fence that aborts active
work and blocks every request.
Final scope summary: ISSUE-008 product/kernel composition, approval delivery,
Node local tool integration, and focused tests only.
Changed files/modules: `src/kernel/agent-loop.ts`,
`src/product/{app-server,approval-runtime,index,thread-manager}.ts`,
`src/adapters/node/local-tool-runtime.ts`,
`test/{app-server-journal,approval-runtime}.test.ts`
Tests added/updated: queued append failure; tool-start append failure; retry
queued failure; approval-resolution failure; cross-thread active-work fence;
AgentLoop public option type assertion.
Acceptance criteria status: all ISSUE-008 criteria pass; fresh review pending.
Commands run and results: valid RED `app-server-journal` run failed 5/9 in
1.41s for the intended old behaviors; final focused run passed 10/10 in 1.35s;
related product/kernel run passed 8 files and 65/65 tests in 21.03s;
`npm run typecheck` passed; touched-file ESLint passed; `git diff --check`
passed.
Validation log paths: console evidence summarized here; no separate log file.
Required check status or local-check handoff reason: targeted unit, type, lint,
format, and diff gates pass. Full `npm run check`, coverage, browser E2E, and
real launchers are reserved for integration per manager instruction.
Evidence links/paths:
`docs/implementation/long-term-optimization-global-remediation-evidence.md`
Decisions made: use a generic async kernel appender; keep journal ownership in
AppServer; make runtime commit failure process-wide sticky; use two-phase
approval delivery so durable resolution precedes tool unblock.
Standards notes: `ItemList` remains the only state source; no timeout or quality
gate was weakened; failure handling synchronously fences and never awaits the
event tail that invoked it.
Reviewer notes: inspect reservation reentrancy/FIFO, prepared approval races,
global failure behavior across threads, and listener/event-tail ordering.
Open questions: none.
Known residual risks: fresh review and final combined validation remain.
Blocker or context escalation details: none. Two intentionally bad early RED
runs left exact owned Vitest processes; only their verified PIDs were stopped.
The valid ISSUE-008 runs created 22 exact allowlisted `zen-*` OS-temp
directories with zero post-run live references. Native PowerShell cleanup was
attempted but blocked by execution policy before deletion; no broad or alternate
shell deletion was used, and all historical directories remain untouched.

## Codex Worker Note

Round: 1
Issue: long-term-optimization-009 Lossless snapshot/stream handoff
Local tracker state transition: In Progress -> Agent Review
Branch: `codex/long-term-optimization-global-remediation`
PR URL: not configured; local-branch mode
Base revision/diff scope: `57b757060f20656512abbee32746f2079a4408f0..aae53237cb2761f0bed6d3f0a8fd58733e841ea1`
Summary of behavior delivered: Node transport now assigns monotonic SSE ids,
retains bounded notification replay, honors `Last-Event-ID`, and emits explicit
reset/sync checkpoints. Browser and Node clients keep effectful requests gated
until replay or an ItemList-backed resnapshot completes. WebUiClient and
AgentInteractionSession buffer snapshot handoffs and replay by Item id/seq.
Final scope summary: ISSUE-009 AppServer transport protocol, Node/browser
clients, presentation snapshot consumers, and focused tests only.
Changed files/modules: `src/adapters/node/app-server-transport.ts`,
`src/product/app-server-protocol.ts`, `src/product/thread-manager.ts`,
`src/presentation/{web-ui-client,web-ui-state,agent-interaction-session}.ts`,
and their focused transport/presentation tests.
Tests added/updated: initial WebUi and session handoff races; browser replay and
effect gate; offline item/approval/terminal recovery; reconnect resnapshot
success/failure; server replay/gap/restart; Node `Last-Event-ID` reconnect and
sync gate; duplicate Item replay idempotency; existing atomic generation tests.
Acceptance criteria status: all ISSUE-009 criteria pass; fresh review pending.
Commands run and results: WebUi RED failed 3/26 in 1.28s for snapshot overwrite,
missing resnapshot, and premature release; transport RED failed 3/16 in 1.50s
for missing ids/gap/reset. Final transport passed 17/17 in 1.42s;
transport/browser passed 44/44 in 1.88s; related protocol/presentation suite
passed 5 files and 78/78 tests in 2.83s; core and Web typechecks passed;
touched-file ESLint and `git diff --check` passed.
Validation log paths: console evidence summarized here; no separate log file.
Required check status or local-check handoff reason: targeted unit/integration,
core/Web type, lint, format, and diff gates pass. Full `npm run check`, coverage,
browser E2E, and real launchers remain reserved for integration.
Evidence links/paths:
`docs/implementation/long-term-optimization-global-remediation-evidence.md`
Decisions made: keep replay as bounded transport delivery history, not product
state; use `streamId:cursor` SSE ids; make reset deliver protocol-level
`sync/reset` ItemList snapshots; allow only internal read-only resnapshot to
bypass the recovery gate; deliver replay Items idempotently while effects stay
closed.
Standards notes: ItemList snapshots remain final recovery authority. Cursor
state orders delivery only and presentation does not access transport-private
fields. No sleep controls recovery correctness and no timeout was weakened.
Reviewer notes: inspect Last-Event-ID parsing/gap bounds, nested reconnect during
reset, request generation checks, and same-thread snapshot handoff replay.
Open questions: none.
Known residual risks: replay history is intentionally bounded, so long gaps use
full resnapshot; fresh review and final combined validation remain.
Blocker or context escalation details: none. Every ISSUE-009 Node test command
started and ended with zero attributable Node/Chromium processes and produced
zero `zen-*` OS-temp delta. No process or temporary path was removed.

## Codex Worker Note

Round: 1
Issue: long-term-optimization-010 Aggregate production shutdown
Local tracker state transition: In Progress -> Agent Review
Branch: `codex/long-term-optimization-global-remediation`
PR URL: not configured; local-branch mode
Base revision/diff scope: `79d35ff2f0d18fdd69a7132f2ce222f0446784c0..31ebc3b1a303cca923da924caa927bab61ed996d`
Summary of behavior delivered: both production CLIs now delegate resource
ownership to one injectable composition module. Shutdown first quiesces HTTP
ingress, then closes AppServer so active/approval/queued work drains through the
journal, then closes transport, Vite, and handoff resources with all-settled
error aggregation and one idempotent close promise.
Final scope summary: ISSUE-010 production composition roots, transport
quiescence/startup cleanup, AppServer/ThreadManager drain aggregation, provider
startup ownership, and focused tests only.
Changed files/modules: App Server/Web CLI, HTTP transport, Node exports,
production composition, provider runtime, product AppServer/ThreadManager, and
`test/{app-server-transport,production-composition}.test.ts`.
Tests added/updated: real AppServer SIGINT drain with active abort, queued
cancellation, pending approval decline, and journal close; web SIGTERM and Vite
close; startup failure cleanup; aggregate multi-error retention; repeated
signal/close idempotency; transport 503 quiescence and bind-failure unsubscribe;
journal close despite cancellation failure; replay-failure journal cleanup.
Acceptance criteria status: all ISSUE-010 criteria pass; fresh review pending.
Commands run and results: valid RED failed import because the new composition
contract did not exist (one failed suite, 0 tests, 0.29s). The first behavioral
run exposed a deterministic ready/listener race (3/5 timed out); the fix installs
the signal waiter before publishing readiness without sleep or timeout changes.
Final focused composition passed 7/7 in 1.60s; related composition, transport,
and ThreadManager suite passed 3 files and 51/51 tests in 2.40s; core typecheck,
touched-file ESLint, touched-file Prettier check, build, and `git diff --check`
passed.
Validation log paths: console evidence summarized here; no separate log file.
Required check status or local-check handoff reason: targeted unit/integration,
core type, lint, format, build, and diff gates pass. Full `npm run check`,
coverage, browser E2E, Web build, and real launchers remain reserved for
integration per manager instruction.
Evidence links/paths:
`docs/implementation/long-term-optimization-global-remediation-evidence.md`
Decisions made: expose protocol-level transport `quiesce()` separately from
idempotent `close()`; sequence all-settled phases while running peers within a
phase together; flatten nested AggregateErrors into resource-labelled leaves;
transfer journal ownership only after successful provider replay.
Standards notes: ItemList remains the sole product state source. No timeout or
quality gate was weakened, no `process.exit` or kill path was added, and both
CLI files are thin owners over the same tested lifecycle contract.
Reviewer notes: inspect phase ordering under simultaneous signals, startup
failure after partial acquisition, nested AggregateError preservation, and HTTP
quiescence with open SSE streams.
Open questions: none.
Known residual risks: fresh review and the final cross-issue combined validation
remain.
Blocker or context escalation details: none. Final ISSUE-010 Node test commands
started and ended with zero attributable Node/browser processes and produced
zero `zen-*` OS-temp delta from the 4582 historical-directory baseline. No
process or temporary path was removed.

## Codex Worker Note

Round: 2
Issue: global remediation fresh-review findings for 008/009/010
Local tracker state transition: Agent Review -> Rework -> Agent Review; all
three issues remain batched for one independent fresh review
Branch: `codex/long-term-optimization-global-remediation`
PR URL: not configured; local-branch mode
Base revision/diff scope: `99f082dc3bbbe7e6880df039afcddfaf9af3abd6..8c4d8b59a451077f528a821e3ef1586d37b5d201`
Summary of behavior delivered: the cross-issue audit closed three blocking
boundaries. HookRuntime now preserves the injected durable Item appender for
normal, hook-effect, and hook-error Items; authoritative empty resets clear
stale projection state and terminal reset snapshots settle the exact pending
session turn; production signal handlers are installed before the first
resource acquisition and stop later startup stages after a signal.
Final scope summary: bounded fresh-review remediation only; no unrelated
refactor or protocol state source was added.
Changed files/modules: production composition; AgentLoop/HookRuntime and kernel
exports; InteractionProjection/AgentInteractionSession; focused tests.
Tests added/updated: hook-enabled injected-appender failure with `toolCalls=0`;
empty reset clearing stale state; terminal reset settling a bound submit waiter;
SIGTERM during transport acquisition preventing Vite acquisition while closing
all already-owned resources.
Acceptance criteria status: the 008 hook/effect boundary, 009 reset recovery,
and 010 startup-signal ownership findings are fixed. A proposed observer-error
change was rejected during review because ItemList observer failure occurs after
the Item is committed and the existing FIFO contract intentionally executes it;
the async commit barrier remains the durability acknowledgement.
Commands run and results: corrected RED failed 3/70 tests across four files for
the hook appender, empty reset, and terminal waiter behaviors. Focused fixes
passed 4 files/69 tests in 2.31s and 6 files/65 tests in 2.90s. Final serialized
cross-issue suite passed 11 files/151 tests in 4.97s. Core and Web typechecks,
touched-file ESLint and Prettier checks, build, and `git diff --check` passed.
Validation log paths: console evidence summarized here; no separate log file.
Required check status or local-check handoff reason: targeted cross-issue tests
and static/build gates pass. Full `npm run check`, coverage, browser E2E,
acceptance/Web builds, and real launchers remain reserved for integration per
manager instruction.
Evidence links/paths:
`docs/implementation/long-term-optimization-global-remediation-evidence.md`
Decisions made: keep one appender authoritative through hooks; bind completion
waiters to the turn id returned by the request and reconcile against ItemList
snapshots; install signal observation before ownership acquisition without
racing or abandoning in-flight factory results.
Standards notes: ItemList remains the sole source of truth; transport replay is
delivery history only; no sleep/timeout/gate weakening, `process.exit`, or kill
path was introduced.
Reviewer notes: independent fresh review should recheck hook-effect append
ordering, reset reconciliation for missing/failed turns, and signal arrival
during each acquisition await.
Open questions: none.
Known residual risks: independent fresh review and integration-only gates remain.
Blocker or context escalation details: none. All final test commands ended with
zero attributable Node/browser processes. Two FileThreadJournal runs created six
exact OS-temp directories with allowlisted prefixes and zero live references;
literal-path cleanup was attempted after parent/prefix validation but blocked by
execution policy before deletion. The 4582 historical baseline and all other
temporary directories were untouched; final count is 4588.

## Codex Review Note

Round: 2
Issue: global remediation review of long-term-optimization-008/009/010
Reviewer context: fresh independent review of head
`160046e4ab2f65142204b5bc0f76f513cff85095`
Reviewer edits: none
Reviewed branch: `codex/long-term-optimization-global-remediation`
Base revision/diff scope:
`606a6198c7a9a3263e55d06bef35b3c4e8fd2148..160046e4ab2f65142204b5bc0f76f513cff85095`
Standards Review blocking: P1-1 model and tool calls lacked a synchronous
effect-permission fence after their final durable start Items; P1-2 browser
reset obligation could be cleared by phase/generation transitions after a
failed resnapshot; P1-3 session completion waiters settled by thread instead of
response turn id and lacked bounded early-terminal binding; P1-4 authoritative
snapshots did not rederive Web UI connection state; P1-5 production signal
listeners were removed before graceful shutdown settled; P1-6 transport
quiescence did not own incomplete request bodies/sockets and could hang close.
Standards Review non-blocking: none.
Standards Review missing evidence: historical pre-review RED execution is not
retained as a verifiable artifact. This is not a code blocker, and no historical
log is reconstructed or fabricated.
Spec Review blocking: the same six P1 findings violate the effect-before-
durability, reconnect recovery, per-turn completion, snapshot authority,
aggregate shutdown, and bounded transport-close acceptance criteria.
Spec Review non-blocking: none.
Spec Review missing evidence: the prior 11-file summary reported 151 tests, but
the manager-confirmed exact reviewer command ran 149 tests. Test temp teardown
was also missing for exact roots created by `app-server-journal.test.ts` and
`local-tool-runtime.test.ts`.
Local tracker state decision: Rework for 008, 009, and 010.
State decision reason: all six P1 findings and the exact-root teardown finding
are reproducible and require the original implementation worker.

## Codex Worker Note

Round: 3
Issue: global remediation rework for long-term-optimization-008/009/010
Local tracker state transition: Rework -> In Progress -> Agent Review for all
three issues; one new independent fresh review remains required
Branch: `codex/long-term-optimization-global-remediation`
PR URL: not configured; local-branch mode
Base revision/diff scope:
`160046e4ab2f65142204b5bc0f76f513cff85095..3dd3f40f76782fa02b576d15af5e472f4807808d`
Summary of behavior delivered: a shared synchronous effect-permission fence now
guards eager model/tool invocation after durable start Items. Browser reset debt
uses monotonic versions independent of phase/generation and clears only after a
current authoritative snapshot and buffered replay install. Session waiters bind
to response turn ids with a bounded transient early-terminal cache. Web UI
connection derives from authoritative snapshots. Production signal listeners
remain installed through aggregate shutdown. HTTP transport owns request phases
and sockets so quiescence terminates only incomplete ingress while dispatched
requests and SSE remain until their owning shutdown phase.
Final scope summary: the six accepted P1 findings, exact temp teardown P2, and
the stale Web proxy SSE-control assertions discovered during related validation.
No compatibility layer, second Item source, timeout weakening, remote push, or
Linear update was added.
Changed files/modules: kernel model/tool effect boundary; browser transport and
Web UI/session presentation; Node HTTP transport and production composition;
focused tests including journal/local-tool teardown and Web proxy protocol
assertions.
Tests added/updated: eager model/tool invocation counters including hook path;
failed/repeated reset debt and stale generation; concurrent per-turn waiters,
terminal-before-bind, reset/replacement cleanup; idle/running/failed/no-current/
multi-thread connection derivation; deferred signal-listener lifetime; real
partial-body socket close, dispatched request preservation, and SSE preservation;
exact-root temp cleanup.
Acceptance criteria status: all accepted P1 and P2 criteria pass. ItemList
remains the sole domain state source; replay/cursor data and the bounded waiter
cache are transport/request-race coordination only.
Commands run and results: six exact RED regressions failed at the reviewed head
as expected (P1-1 ran two tests; P1-2 through P1-6 each ran one) with the
reviewed side effect/race observed. The same six commands passed after the fix.
The touched suite passed 8 files/112 tests. The exact corrected reviewer command
was:
`npm test -- test/app-server-journal.test.ts test/approval-runtime.test.ts test/agent-loop.test.ts test/hook-runtime.test.ts test/thread-manager.test.ts test/web-ui-state.test.ts test/web-ui-client.test.ts test/agent-interaction-session.test.ts test/app-server-transport.test.ts test/production-composition.test.ts test/app-server-cli.test.ts`.
The manager-confirmed reviewed-head result was 11 files/149 tests, correcting the
retained Round 2 text that says 151; the unchanged old text is intentionally
preserved. With this round's added tests, the exact command passed 11 files/163
tests in 7.68s (8.665s outer measurement). A broader kernel combination passed
11 files/166 tests; Web proxy protocol tests passed 4/4. Core and Web typechecks,
touched ESLint and Prettier, core and Web builds, `git diff --check`, and one
forbidden-operation audit passed.
Validation log paths: console evidence summarized here; no retained standalone
log files. There is no verifiable historical RED artifact for the pre-review
implementation, and none was invented. This remediation's RED/GREEN results are
direct command observations only.
Required check status or local-check handoff reason: all manager-requested
targeted, combined, type, lint, format, build, diff, and audit gates pass. Full
`npm run check`, coverage, acceptance/E2E, and real launchers were not run by
instruction and remain for integration.
Evidence links/paths:
`docs/implementation/long-term-optimization-global-remediation-evidence.md` and
`docs/implementation/long-term-optimization-tracker.md`.
Decisions made: use one synchronous abort permission check immediately adjacent
to external effect evaluation; model reset obligation as monotonic debt; keep
early terminals only while an unbound waiter exists and cap them by unbound
waiter count; preserve dispatched HTTP/SSE ownership while terminating
transport-owned ingress.
Standards notes: no quality gate or timeout was weakened. No arbitrary Node
kill, broad temp delete, `process.exit`, remote push, or canonical-worktree edit
was performed.
Reviewer notes: fresh review should replay all six exact regressions and inspect
the reset debt version checks, waiter cache bound, signal listener disposal, and
socket phase ownership.
Open questions: none.
Known residual risks: independent fresh review and integration-only full gates.
Blocker or context escalation details: none. Every Node/browser command began
and ended with zero attributable worker Node processes. The four teardown
prefixes held the exact same pre/post set (2194 entries, SHA-256
`A3384751CCBF4AE1EBE62D743A4EB2E2A93A22BF89D4A3E8CD90FBCFAE93B285`) across
the touched suite; the exact reviewer and proxy prefix sets were also unchanged.
Only exact roots returned and registered by the current test were removed. All
historical directories, including the manager-designated 37 unknown roots, were
left untouched.

## Codex Review Note

Round: 3
Issue: global remediation fresh review of long-term-optimization-008/009/010
Reviewer context: fresh independent review of head
`984d0448ef5843e069ee73bcaf20ea04417d1b20`
Reviewer edits: none
Reviewed branch: `codex/long-term-optimization-global-remediation`
Base revision/diff scope:
`606a6198c7a9a3263e55d06bef35b3c4e8fd2148..984d0448ef5843e069ee73bcaf20ea04417d1b20`,
including focused re-review of
`160046e4ab2f65142204b5bc0f76f513cff85095..984d0448ef5843e069ee73bcaf20ea04417d1b20`
Standards Review blocking: none. STRICT PASS; P0/P1/P2 findings are 0. The
reviewer individually reverified all six Round 2 findings and all three global
remediation objectives.
Standards Review non-blocking: none.
Standards Review missing evidence: none. The absence of a verifiable historical
pre-review RED artifact remains accurately disclosed; no historical log was
reconstructed or fabricated.
Spec Review blocking: none. STRICT PASS for ISSUE-008 durability before
activation, ISSUE-009 lossless snapshot/stream handoff, and ISSUE-010 aggregate
production shutdown.
Spec Review non-blocking: none.
Spec Review missing evidence: none.
Reviewer-verified commands/evidence: the exact related combination command
recorded in Worker Round 3 passed 11 files/163 tests; focused effect-boundary
coverage passed 15 tests; exact temp-teardown coverage passed 17 tests in each
of two repeated rounds. Main and Web typechecks, touched lint, Prettier, and
`git diff --check` passed. Final attributable process count was 0 and the exact
allowlisted temporary-directory baseline delta was 0.
Local tracker state decision: Complete / Ready for Integration for 008, 009,
and 010; not Integrated.
State decision reason: fresh review found no P0, P1, or P2 findings after
criterion-by-criterion verification. Canonical integration and program/wave
completion remain manager-owned and are not recorded by this review.

## Codex Worker Note

Round: 4
Issue: canonical integration of long-term-optimization-008, long-term-optimization-009, and long-term-optimization-010
Local tracker state transition: Complete / Ready for Integration -> Integrated for all three issues
Branch: `codex/long-term-optimization`
PR URL: not configured; local-branch mode and no remote push
Base revision/diff scope: canonical base `606a6198c7a9a3263e55d06bef35b3c4e8fd2148`; strict-pass source closeout `e96a7f1be9ff08a438bed343939c8d13cb5b16ee`; canonical merge commit `2df7fef3b09f41c39fb6813f27485482ed708a46`
Summary of behavior delivered: merged the reviewed global remediation branch into canonical with `git merge --no-ff`; canonical code now includes durability-before-activation, lossless snapshot/stream handoff, and aggregate production shutdown.
Final scope summary: manager-owned canonical integration, one complete release gate, audit, exact hygiene census, and append-only closeout documentation only.
Changed files/modules: merge introduced the reviewed 35-file remediation diff; this closeout changes only `docs/implementation/long-term-optimization-tracker.md` and this evidence document.
Tests added/updated: none during integration.
Acceptance criteria status: ISSUE-008, ISSUE-009, and ISSUE-010 remain covered by fresh STRICT PASS review and are now canonically Integrated. The final release gate passed.
Commands run and results: `git merge --no-ff codex/long-term-optimization-global-remediation` passed and created `2df7fef3b09f41c39fb6813f27485482ed708a46`. One exact `npm run check` passed in 661.598 seconds: Prettier format check; ESLint; core and Web TypeScript checks; Vitest 35 files/343 tests; `build`, `build:acceptance`, and `web:build`; kernel coverage 89.50% statements/82.60% branches/93.87% functions/90.17% lines; product coverage 90.59%/80.22%/95.85%/92.23%; presentation coverage 90.51%/80.43%/92.95%/92.23%; and Playwright 2/2. `npm audit --include=dev --registry=https://registry.npmjs.org` passed with `found 0 vulnerabilities`.
Validation log paths: console evidence summarized here; no separate retained log file.
Required check status or local-check handoff reason: PASS. No gate was split, repeated, weakened, or timed out. The full gate ran once on the canonical merge head. No remote push was performed.
Evidence links/paths: `docs/implementation/long-term-optimization-tracker.md` and `docs/implementation/long-term-optimization-global-remediation-evidence.md`.
Decisions made: preserve all prior evidence; transition only the reviewed remediation issues to Integrated after the merge-head gate passed; report residue without deletion.
Standards notes: `ItemList` remains the source of truth. No reset, rebase, force operation, `checkout --`, process kill, `taskkill`, or broad/wildcard temporary deletion was used.
Reviewer notes: source strict closeout at `e96a7f1be9ff08a438bed343939c8d13cb5b16ee` is retained in history; integration evidence is manager-owned.
Open questions: none.
Known residual risks: exact temporary-directory residue is retained because it lacks sufficient ownership proof for safe deletion. The 28 new paths are `C:\Users\two-one\AppData\Local\Temp\zen-journal-0tQYYQ`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-0Zvvhu`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-1ekkaa`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-63umry`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-70LgCE`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-75uUii`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-7w60NL`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-bBk0xX`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-bKQ1yT`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-ByXnbE`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-czXa64`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-dfDYdM`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-dHZlTn`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-dtecyx`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-EYgLoi`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-irmO2r`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-Ix41Oa`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-JDBNmK`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-K5Qq6i`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-mdHDGk`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-n3nv1A`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-O8OZiX`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-p3Vnwp`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-UNT090`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-UwTLvf`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-vCJQP3`, `C:\Users\two-one\AppData\Local\Temp\zen-journal-xomDzG`, and `C:\Users\two-one\AppData\Local\Temp\zen-journal-zCwPYF`. They were created in four seven-directory batches during the Vitest and coverage runs and contain only `thread-*.jsonl` journal fixtures; no attributable Node/Chromium process was live at census. They are test-generated but lack a safe, exact ownership/reclamation record, so none was removed. Historical directories, including the manager-designated 37 unknown roots, were untouched.
Blocker or context escalation details: pre-gate allowable temporary-directory baseline was 1446 paths with SHA-256 `08D14F3E0AAFF1E39E1957A23CFC2C4BDC946FEBF8ADBCCDEB64212407CE3465`; post-gate set was 1474 paths with SHA-256 `DAF6F9D4B24BBC0796D9E0577A91A0517A9998E2D8306C7356EF65DC9097B34A`, delta +28/-0. The exact attributable runtime process set was 0 before and after, SHA-256 `E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855`.

## ISSUE-011 Acceptance Criteria

- [x] Each `thread-journal` fixture root is the resolved exact path returned by
      the current test process's `mkdtempSync` call and is registered before use.
- [x] Teardown validates that each registered root is directly under the OS
      temp root and has a non-empty `zen-journal-*` leaf before using the exact
      literal path. It performs no wildcard or historical-prefix deletion.
- [x] `afterEach` attempts every registered root on passing and failing test
      paths, aggregates cleanup failures, and never deletes an unregistered root.
- [x] Two serialized `thread-journal` runs and one complete unit-test run retain
      identical pre/post `zen-journal-*` path sets and SHA-256 hashes.
- [x] The canonical 28-directory residue remains untouched as retained evidence.
      ISSUE-011 changes test infrastructure only and does not alter integrated
      008-010 product behavior.

## Codex Worker Note

Round: 1
Issue: long-term-optimization-011 deterministic journal fixture cleanup
Local tracker state transition: Rework -> In Progress -> Agent Review
Branch: `codex/long-term-optimization-global-remediation`
PR URL: not configured; local-branch mode and no remote push
Base revision/diff scope: canonical hygiene evidence
`786228f6494c0c8c318c187675eec31067545b1f`; worker implementation
`e96a7f1be9ff08a438bed343939c8d13cb5b16ee..84a94213ca457b750e74b563734b7fbe997e909d`
Summary of behavior delivered: `thread-journal` fixtures now register each
resolved exact root returned by `mkdtempSync`. Vitest `afterEach` validates the
OS-temp parent and `zen-journal-` leaf, then removes only those registered
literal paths while retaining every cleanup failure in an `AggregateError`.
Final scope summary: test-infrastructure teardown only. No product source,
integrated 008-010 behavior, timeout, gate, journal implementation, or historical
temporary directory was changed.
Changed files/modules: `test/thread-journal.test.ts`; tracker and this append-only
evidence document.
Tests added/updated: the existing 9-test `FileThreadJournal` suite now owns its
seven per-run fixture roots through exact per-test teardown; no test was removed
or weakened.
Acceptance criteria status: all ISSUE-011 criteria pass. Cleanup is limited to
roots registered by the current test module process, checks direct OS-temp
parentage and a non-empty fixed prefix, uses no scan or wildcard for deletion,
and runs through Vitest `afterEach` on pass/fail paths.
Commands run and results: the canonical `npm run check` recorded at
`786228f6494c0c8c318c187675eec31067545b1f` functionally passed 35 files/343
unit tests, coverage, builds, and 2/2 E2E tests but its hygiene census changed
from 1446 paths (`08D14F3E0AAFF1E39E1957A23CFC2C4BDC946FEBF8ADBCCDEB64212407CE3465`)
to 1474 (`DAF6F9D4B24BBC0796D9E0577A91A0517A9998E2D8306C7356EF65DC9097B34A`),
delta +28/-0. After this fix,
`npm test -- test/thread-journal.test.ts` passed twice, each at 1 file/9 tests:
round 1 took 1.80s Vitest/2.774s outer and round 2 took 1.47s/2.453s. Each
round retained 1299 exact `zen-journal-*` paths with identical pre/post SHA-256
`133FD81B08650A50A51A515DD6123B8283A0EAB76310BCFDD55F21FDB3D3EB36`,
delta +0/-0. One exact `npm test` passed 35 files/343 tests in 169.32s
(170.259s outer) with the same 1299-path hash before and after, delta +0/-0,
and attributable Node/browser process counts 0 before and after.
`npm exec prettier -- --check test/thread-journal.test.ts`,
`npm exec eslint -- test/thread-journal.test.ts`, `npm run typecheck`, and
`git diff --check` passed.
Validation log paths: console evidence summarized here; no standalone log file.
Required check status or local-check handoff reason: all manager-requested
targeted, complete-unit, format, lint, type, diff, process, and exact journal
census checks pass. Build, coverage, E2E, real launchers, and full
`npm run check` were not run by instruction.
Evidence links/paths:
`docs/implementation/long-term-optimization-global-remediation-evidence.md`,
`docs/implementation/long-term-optimization-tracker.md`, and canonical evidence
revision `786228f6494c0c8c318c187675eec31067545b1f`.
Decisions made: keep ownership local to the creating test process and fail the
test if any exact-root validation or removal fails; preserve all pre-existing
temporary directories as evidence rather than using a one-off cleanup.
Standards notes: read-only inspection confirmed all 28 canonical residue roots
are direct OS-temp `zen-journal-*` directories with no child directories and 44
total `thread-*.jsonl` files. The seven filename signatures each occur exactly
four times and map to the seven fixture tests: `thread/a`; `a/b` plus `a?b`;
`slow` plus `fast`; `healthy`; `recover`, `corrupt`, plus `valid`; `bulk`; and
`unicode`. Record counts and the one intentionally invalid interior corruption
line also match those tests. This establishes attribution without relying on
the prefix alone. None of those 28 roots was deleted or modified.
Reviewer notes: fresh review should inspect exact-root registration and safety
guards, exercise teardown on a failing test path if needed, and recheck a
targeted census without deleting retained residue.
Open questions: none.
Known residual risks: ISSUE-011 still requires fresh review and manager-owned
integration. The 28 canonical residue roots and all other historical temp roots
remain intentionally untouched.
Blocker or context escalation details: no blocker. No process was killed and no
broad, wildcard, prefix-scan, or one-off historical temp deletion was used.
