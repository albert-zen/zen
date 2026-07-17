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

- [ ] Initial subscription buffers notifications while a thread snapshot is in
      flight, then installs the snapshot and replays by protocol order with Item
      id/seq idempotency. An older `i1` snapshot cannot overwrite SSE `i2`.
- [ ] Native EventSource reconnect recovers dropped Items through an explicit
      protocol replay/cursor or resnapshot contract. Effectful requests stay
      gated until recovery completes, and stale generations cannot reactivate.
- [ ] The synchronization contract handles reconnect deadlock, snapshot/event
      races, server restart/gap, and transport/browser/Node clients without
      presentation access to private transport state.
- [ ] Tests cover initial handoff, offline terminal/approval/item recovery,
      request gating, gap/restart resnapshot, duplicate replay idempotency,
      reconnect failure, and existing atomic generation behavior.
- [ ] `ItemList` snapshots remain the final recovery authority and no second
      source of truth is introduced.

### long-term-optimization-010: Aggregate production shutdown

- [ ] `app-server-cli` and `web-dev-cli` own and invoke `AppServer.close()`.
      Aggregate shutdown quiesces ingress, drains AppServer/thread/journal, then
      closes transport, Vite, and handoff resources.
- [ ] Shutdown is idempotent and uses all-settled aggregation so one cleanup
      failure cannot skip another and all failures are retained.
- [ ] Composition wiring tests cover SIGINT, SIGTERM, startup failure, active
      abort, pending approval decline, queued cancel, journal close, and exactly
      once closure of transport/Vite/handoff resources.
- [ ] A throwing close still allows every other close and produces an aggregate
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
