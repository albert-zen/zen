# Long-Term Optimization 003 Evidence

## Codex Worker Note

Round: 1
Issue: long-term-optimization-003 Ship auditable shell approval end to end
Local tracker state transition: Ready -> Agent Review
Branch: codex/long-term-optimization-003
PR URL: not configured
Base revision/diff scope: de54364c600ac97882ca53837269cfe2e3426348; approval/tool runtime, AppServer/protocol/provider/session, Web/TUI controls, focused tests, and this evidence only
Summary of behavior delivered: AppServer owns the one-shot approval broker; real provider shell execution requires approval; direct approval Items and notifications are emitted; exact tuple resolution and interrupt decline cleanup are enforced; Web and TUI use pending-row tuples.
Final scope summary: Issue 003 only. No persistence, projection, module relocation, dependency/gate, or issue 004+ work.
Changed files/modules: src/approval-runtime.ts; src/local-tool-runtime.ts; src/tool-runtime.ts; src/thread-manager.ts; src/app-server.ts; src/app-server-protocol.ts; src/provider-runtime.ts; src/agent-loop.ts; src/agent-interaction-session.ts; src/web-ui-client.ts; src/web-ui-state.ts; src/zen-tui-app.ts; src/slash-commands.ts; web/src/workspace.tsx; focused tests.
Tests added/updated: broker/runtime direct-item tests; LocalToolRuntime explicit approval tests; AppServer mismatch/duplicate/decline notification test; existing protocol/state/transcript tests updated to approveOnce.
Acceptance criteria status: approveOnce/decline only: complete; shell no-start before approval: complete; AppServer-owned exact broker tuple: complete; first-class approval Items: complete; decline ordering/no execution: complete; interrupt resolves pending as decline and clears broker before abort: complete; Web exact tuple controls with duplicate-click disable/error surfacing: complete; TUI /approve and /decline exact tuple actions: complete.
Commands run and results: npm ci passed; focused Vitest 003 suites passed (8 files, 55 tests); npm run typecheck passed; npm run typecheck:web passed; npm run build passed; npm run web:build passed; git diff --check passed. The required npm test completion run was bounded at 60 seconds and terminated after no output while still live; see residual risk.
Validation log paths: none
Required check status or local-check handoff reason: all required gates except full npm test complete; full suite process hangs without output in this workspace and was bounded rather than left running.
Evidence links/paths: docs/implementation/long-term-optimization-003-evidence.md
Decisions made: LocalToolRuntime without an injected ApprovalBroker fails before subprocess creation; fake runtimes remain explicitly injectable. Interrupt settlement uses decline with reason Turn interrupted.
Standards notes: approval lifecycle is represented by ItemList facts rather than nested tool deltas or parallel approval state.
Reviewer notes: Fresh reviewer should verify full-suite behavior and resolve-vs-interrupt FIFO continuation coverage.
Open questions: none
Known residual risks: Complete npm test could not be observed to completion because the process remained live without output; this requires review environment diagnosis. The focused suite does not independently cover the Web component click rendering path or TUI command dispatch.
Blocker or context escalation details: the required full-suite run was terminated at its 60-second bound with no emitted results.

## Codex Review Note

Round: 1
Issue: long-term-optimization-003 Ship auditable shell approval end to end
Reviewer context: fresh
Reviewer edits: none
Reviewed branch: codex/long-term-optimization-003
Base revision/diff scope: de54364c600ac97882ca53837269cfe2e3426348..9f6664e; issue 003 implementation and evidence
Standards Review blocking: Full npm test hang was unresolved and not demonstrated against the base revision.
Standards Review non-blocking: none
Standards Review missing evidence: Public behavioral coverage for Web approval controls and TUI approval commands was missing.
Spec Review blocking: The hanging full suite blocked completion-gate acceptance.
Spec Review non-blocking: none
Spec Review missing evidence: Deterministic Web click/submission-state and TUI command-dispatch evidence.
Local tracker state decision: Rework
State decision reason: Both findings were accepted as material by the issue owner.

## Codex Worker Note

Round: 2
Issue: long-term-optimization-003 Ship auditable shell approval end to end
Local tracker state transition: Rework -> Agent Review
Branch: codex/long-term-optimization-003
PR URL: not configured
Base revision/diff scope: 9f6664e; only accepted review findings: full-suite completion and Web/TUI approval interaction tests
Summary of behavior delivered: Fixed the dogfood real-shell fixture to explicitly resolve AppServer approval notifications; added WebUiClient exact-tuple submission coverage and virtual-terminal TUI approve/decline command dispatch coverage.
Final scope summary: Accepted 003 review findings only. No unrelated product or test-infrastructure work.
Changed files/modules: test/dogfood-acceptance.test.ts; test/web-ui-client.test.ts; test/zen-tui-app.test.ts; docs/implementation/long-term-optimization-003-evidence.md.
Tests added/updated: Dogfood fixture injects and resolves the server broker; WebUiClient exact tuple submission assertion; virtual terminal /approve and /decline tuple dispatch assertion.
Acceptance criteria status: Full suite completion: complete. Web approval submission exact tuple: complete. TUI explicit command tuple dispatch: complete. Original approval acceptance remains complete.
Commands run and results: Base de54364 npm test passed (29 files, 189 tests, 22.14s). Current dogfood test passed (4 tests). Current focused dogfood/Web/TUI tests passed (3 files, 24 tests). Current npm test passed (30 files, 192 tests, 18.68s). npm run typecheck and git diff --check passed.
Validation log paths: none
Required check status or local-check handoff reason: Required npm test now completes normally. Typecheck and diff check rerun because tests changed; builds not rerun because no production build wiring changed.
Evidence links/paths: docs/implementation/long-term-optimization-003-evidence.md
Decisions made: The dogfood harness explicitly supplies approvals through AppServer notifications rather than weakening LocalToolRuntime. This keeps real-shell approval mandatory and makes the test user-decision behavior explicit.
Standards notes: The repair preserves the item-first approval lifecycle and tests user-facing command/client paths without source-string assertions.
Reviewer notes: Round 1 accepted findings addressed; ready for a fresh review.
Open questions: none
Known residual risks: none known for the accepted findings.
Blocker or context escalation details: Root cause was the dogfood scripted model repeating shell calls after an unapproved LocalToolRuntime produced a tool error and no model-visible tool result. The base suite passed under the same command; the repaired branch now passes normally.

## Codex Review Note

Round: 2
Issue: long-term-optimization-003 Ship auditable shell approval end to end
Reviewer context: fresh
Reviewer edits: none
Reviewed branch: codex/long-term-optimization-003
Base revision/diff scope: 9f6664e..b6f96ca; Round 2 review of accepted Round 1 fixes
Standards Review blocking: Deterministic resolve-versus-interrupt FIFO coverage was missing.
Standards Review non-blocking: Workspace approval controls remained disabled after a rejected resolve request.
Standards Review missing evidence: Both broker-consume ordering cases and retry behavior after a rejected UI action.
Spec Review blocking: The two linearizable approval/interrupt interleavings and FIFO continuation were not proven.
Spec Review non-blocking: none
Spec Review missing evidence: Public behavior test coverage for the accepted race and UI retry cases.
Local tracker state decision: Rework
State decision reason: Manager accepted the race and retry-state findings; proxy transient was deferred to issue 007.

## Codex Worker Note

Round: 3
Issue: long-term-optimization-003 Ship auditable shell approval end to end
Local tracker state transition: Rework -> Agent Review
Branch: codex/long-term-optimization-003
PR URL: not configured
Base revision/diff scope: b6f96ca; only accepted Round 2 race coverage and workspace retry-state findings
Summary of behavior delivered: Added deterministic AppServer tests for interrupt-first stale resolution and approve-first interrupted shell execution, both with broker cleanup and same-thread FIFO continuation. Restored workspace approval control retry after a rejected resolve request while preserving surfaced errors.
Final scope summary: Accepted Round 2 findings only. Proxy infrastructure was not changed and remains deferred to issue 007.
Changed files/modules: test/approval-race.test.ts; test/web-ui-client.test.ts; web/src/workspace.tsx; docs/implementation/long-term-optimization-003-evidence.md; docs/implementation/long-term-optimization-tracker.md.
Tests added/updated: Deferred-barrier AppServer race tests for both linearization orders; Web client reject-then-retry action test.
Acceptance criteria status: Interrupt-first stale resolution/no shell/FIFO continuation: complete. Approve-first shell start/abort/FIFO continuation: complete. Broker empty after both interleavings: complete. Workspace resolve retry after rejection: complete. Deferred proxy item: unchanged, issue 007.
Commands run and results: Focused approval/AppServer/Web/TUI tests passed (4 files, 24 tests). npm run typecheck passed. npm run typecheck:web passed. npm run web:build passed. git diff --check passed. Serialized npm test -- --maxWorkers=1 passed (31 files, 195 tests, 53.72s).
Validation log paths: none
Required check status or local-check handoff reason: All requested Round 2 validation completed. Web build rerun because workspace production wiring changed.
Evidence links/paths: docs/implementation/long-term-optimization-003-evidence.md
Decisions made: The tests use deferred promises and notification barriers only; no sleeps. Interrupt-first consumes the broker entry before stale resolution; approve-first observes shell start before abort.
Standards notes: The workspace handler restores only local in-flight state on rejection, leaving the connection error surfaced by the parent action.
Reviewer notes: Round 2 accepted findings addressed; ready for fresh review.
Open questions: none
Known residual risks: none known for the accepted findings.
Blocker or context escalation details: none
