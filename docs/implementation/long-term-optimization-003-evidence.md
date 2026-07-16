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
