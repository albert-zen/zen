# Long-Term Optimization 007 Evidence

## Codex Worker Note

Round: 1
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Local tracker state transition: Ready -> In Progress
Branch: `codex/long-term-optimization-007`
PR URL: not used; this program remains local-branch/local-review
Base revision/diff scope: `15ef26dfeb2cbc8b4a762dc8059fed050ea3fdb0`; package tooling, release gates, Web tests, E2E fixture, docs, and tracker only
Summary of behavior delivered: Prettier, ESLint flat config, group coverage gates, deterministic Playwright Chromium workflow, readiness-driven proxy test, and behavioral Web coverage.
Final scope summary: No product architecture change. The E2E fixture composes the real AppServer, HTTP transport, and trusted Vite proxy with deterministic fake model/tool adapters.
Changed files/modules: package scripts/dependencies; lint/format/Vitest/Playwright configs; `e2e/`; Web proxy test; README; quality gates; tracker.
Tests added/updated: Playwright covers same-origin requests/SSE, streamed output before terminal result, pending approval, approve/decline, no decline execution, reconnect without duplicate output, and URL reload/resume.
Acceptance criteria status: Browser, lint, formatting, type, build, and audit gates are covered; the three coverage branch thresholds still need focused behavior tests before `npm run check` can pass and this issue may move to Agent Review.
Environment prerequisite: `npx playwright install chromium` installs the browser once; no browser secret or capability is exposed.

## Codex Worker Note

Round: 2
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Local tracker state transition: In Progress -> In Progress
Branch: `codex/long-term-optimization-007`
PR URL: not used; this program remains local-branch/local-review
Base revision/diff scope: `15ef26dfeb2cbc8b4a762dc8059fed050ea3fdb0`; taking over the existing uncommitted worker diff after a machine reboot, preserving valid prior implementation and evidence.
Summary of behavior delivered: Takeover recorded. Remaining ownership includes coverage completion and an explicit, verified E2E process supervisor with fixture shutdown safety.
Final scope summary: In progress.
Changed files/modules: evidence only at takeover; implementation inspection underway.
Tests added/updated: none at takeover.
Acceptance criteria status: Existing implementation remains in progress. Current on-disk kernel coverage clears aggregate thresholds; product and presentation require rerun after targeted behavior tests. E2E command supervision is not yet implemented.
Commands run and results: inspected uncommitted diff, coverage reports, E2E fixture, and Windows Node command lines; no Zen E2E/Vite/Vitest/Playwright-owned process was present.
Validation log paths: existing ignored `coverage/` reports.
Required check status or local-check handoff reason: not ready; exact-head check will run only after all focused work completes.
Evidence links/paths: `docs/implementation/long-term-optimization-007-evidence.md`.
Decisions made: preserve prior worker changes; serialize all check, coverage, and E2E commands; use a workspace-local ignored owned-process manifest for future E2E runs.
Standards notes: no thresholds, production exclusions, or coverage-ignore pragmas will be weakened or added.
Reviewer notes: no review requested until exact-head check passes.
Open questions: none.
Known residual risks: the prior bare Playwright command has no trustworthy child-process ownership and cleanup protocol.
Blocker or context escalation details: original worker was interrupted by machine reboot; ownership transferred to this worker.

## Codex Worker Note

Round: 3
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Local tracker state transition: In Progress -> Agent Review
Branch: `codex/long-term-optimization-007`
PR URL: not used; this program remains local-branch/local-review with local-path `origin`.
Base revision/diff scope: `15ef26dfeb2cbc8b4a762dc8059fed050ea3fdb0`; completed the inherited uncommitted release-gate, behavioral-test, browser-E2E, and local workflow documentation diff.
Summary of behavior delivered: Added Prettier, ESLint, serialized group coverage, behavioral kernel/product/presentation tests, deterministic same-origin browser workflow, and an owned Playwright supervisor. The supervisor records one direct launcher PID plus a unique marker in ignored workspace-local state, verifies marker and Windows creation identity before `taskkill /T`, uses isolated POSIX process groups, preflights only verified stale ownership, and fails if an owned child survives teardown. The fixture closes Vite, HTTP transport, and AppServer independently on normal and failed shutdown.
Final scope summary: Complete implementation handoff. Browser tests cover streamed output, approve, decline without tool execution, completion, reconnect, persisted thread resume, and same-origin proxy use. TUI/proxy behavior remains event-driven and no source-string smoke tests were added.
Changed files/modules: package quality scripts/configuration; `scripts/owned-e2e-supervisor.mjs`, `scripts/run-e2e.mjs`, and `scripts/run-playwright-child.mjs`; deterministic E2E fixture and workflows; behavioral coverage tests; local workflow/evidence/readme documentation.
Tests added/updated: owned-supervisor successful cleanup, failed launcher cleanup, stale PID/creation-marker safety, normal-child no-orphan manifest cleanup, and fixture shutdown failure; browser transport lifecycle/error and Web client action branches; ThreadManager shutdown cancellation behavior; existing event-driven proxy/TUI and real-proxy E2E coverage retained.
Acceptance criteria status: Complete. Kernel coverage: lines 89.91%, functions 93.75%, statements 89.45%, branches 81.71%. Product: 91.30%, 97.14%, 91.23%, 80.74%. Presentation: 93.01%, 94.11%, 92.18%, 80.31%. All exceed the configured 85/85/85/80 gates.
Commands run and results: `npm audit --include=dev` passed with 0 vulnerabilities. Exact `npm run check` passed in 149.2 seconds: format, lint, core/Web typecheck, 241 Vitest tests, builds, Web build, all group coverage, and 2 Playwright E2E tests.
Validation log paths: ignored `coverage/`, `test-results/`, and `.zen-e2e-owned-processes.json`; no intentional artifacts are staged.
Required check status or local-check handoff reason: exact check passed before this Agent Review transition; GitHub handoff is not applicable because `origin` is the local path `D:\desktop\zen`.
Evidence links/paths: `docs/implementation/long-term-optimization-007-evidence.md`, `docs/implementation/long-term-optimization-tracker.md`.
Decisions made: retained inherited valid work; serialized all validation; tests assert externally observable lifecycle/proxy behavior. The ignored owned-process manifest is intentionally retained empty after runs for stale-run preflight.
Standards notes: coverage thresholds/exclusions were not weakened; no coverage-ignore pragmas were introduced. Generated coverage, Playwright result, and PID-manifest paths are ignored. On Windows `taskkill /T` is invoked only after current command line contains the unique marker and current creation identity matches the recorded root child.
Reviewer notes: request a fresh-context local review of the full uncommitted issue diff. Review process supervision signal behavior and E2E fixture teardown in addition to the inherited product scope.
Open questions: none.
Known residual risks: POSIX process-group cleanup is implemented but validated here on Windows only. The local-path origin prevents GitHub PR/check handoff until a canonical remote is configured.
Blocker or context escalation details: none.

## Codex Review Note

Round: 2
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Reviewer context: user-supplied Review Round 2 after Worker Round 5
Reviewer edits: none
Reviewed branch: `codex/long-term-optimization-007`
Base revision/diff scope: `27accbb`; deterministic formatting proof and process-cleanup safety redesign.
Standards Review blocking: The prior disposable-clone formatting claim was contradictory because four tracked blobs (`web/index.html`, `tsconfig.json`, `tsconfig.build.json`, and `tsconfig.acceptance.json`) still required an exact committed-blob and `core.autocrlf=true` clone verification. Windows cleanup still allowed `taskkill /T`, and manifest cleanup was not individually leaf-first revalidated.
Standards Review non-blocking: none.
Standards Review missing evidence: exact-head clean-clone format result, independently scanned post-run Windows process result, and full online audit.
Spec Review blocking: Ownership records must include parent chains and exact marker/creation identity for every killable candidate; unverified live records must remain retained and fail safely. Actual Chromium marker propagation and missing-manifest orphan detection require behavioral proof.
Spec Review non-blocking: none.
Spec Review missing evidence: targeted supervisor cases for leaf-first individual kills, marker-required registration, root-exited marked descendants, PID reuse, unmarked descendants, independent orphan scan, and manifest-clear ordering.
Local tracker state decision: Rework
State decision reason: user accepted all Round 2 blocking findings and retained the same implementation owner until fresh review.

## Codex Worker Note

Round: 5
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Local tracker state transition: Rework -> Rework
Branch: `codex/long-term-optimization-007`
PR URL: not used; this program remains local-branch/local-review with local-path `origin`.
Base revision/diff scope: `5541075`; exact-head correction of Review Round 1 findings.
Summary of behavior delivered: Completed deterministic LF checkout policy, event-driven integration waits, full owned-process identity manifest, immediate registration for runner/launcher/fixture processes, safe verified tree cleanup, and retained-manifest failure behavior for unverified live entries.
Final scope summary: Rework implementation complete; awaiting a fresh reviewer.
Changed files/modules: `.gitattributes`; owned E2E supervisor and launcher scripts; E2E fixture registration; supervisor/Web UI/dogfood tests; tracker/evidence.
Tests added/updated: 9 focused supervisor tests cover success, pre-registration signal cleanup, real failing launcher with marked child and grandchild cleanup, stale manifest, PID reuse, root-exited unmarked descendant safety, fixture registration, and post-run empty manifest. Event-driven Web and dogfood completion tests replace polling waits.
Acceptance criteria status: Complete pending fresh review. Clean-clone baseline failure is retained in Round 4. Corrected brand-new disposable clone `D:\desktop\zen-opt-007-format-verified` passed `npm run format:check` under `core.autocrlf=true`, with `git ls-files --eol` reporting LF index/worktree. Exact `npm run check` passed with all required gates.
Commands run and results: focused supervisor test: 9 passed; focused Web/dogfood/supervisor set: 27 passed; online `npm audit --include=dev --registry=https://registry.npmjs.org`: `found 0 vulnerabilities`; exact `npm run check`: passed in 164.5 seconds with 245 Vitest tests, all builds, kernel/product/presentation coverage, and 2 Playwright E2E tests.
Validation log paths: ignored `coverage/`, `test-results/`, and `.zen-e2e-owned-processes.json`; no intentional generated artifact is staged.
Required check status or local-check handoff reason: corrected exact-head local check passed. GitHub handoff is not applicable because `origin` is the local path `D:\desktop\zen`.
Evidence links/paths: `docs/implementation/long-term-optimization-007-evidence.md`, `docs/implementation/long-term-optimization-tracker.md`.
Decisions made: taskkill uses only an exact verified marked root or separately marked child. Before termination, the manifest persists all discovered tree identities; it is cleared only after each recorded identity is independently absent. PID reuse, command-marker mismatch, and unmarked live descendants retain manifest entries and fail safely.
Standards notes: no threshold/exclusion weakening or coverage-ignore pragmas were added. Touched integration/UI/E2E files contain only bounded timeout guards racing an event; fixed polling delays were removed.
Reviewer notes: fresh review required; tracker intentionally remains `Rework`.
Open questions: none.
Known residual risks: POSIX process-group cleanup is structurally covered but was not executed on this Windows worker.
Blocker or context escalation details: none.

## Codex Review Note

Round: 1
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Reviewer context: user-supplied review after Worker Round 3
Reviewer edits: none
Reviewed branch: `codex/long-term-optimization-007`
Base revision/diff scope: `5541075`; formatting portability, owned-process tracking, fixed polling waits, and online audit evidence.
Standards Review blocking: Windows clean-clone formatting was unproven; the former supervisor tracked only one root and installed cleanup too late; fixed polling waits remained.
Standards Review non-blocking: none.
Standards Review missing evidence: online audit and cleanup cases for signal, PID reuse, root-exited descendants, and real child/grandchild failure.
Spec Review blocking: process ownership/cleanup acceptance requirements were incomplete.
Spec Review non-blocking: none.
Spec Review missing evidence: corrected exact-head check and clean-clone format result.
Local tracker state decision: Rework
State decision reason: user accepted all blocking findings and assigned the same worker to correct them.

## Codex Worker Note

Round: 4
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Local tracker state transition: Agent Review -> Rework
Branch: `codex/long-term-optimization-007`
PR URL: not used; this program remains local-branch/local-review with local-path `origin`.
Base revision/diff scope: `5541075`; correcting all Review Round 1 findings without rewriting prior history.
Summary of behavior delivered: Added an LF-enforcing `.gitattributes` policy with binary exceptions; replaced fixed polling waits with event/deferred completion plus bounded timeout guards; redesigned the owned E2E supervisor around persisted full process identities, root relations, explicit spawned-child registration, fixture-worker registration, verified tree discovery, and safe manifest retention on identity mismatch.
Final scope summary: Rework in progress pending final exact-head validation and online audit.
Changed files/modules: `.gitattributes`; `scripts/owned-e2e-supervisor.mjs`; E2E launcher and fixture registration; supervisor, Web UI, and dogfood acceptance tests.
Tests added/updated: successful tree cleanup; real failing launcher with registered marked child and grandchild; pre-registration signal cleanup; stale/PID-reuse refusal; root-exited unmarked-descendant refusal; fixture identity registration; post-run empty manifest; event-driven Web and dogfood terminal completion.
Acceptance criteria status: Baseline clone `D:\desktop\zen-opt-007-format-baseline`, configured with `core.autocrlf=true`, failed `npm run format:check` after `npm ci` with 100 formatted files reported. A corrected candidate commit made only in that disposable clone was then cloned again at `D:\desktop\zen-opt-007-format-verified`; it passed `npm run format:check`, and `git ls-files --eol` reports index/worktree LF. Targeted tests and real E2E pass with an empty version-2 manifest and no owned Windows process.
Commands run and results: baseline and corrected disposable clones both completed `npm ci`; baseline format failed and corrected format passed. Targeted Vitest: 27 tests passed, then supervisor suite: 9 tests passed. `npm run lint`, `npm run typecheck`, build, and real E2E passed during rework.
Validation log paths: disposable clone paths above; ignored `coverage/`, `test-results/`, and `.zen-e2e-owned-processes.json` remain non-staged.
Required check status or local-check handoff reason: final exact-head `npm run check` and online audit remain to run after the rework is fully formatted and staged.
Evidence links/paths: `docs/implementation/long-term-optimization-007-evidence.md`.
Decisions made: Windows `taskkill /T` is permitted only for a root or separately marked child whose live PID, creation time, parent relation, executable, command line, and unique marker match its manifest entry. A live unmarked or mismatched PID is retained and fails safely. POSIX cleanup remains process-group based.
Standards notes: no coverage threshold/exclusion weakening or coverage-ignore pragmas were added.
Reviewer notes: fresh review required after final evidence.
Open questions: none.
Known residual risks: POSIX group behavior remains structurally tested but Windows is the exercised platform.
Blocker or context escalation details: none.
