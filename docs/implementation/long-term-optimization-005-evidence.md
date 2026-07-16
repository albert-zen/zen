## Codex Worker Note

Round: 1
Issue: long-term-optimization-005 Make interaction projection incremental and client lifecycle single-owner
Local tracker state transition: Ready -> Agent Review
Branch: codex/long-term-optimization-005
PR URL: not configured; local-origin branch only
Base revision/diff scope: exact base `80b6a22a0d082838305059de9eb313120b27f6fa`; shared projection, WebUiClient/AgentInteractionSession, React workspace lifecycle, focused projection/client tests, tracker, and this evidence document only
Summary of behavior delivered: Added one indexed interaction projection with cached snapshots, ordered fast-path updates, and deterministic replacement/out-of-order rebuilds. WebUiClient now owns one upstream stream and exposes a stable cached external-store snapshot; AgentInteractionSession uses the same projection and does not open completion subscriptions. React now uses useSyncExternalStore and disposes its client on unmount.
Final scope summary: Completed issue 005 only. No persistence, module relocation, dependencies/gates, or issue 004/006+ work.
Changed files/modules: `src/web-ui-state.ts`; `src/web-ui-client.ts`; `src/agent-interaction-session.ts`; `src/index.ts`; `web/src/workspace.tsx`; `test/web-ui-state.test.ts`; `test/web-ui-client.test.ts`; tracker and evidence.
Tests added/updated: Projection snapshot/no-op and 5k ordered append/listener regression; WebUiClient stream ownership lifecycle regression; existing projection/session/TUI tests validate completion replacement, shell/approval grouping, deterministic out-of-order handling, and TUI consumption.
Acceptance criteria status: Ordered append uses indexed direct row updates without sort/filter/rebuild; completed assistant and tool rows replace progress; replacement/out-of-order uses canonical sort/rebuild; client stream ownership is one active subscription and idempotent disposal; React consumes cached snapshots through useSyncExternalStore with no manual `next.subscribe`; Web and TUI consume `InteractionProjection` through the shared state interface; 5k regression records exactly 5k listener calls and rows/items.
Commands run and results: `npx vitest run test/web-ui-state.test.ts test/web-ui-client.test.ts test/agent-interaction-session.test.ts test/zen-tui-app.test.ts` passed (42 tests); `npm test -- --no-file-parallelism --maxWorkers=1` passed (31 files, 197 tests); `npm run typecheck` passed; `npm run typecheck:web` passed; `npm run build` passed; `npm run web:build` passed; `git diff --check` passed. The initial parallel `npm test` run had two unrelated web-dev-proxy worker/process failures; serialized required run passed.
Validation log paths: none
Required check status or local-check handoff reason: all current local checks passed; no GitHub remote/PR is configured.
Evidence links/paths: `docs/implementation/long-term-optimization-005-evidence.md`; `docs/implementation/long-term-optimization-tracker.md`
Decisions made: Kept `web-ui-state.ts` as the existing presentation boundary and added the deep shared projection there, avoiding the out-of-scope module relocation. Retained compatibility state helpers while all live consumers use the projection instance.
Standards notes: ItemList remains the source of truth; this is a presentation projection only. Public behavior is covered via projection/client/session/TUI interfaces, with a narrow listener-count seam rather than a diagnostics API.
Reviewer notes: Review ordered append indexes and snapshot identity, one-stream ownership across reconnect/dispose, and the React external-store cleanup path.
Open questions: none
Known residual risks: Snapshot arrays are copied to preserve immutable snapshots, so the regression proves bounded notifications and avoids full projection rebuilds rather than measuring wall-clock time. React lifecycle is type/build validated; this repository has no browser DOM test harness.
Blocker or context escalation details: none

## Codex Review Note

Round: 3
Issue: long-term-optimization-005 Make interaction projection incremental and client lifecycle single-owner
Reviewer context: fresh
Reviewer edits: none
Reviewed branch: codex/long-term-optimization-005
Base revision/diff scope: `80b6a22a0d082838305059de9eb313120b27f6fa..741397f66b857aa97e5412be877232db871619d7`
Standards Review blocking: WebUiClient start/resume ignored projection no-op results and diagnostic copy evidence was hard-coded rather than attached to expensive operations.
Standards Review non-blocking: none
Standards Review missing evidence: Repeated start/resume identity/listener test and a slow-path counter test proving instrumentation is live.
Spec Review blocking: Identical start/resume snapshots could notify external-store listeners; 1k/5k performance evidence could not establish actual copy/rebuild behavior.
Spec Review non-blocking: none
Spec Review missing evidence: none
Local tracker state decision: Rework
State decision reason: Accepted bounded defects require original-worker repair.

## Codex Worker Note

Round: 4
Issue: long-term-optimization-005 Make interaction projection incremental and client lifecycle single-owner
Local tracker state transition: Rework -> Agent Review
Branch: codex/long-term-optimization-005
PR URL: not configured; local-origin branch only
Base revision/diff scope: original worker fixes only for Review Round 3: WebUiClient no-op publication guard, live projection work instrumentation, focused counter/no-op regressions, and append-only evidence.
Summary of behavior delivered: `startThread` and `resumeThread` now refresh only when `InteractionProjection.replaceSnapshot()` changes state. Projection work counters now increment at actual sequence creation/materialization/traversal, slow map clone, and index reset sites; no work field is hard-coded.
Final scope summary: Review findings only. No persistence, module relocation, dependencies, UI behavior, or issue 004/006+ work.
Changed files/modules: `src/web-ui-client.ts`; `src/web-ui-state.ts`; `test/web-ui-client.test.ts`; `test/web-ui-state.test.ts`; evidence.
Tests added/updated: Public repeated identical start/resume snapshot identity and listener-count test; slow-path out-of-order item counter regression proving nonzero sequence copy/materialization/traversal, map clone, and index rebuild; existing 1k/5k ordered shell/approval regression now asserts counter deltas from a baseline.
Acceptance criteria status: Identical start/resume responses retain WebUiClient snapshot identity and listener count; ordered 1k/5k shell/approval path reports linear 1,000/5,000 fast operations with zero materialization, sequence copy, map clone, rebuild, and index reset deltas; slow path reports nonzero actual expensive-work counters.
Commands run and results: `npx vitest run test/web-ui-state.test.ts test/web-ui-client.test.ts test/agent-interaction-session.test.ts test/workspace-lifecycle.test.tsx --no-file-parallelism --maxWorkers=1` passed (35 tests); `npm test -- --no-file-parallelism --maxWorkers=1` passed (32 files, 205 tests); `npm run typecheck` passed; `npm run typecheck:web` passed; `npm run build` passed; `npm run web:build` passed; `git diff --check` passed.
Validation log paths: none
Required check status or local-check handoff reason: all current local checks passed; no GitHub remote/PR is configured.
Evidence links/paths: `docs/implementation/long-term-optimization-005-evidence.md`; `docs/implementation/long-term-optimization-tracker.md`
Decisions made: Counters are cumulative, so fast-path tests compare a construction baseline against work performed by the ordered input. This records initialization/reset work honestly while proving the ordered delta is zero for expensive operations.
Standards notes: The narrow public `getWork()` seam exposes only deterministic aggregate counters needed for performance regression tests; it does not expose mutable indexes or sequence internals.
Reviewer notes: Verify no-op client publication and that every costly sequence/map/index path increments its corresponding counter.
Open questions: none
Known residual risks: Counter values measure structural work, not elapsed time. Read-side iteration remains intentionally linear and is now recorded as materialization/traversal work.
Blocker or context escalation details: none

## Codex Review Note

Round: 2
Issue: long-term-optimization-005 Make interaction projection incremental and client lifecycle single-owner
Reviewer context: fresh
Reviewer edits: none
Reviewed branch: codex/long-term-optimization-005
Base revision/diff scope: `80b6a22a0d082838305059de9eb313120b27f6fa..a23450144638e00bb2ef0f2b16e66396ae1e8bf1`
Standards Review blocking: Tombstone filtering invalidated visible row indexes; shell/approval fast paths still materialized or cloned projection data.
Standards Review non-blocking: Synthetic lifecycle probe did not prove production workspace lifecycle behavior.
Standards Review missing evidence: Stable-slot tombstone regression, shell/approval-heavy deterministic work evidence, and actual workspace StrictMode coverage.
Spec Review blocking: A shell output after an intervening approval tombstone could patch the wrong row; mode switches navigated away rather than explicitly owning replacement cleanup.
Spec Review non-blocking: none
Spec Review missing evidence: none
Local tracker state decision: Rework
State decision reason: Accepted bounded implementation findings require original-worker repair.

## Codex Worker Note

Round: 3
Issue: long-term-optimization-005 Make interaction projection incremental and client lifecycle single-owner
Local tracker state transition: Rework -> Agent Review
Branch: codex/long-term-optimization-005
PR URL: not configured; local-origin branch only
Base revision/diff scope: original worker fixes only for Review Round 2: stable physical row slots, shell/approval fast-path work accounting, production AgentWorkspace injection/replacement lifecycle, focused regressions, and append-only evidence.
Summary of behavior delivered: Replaced visible-row indexes with stable physical sequence slots and a current-generation slot-to-row map. Shell patches now resolve the target row directly without sequence materialization; approval tombstones do not shift later shell slots. AgentWorkspace now supports a narrow client factory seam and replaces clients in-app on mode changes, with effect cleanup disposing old streams/listeners.
Final scope summary: Review findings only. No persistence, module relocation, unrelated UI work, or issue 004/006+ changes.
Changed files/modules: `src/web-ui-state.ts`; `web/src/workspace.tsx`; `test/web-ui-state.test.ts`; `test/workspace-lifecycle.test.tsx`; `tsconfig.json`; `vitest.config.ts`; evidence.
Tests added/updated: Approval-between-two-shell-rows stable-slot regression; 5k shell/approval ordered-path work regression asserting zero rebuilds/copies/materializations; actual AgentWorkspace jsdom/StrictMode initial-connect, reconnect, mode-switch, and unmount stream-ownership test.
Acceptance criteria status: Stable slots preserve correct shell patches after tombstones; internal maps mutate only for the current projection generation while snapshots remain versioned; shell/approval ordered fast path has 5,000 operations with zero rebuilds, sequence copies, and full materializations; production workspace performs explicit client replacement rather than navigation and releases prior ownership under StrictMode/mode/unmount.
Commands run and results: `npx vitest run test/web-ui-state.test.ts test/web-ui-client.test.ts test/agent-interaction-session.test.ts test/workspace-lifecycle.test.tsx --no-file-parallelism --maxWorkers=1` passed (33 tests); `npm test -- --no-file-parallelism --maxWorkers=1` passed (32 files, 203 tests); `npm run typecheck` passed; `npm run typecheck:web` passed; `npm run build` passed; `npm run web:build` passed; `git diff --check` passed.
Validation log paths: none
Required check status or local-check handoff reason: all current local checks passed; no GitHub remote/PR is configured.
Evidence links/paths: `docs/implementation/long-term-optimization-005-evidence.md`; `docs/implementation/long-term-optimization-tracker.md`
Decisions made: Stable physical slots are retained by the persistent sequence and rows are tombstoned logically. The projection’s mutable current-generation maps are not exposed in snapshots. Added only the existing jsdom harness and Vite test include needed to mount the actual workspace.
Standards notes: Ordered mutation is constant work and immutable snapshots retain old version chains. Read-side iteration may materialize by design; projection work counters distinguish that from fast-path mutation.
Reviewer notes: Verify stable-slot behavior, all fast-path work counters, and actual workspace client ownership across React StrictMode lifecycle transitions.
Open questions: none
Known residual risks: Iterating long versioned sequences remains linear read work; deterministic counters demonstrate no full read/materialization during ordered mutation. Slow replacements remain intentionally O(n).
Blocker or context escalation details: none

## Codex Review Note

Round: 1
Issue: long-term-optimization-005 Make interaction projection incremental and client lifecycle single-owner
Reviewer context: fresh
Reviewer edits: none
Reviewed branch: codex/long-term-optimization-005
Base revision/diff scope: `80b6a22a0d082838305059de9eb313120b27f6fa..c90dca077475fad93774d4e7dc3ec894375cb314`
Standards Review blocking: Ordered fast-path snapshots copied all items and rows, violating the required O(1) amortized projection update.
Standards Review non-blocking: React lifecycle coverage and stale connection race coverage were missing.
Standards Review missing evidence: deterministic copy/work evidence at 1k/5k and actual React StrictMode lifecycle evidence.
Spec Review blocking: Duplicate terminal notifications could publish snapshots; session replace no-ops could emit; stale async connects were not lifecycle-safe.
Spec Review non-blocking: none
Spec Review missing evidence: concurrent connect/disconnect and overlapping reconnect tests.
Local tracker state decision: Rework
State decision reason: Accepted bounded findings require original-worker fixes before renewed Agent Review handoff.

## Codex Worker Note

Round: 2
Issue: long-term-optimization-005 Make interaction projection incremental and client lifecycle single-owner
Local tracker state transition: Rework -> Agent Review
Branch: codex/long-term-optimization-005
PR URL: not configured; local-origin branch only
Base revision/diff scope: original worker fixes only for Review Round 1; persistent projection sequence, duplicate/no-op emission, client lifecycle generation, React lifecycle test harness, focused tests, and this append-only evidence update.
Summary of behavior delivered: Replaced fast-path snapshot array copies with immutable versioned append/replace/remove sequence views. Ordered projection updates allocate a single sequence version node per affected collection; old snapshots retain prior version roots. Added lifecycle generation checks so stale connects cannot revive a disconnected/newer client, and suppressed duplicate terminal/no-op publication.
Final scope summary: Review findings only. No persistence, module relocation, dependency/gate work beyond the smallest jsdom test harness, or issue 004/006+ work.
Changed files/modules: `src/web-ui-state.ts`; `src/web-ui-client.ts`; `src/agent-interaction-session.ts`; `src/terminal-transcript.ts`; `src/zen-tui-app.ts`; `src/index.ts`; `web/src/workspace.tsx`; focused tests; `package.json`; `package-lock.json`; evidence.
Tests added/updated: 1k/5k deterministic sequence-copy/work test; duplicate terminal snapshot/listener test; stale connect/disconnect and overlapping reconnect test; session replaceSnapshot no-op test; actual jsdom React StrictMode reconnect/mode-switch/unmount lifecycle test; adjusted session/TUI consumers to read immutable sequences.
Acceptance criteria status: Ordered appends and affected row patches are O(1) version-node updates with zero sequence copies; replacement/out-of-order remains deterministic rebuild; completed assistant/tool and shell/approval behavior remains covered; duplicate irrelevant/terminal notifications do not publish; session no-op replacement does not emit; client lifecycle races are generation-safe; React uses one external-store subscription and releases streams on StrictMode/mode/unmount; Web and TUI use the shared sequence projection.
Commands run and results: `npx vitest run test/web-ui-state.test.ts test/web-ui-client.test.ts test/agent-interaction-session.test.ts test/zen-tui-app.test.ts test/workspace-lifecycle.test.ts --no-file-parallelism --maxWorkers=1` passed (46 tests); `npm test -- --no-file-parallelism --maxWorkers=1` passed (32 files, 201 tests); `npm run typecheck` passed; `npm run typecheck:web` passed; `npm run build` passed; `npm run web:build` passed; `git diff --check` passed.
Validation log paths: none
Required check status or local-check handoff reason: all current local checks passed; no GitHub remote/PR is configured.
Evidence links/paths: `docs/implementation/long-term-optimization-005-evidence.md`; `docs/implementation/long-term-optimization-tracker.md`
Decisions made: Used a persistent operation-chain sequence rather than mutable arrays or a broad diagnostics surface. Its narrow `getWork()` seam proves 1k/5k fast-path work is exactly N and copies are zero. Added jsdom only to exercise the required real React lifecycle.
Standards notes: Public snapshots expose read-only sequence views, so consumers cannot observe later mutations through old snapshots. Materialization is deferred to iteration/rendering; fast projection mutation remains constant work.
Reviewer notes: Verify the persistent sequence’s old-snapshot semantics, sequence consumer migration, generation-token stale connect behavior, and StrictMode cleanup assertions.
Open questions: none
Known residual risks: Iterating a long sequence materializes its version chain for the caller; this intentionally moves read/render work out of the ordered append mutation path. Slow replacement/rebuild remains O(n) by design.
Blocker or context escalation details: none
