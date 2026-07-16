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
