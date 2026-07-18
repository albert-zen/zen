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
