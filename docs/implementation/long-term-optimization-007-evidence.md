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

Round: 7 integration-gate correction
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Reviewer context: canonical integration gate at merge `776ccedf` failed after the prior STRICT PASS.
Reviewer edits: none
Reviewed revision: `3fb9ee5487b2debc9aed969bbd4c00cb11a80141`
Finding: P1. Supervisor cleanup mixed many independent WMI `inspect` and `list` snapshots and compared opaque creation strings. This produced temporal ancestry false refusals (`predates ancestry parent` and `failed exact identity validation`) in the real failing-launcher test, despite zero residual processes.
Local tracker state decision: Rework
State decision reason: manager accepted the reproducible integration failure; previous strict-pass claims remain historical and superseded for the integration gate.

## Codex Worker Note

Round: 12
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Local tracker state transition: Complete -> Rework
Summary of behavior delivered: supervisor cleanup now uses one coherent snapshot for each discovery/validation pass and exactly one fresh snapshot immediately before an individual kill. Win32 process creation identity is normalized at the query boundary to UTC ticks and ISO UTC text; custom test entries retain compatible fallback identity handling. Spawn registration waits conditionally for the marker-bearing WMI identity rather than accepting a transient incoherent observation.
Validation: direct real supervisor suite passed 5 consecutive repetitions, each 17 tests, in 6.88s, 6.92s, 6.95s, 7.06s, and 7.11s; zero residual process scan remains required after final gates.
Acceptance criteria status: Rework pending fresh review and final full gates.

## Codex Review Note

Round: 7
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Reviewer context: fresh Review Round 7 strict review accepted by manager
Reviewer edits: none
Reviewed branch: `codex/long-term-optimization-007`
Reviewed revision: `3fb9ee5487b2debc9aed969bbd4c00cb11a80141`
Base revision/diff scope: exact reviewed head only; no implementation edits requested.
Standards Review blocking: none.
Standards Review non-blocking: none.
Standards Review missing evidence: none.
Spec Review blocking: none.
Spec Review non-blocking: none.
Spec Review missing evidence: none.
Validation reviewed: focused process/runtime/supervisor/TUI suite: 53 tests passed; format, lint, TypeScript typechecks, and `git diff --check` passed; online `npm audit --include=dev` reported `found 0 vulnerabilities`; attributable Win32 Node/Vite/Vitest/Playwright/Chromium process scan reported zero matches. This review relies on the already-recorded exact-head full check: 260 unit tests and 2 E2E tests passed.
Local tracker state decision: Complete
State decision reason: STRICT PASS with no reasonable findings; manager accepted the pass. Wave 5 integration remains a separate, not-yet-completed step.

## Codex Worker Note

Round: 10 correction
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Correction reason: the prior Round 10 note recorded the first passing 230.5-second aggregate check. A subsequent root-close cleanup-path correction was made before commit, so that run is not the final exact-head validation.
Corrected exact-head result: after the root-close change, focused ownership/runtime/supervisor/TUI tests passed (42 tests), and `npm run check` passed in 247.7 seconds: 34 test files/257 tests, all builds, kernel 89.45 statements/81.71 branches/93.75 functions/89.91 lines, product 91.23/80.74/97.14/91.30, presentation 92.18/80.31/94.11/93.01, and 2 Playwright E2E tests. Online `npm audit --include=dev --registry=https://registry.npmjs.org` again reported `found 0 vulnerabilities`; `git diff --check` passed; the independent constructed-marker/path Win32 Node/Vite/Vitest/Playwright/Chromium scan again reported zero matches. This correction appends without rewriting prior history.

## Codex Review Note

Round: 4
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Reviewer context: user-supplied Review Round 4 on `355e3f59b6549fcbf75f910a7dc4e8494222522f`
Reviewer edits: none
Reviewed branch: `codex/long-term-optimization-007`
Base revision/diff scope: LocalToolRuntime ownership cleanup and direct TUI post-action synchronization.
Standards Review blocking: LocalToolRuntime used recursive Windows `taskkill /T /F`; direct TUI sleeps and the shell fixture phase delay were scheduler-dependent.
Standards Review non-blocking: none.
Standards Review missing evidence: verified leaf-first cleanup, mismatch refusal, timeout/abort zero-residue behavior, and exact-head validation.
Spec Review blocking: remove broad taskkill and replace direct sleeps with observable synchronization.
Spec Review non-blocking: bounded AppServer CLI/journal condition polling and watchdogs are not defects; do not churn them.
Spec Review missing evidence: targeted tests, audit, and final process scan.
Local tracker state decision: Rework
State decision reason: manager accepted LocalToolRuntime and direct TUI timing findings, and rejected mechanical removal of condition-driven timers.

## Codex Worker Note

Round: 9
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Local tracker state transition: Rework -> Rework
Branch: `codex/long-term-optimization-007`
PR URL: not used; local-path origin.
Base revision/diff scope: `355e3f5` through `65b57b1cc98cd9976f9f7b275dac87b0d624d86e`.
Summary of behavior delivered: Replaced LocalToolRuntime recursive taskkill with `OwnedProcessTree`, which captures a directly spawned PowerShell root, verifies exact creation/executable/command/parent-chain identities, and terminates verified processes individually leaf-first. Uncertain or reused identities are skipped. Abort handling is installed before spawn through an explicit holder. Direct TUI post-action sleeps and the 50 ms shell fixture delay now use observable transcript/deferred synchronization.
Final scope summary: Round 4 implementation complete; tracker remains Rework pending fresh review.
Changed files/modules: LocalToolRuntime; new Node process ownership helper and tests; TUI tests; evidence/tracker.
Tests added/updated: deterministic leaf-first cleanup, root reuse and changed descendant-chain refusal, repeated timeout/abort zero-residue cleanup, existing LocalToolRuntime tests, and event/deferred TUI phase tests.
Acceptance criteria status: `rg taskkill src scripts` has no source/script matches. No recursive or broad Node kill was introduced.
Commands run and results: targeted runtime/process/TUI tests: 24 passed; lint and typecheck passed; exact `npm run check` passed warning-free in 196.2 seconds with 34 files/252 tests, all group coverage gates, and 2 E2E tests. Online `npm audit --include=dev --registry=https://registry.npmjs.org`: `found 0 vulnerabilities`. `git diff --check` passed.
Validation log paths: ignored coverage/test-results/Playwright/PID artifacts only.
Required check status or local-check handoff reason: exact local validation passed; tracker remains Rework for fresh review.
Evidence links/paths: `docs/implementation/long-term-optimization-007-evidence.md`, `docs/implementation/long-term-optimization-tracker.md`.
Decisions made: only exact verified identities are individually terminated; unmatched descendants remain untouched. Rejected bounded condition polling/watchdog timers were left unchanged.
Standards notes: no coverage thresholds, exclusions, or coverage-ignore pragmas changed.
Reviewer notes: fresh review required.
Open questions: none.
Known residual risks: POSIX behavior remains structurally covered only on this Windows worker.
Blocker or context escalation details: final independent marker/path process scan returned zero owned Zen E2E/Vite/Vitest/Playwright/Chromium processes.

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

Round: 6
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Local tracker state transition: Rework -> Rework
Branch: `codex/long-term-optimization-007`
PR URL: not used; this program remains local-branch/local-review with local-path `origin`.
Base revision/diff scope: `27accbb` through `41f3a96de7225512f4b84937b04e5db4139d8f57`, plus this final evidence append.
Summary of behavior delivered: Removed all Windows `taskkill /T` use. The supervisor installs cleanup handlers before spawning, immediately records verified spawned identities, persists marker-owned candidate parent chains, revalidates each identity and chain before individual leaf-first termination, and retains any unverified live record. Manifest deletion requires recorded identity absence plus an independent Win32 marker scan with zero matches. Chromium receives an observable launch marker; Vite and AppServer are in-process fixture resources closed explicitly by the fixture.
Final scope summary: Round 2 rework is complete and remains Rework pending fresh review.
Changed files/modules: supervisor, Playwright config/workflow/fixture, supervisor tests, evidence, and local tracker.
Tests added/updated: 12 focused supervisor tests cover leaf-first exact kills, marker-required registration, root-exited descendant cleanup, PID reuse, unmarked process retention, independent orphan scans, manifest clear ordering, real failing child/grandchild, normal cleanup, SIGTERM cleanup, identity matching, and fixture close failure. The real E2E observes a live Chromium command line containing `--zen-e2e-owner=<marker>`.
Acceptance criteria status: satisfied. Correction to prior history: Worker Round 4/5's disposable-clone formatting claim was insufficient. A new clone of `41f3a96` at `D:\desktop\zen-opt-007-round2-format-clone`, configured with `core.autocrlf=true`, reports LF index/worktree entries for `.gitattributes`, `web/index.html`, `tsconfig.json`, `tsconfig.build.json`, and `tsconfig.acceptance.json`; after `npm ci`, `npm run format:check` passes. This correction is appended without altering prior notes.
Commands run and results: Prettier on the four cited files; `git diff --check`; focused supervisor tests (12 passed); focused lint/supervisor/Web UI tests (27 passed); real E2E (2 passed); clean-clone `npm ci` and format check passed; isolated presentation coverage rerun passed (33 files, 248 tests); online `npm audit --include=dev --registry=https://registry.npmjs.org` retried after a transient TLS failure and returned `found 0 vulnerabilities`; exact `npm run check` passed in 190.2 seconds with 248 Vitest tests, all builds, coverage groups, and 2 E2E tests. Each experimental E2E/check run and the final gate had a zero-result Win32 marker scan.
Validation log paths: `D:\desktop\zen-opt-007-round2-format-clone`; ignored coverage, test-results, Playwright artifacts, and PID manifests are not evidence artifacts.
Required check status or local-check handoff reason: exact local check and online audit passed; local-path origin has no GitHub handoff. Tracker stays Rework for fresh review.
Evidence links/paths: `docs/implementation/long-term-optimization-007-evidence.md`, `docs/implementation/long-term-optimization-tracker.md`.
Decisions made: Windows uses only `Stop-Process -Id <verified pid> -Force`, never a recursive tree kill. A candidate missing exact marker, creation identity, command fingerprint, executable, parent relation, or parent chain is not killable. Immediate registration failure uses the live `ChildProcess` handle.
Standards notes: no coverage thresholds, exclusions, or coverage-ignore pragmas were weakened. Integration waits are event/deferred driven; the supervisor's 250 ms startup guard races the child's exit event.
Reviewer notes: fresh review required; tracker intentionally remains Rework.
Open questions: none.
Known residual risks: POSIX individual `SIGTERM` behavior is structurally implemented but not exercised on this Windows worker. An abrupt machine kill before JavaScript handlers run can only be addressed by next-startup safe preflight.
Blocker or context escalation details: none.

## Codex Worker Note

Round: 7
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Local tracker state transition: Rework -> Rework
Branch: `codex/long-term-optimization-007`
PR URL: not used; this program remains local-branch/local-review with local-path `origin`.
Base revision/diff scope: `fb195e8`; final descendant-discovery and Windows-safe signal-test correction.
Summary of behavior delivered: Candidate discovery now persists every descendant of a marker-owned process before cleanup, including an unmarked descendant that must be retained and fail safe. The SIGTERM handler test no longer sends a Windows process-killing signal; it drives the installed handler through an injected event emitter and exit-code sink, proving cleanup behavior without destabilizing Vitest workers.
Final scope summary: complete rework awaiting fresh review.
Changed files/modules: `scripts/owned-e2e-supervisor.mjs`; `test/owned-e2e-supervisor.test.mjs`; evidence/tracker.
Tests added/updated: the unmarked-descendant test now proves discovery, manifest persistence, and refusal to terminate. Signal cleanup is deterministic and coverage-safe. Focused supervisor tests: 12 passed.
Acceptance criteria status: all Round 2 requirements remain satisfied. The final exact check is clean rather than merely exit-code clean.
Commands run and results: targeted supervisor tests and isolated kernel/product coverage passed with 33 files and 248 tests. Final exact `npm run check` passed in 256.2 seconds: format, lint, both typechecks, 248 unit tests, builds, Web build, kernel/product/presentation coverage, and 2 E2E tests. Final online `npm audit --include=dev --registry=https://registry.npmjs.org` returned `found 0 vulnerabilities`. Final `git diff --check` passed.
Validation log paths: ignored coverage/test-results/Playwright/PID artifacts only; none are staged.
Required check status or local-check handoff reason: exact-head local validation passed; tracker remains Rework pending fresh review.
Evidence links/paths: `docs/implementation/long-term-optimization-007-evidence.md`, `docs/implementation/long-term-optimization-tracker.md`.
Decisions made: no Windows process is killed through a recursive tree command. The final independent Win32 command-line scan, using the dynamically assembled owner marker, found zero owned Zen E2E/Vite/Vitest/Playwright/Chromium processes.
Standards notes: no thresholds, exclusions, or coverage-ignore pragmas changed.
Reviewer notes: fresh reviewer required; no Agent Review transition has been made.
Open questions: none.
Known residual risks: POSIX individual-process cleanup is structurally covered but not exercised on this Windows machine.
Blocker or context escalation details: none.

## Codex Review Note

Round: 5
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Reviewer context: user-supplied Review Round 5 on exact head `f02706ba2c82bacd5724033eb027e138b36fc2cd`
Reviewer edits: none
Reviewed branch: `codex/long-term-optimization-007`
Base revision/diff scope: `f02706ba2c82bacd5724033eb027e138b36fc2cd`; owned-process quiescence and LocalToolRuntime cleanup ownership.
Standards Review blocking: `OwnedProcessTree.terminateVerified` used one discovery snapshot, so descendants created during termination could be missed. `LocalToolRuntime` launched capture and termination through unobserved promises and could report cancellation without waiting for cleanup.
Standards Review non-blocking: none.
Standards Review missing evidence: deterministic late-descendant, non-quiescence, cleanup-failure, and exact-once cleanup tests; fresh exact-head gate and process scan.
Spec Review blocking: supervisor manifest cleanup must repeatedly discover, persist, revalidate, and terminate one verified leaf at a time until stable zero ownership, or retain evidence and fail at a bounded limit.
Spec Review non-blocking: none.
Spec Review missing evidence: targeted process/runtime/supervisor results, exact check, online audit, diff check, and independent final marker/path scan.
Local tracker state decision: Rework
State decision reason: user accepted both ownership-race findings; this worker remains implementation owner pending fresh review.

## Codex Worker Note

Round: 10
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Local tracker state transition: Rework -> Rework
Branch: `codex/long-term-optimization-007`
PR URL: not used; this program remains local-branch/local-review with local-path `origin`.
Base revision/diff scope: `f02706ba2c82bacd5724033eb027e138b36fc2cd` through the pending Round 5 fix commit.
Summary of behavior delivered: `OwnedProcessTree` now retains creation-qualified candidate chains, rescans between individual deepest-first stops, permits an already-exited recorded ancestor only when no recorded ancestor PID has been reused, requires two independent zero scans, and fails at a bounded pass budget instead of claiming cleanup success. `LocalToolRuntime` owns one capture/cleanup task; cancellation, timeout, and generator-finalizer paths retain and await it before emitting their terminal outcome, and surface cleanup failures as aggregate tool errors. The E2E manifest supervisor now discovers/persists/revalidates one exact leaf per pass until quiescence, retains late unmarked descendants as failure evidence, and fails without clearing its manifest when the pass budget is exhausted.
Final scope summary: Accepted Review Round 5 ownership races fixed; tracker remains Rework pending fresh reviewer.
Changed files/modules: `src/adapters/node/owned-process-cleanup.ts`, `src/adapters/node/local-tool-runtime.ts`, `scripts/owned-e2e-supervisor.mjs`, focused ownership/supervisor tests, evidence, and tracker.
Tests added/updated: ownership primitive tests cover late descendants, multiple generations, PID-reuse refusal, zero residue, cleanup failure propagation, and exactly-once provider invocation. Supervisor tests cover marked late discovery, late unmarked retention/no-kill, and bounded non-quiescence. Focused runtime/process/TUI command: 4 files, 42 tests passed.
Acceptance criteria status: complete pending fresh review. The first Round 5 aggregate run stopped at lint because cleanup event invocations were not explicitly observed; this was corrected before the accepted exact run. No threshold, exclusion, coverage-ignore, recursive taskkill, or broad Node kill was added.
Commands run and results: `npm run check` passed in 230.5 seconds: format/lint/typechecks/builds; 34 test files/257 tests; kernel 89.45 statements/81.71 branches/93.75 functions/89.91 lines; product 91.23/80.74/97.14/91.30; presentation 92.18/80.31/94.11/93.01; 2 Playwright E2E tests passed. Online `npm audit --include=dev --registry=https://registry.npmjs.org`: `found 0 vulnerabilities`. `git diff --check` passed. Independent Win32 command-line scan for constructed `zen-e2e-` and workspace marker fragments across Node/Vite/Vitest/Playwright/Chromium found zero matches; no process was terminated by the scan.
Validation log paths: ignored coverage, test-results, Playwright artifacts, and PID manifests remain untracked and are not evidence artifacts.
Required check status or local-check handoff reason: exact local check and online audit passed; local-path origin has no GitHub handoff. Fresh reviewer remains required by the tracker.
Evidence links/paths: `docs/implementation/long-term-optimization-007-evidence.md`, `docs/implementation/long-term-optimization-tracker.md`.
Decisions made: cleanup is deliberately conservative: a reused PID, changed chain, or unmarked late descendant is retained and reported rather than terminated. Quiescence requires fresh discovery after every individual stop and two zero-owned scans.
Standards notes: no `taskkill /T` exists in tracked source or scripts; Windows cleanup uses individual exact identity checks only.
Reviewer notes: tracker intentionally remains Rework until a fresh reviewer accepts the new exact head.
Open questions: none.
Known residual risks: POSIX individual-process cleanup is structurally covered but not exercised on this Windows machine; a hostile child that continually creates valid marked descendants will intentionally leave retained manifest evidence after the bounded failure.
Blocker or context escalation details: none.

## Codex Review Note

Round: 3
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Reviewer context: user-supplied Review Round 3 after Worker Round 7
Reviewer edits: none
Reviewed branch: `codex/long-term-optimization-007`
Base revision/diff scope: `3adcd6a`; committed formatting verification, unmarked registration safety, and pre-registration launcher cleanup.
Standards Review blocking: The required clean-clone proof must inspect newly committed blobs, not an uncommitted checkout. An unmarked registered child must never be terminated. `run-playwright-child.mjs` lacks handlers before its spawn.
Standards Review non-blocking: none.
Standards Review missing evidence: clone hash, byte-level blob inspection, exact-head check, audit, and final owned-process scan.
Spec Review blocking: process ownership requirements are incomplete until failed marker verification retains the live identity and a deterministic pre-registration signal/failure test proves no orphan.
Spec Review non-blocking: none.
Spec Review missing evidence: focused supervisor results and committed-clone formatting result.
Local tracker state decision: Rework
State decision reason: user accepted all Round 3 findings and retained the same implementation owner.

## Codex Worker Note

Round: 8
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Local tracker state transition: Rework -> Rework
Branch: `codex/long-term-optimization-007`
PR URL: not used; this program remains local-branch/local-review with local-path `origin`.
Base revision/diff scope: `3adcd6a` through `ffc4272ec744bde18af547c1dabe3fd4a173ddca`; Round 3 correction and exact-head validation.
Summary of behavior delivered: Prettier was run on `web/index.html`, all four repository tsconfig files, and `web/tsconfig.json`; tracked text was staged with `git add --renormalize`. Failed marker verification now writes an `unverified-<role>` live identity into the manifest and never calls the child kill provider. `runOwnedCommand` and `run-playwright-child.mjs` install handlers before spawn using child/registration holders; a pre-registration signal waits for marker verification and individually cleans the verified child without orphaning it.
Final scope summary: Round 3 rework complete; tracker remains Rework pending fresh review.
Changed files/modules: supervisor, Playwright child launcher, supervisor tests, `web/tsconfig.json` formatting, evidence/tracker.
Tests added/updated: focused supervisor suite now has 13 tests, including unmarked registration retain/no-kill and an injected pre-registration signal cleanup test. The test asserts the direct child kill provider is not called in either safe path.
Acceptance criteria status: The actual committed blob bytes at `ffc4272ec744bde18af547c1dabe3fd4a173ddca` are LF-only: `web/index.html` (298 bytes/12 LF), `tsconfig.json` (293/12), `tsconfig.build.json` (275/12), `tsconfig.acceptance.json` (222/11), and `web/tsconfig.json` (534/18), all with zero CR bytes. A brand-new clone at `D:\desktop\zen-opt-007-round3-format-clone-final`, created from that commit with `core.autocrlf=true`, reports LF index/worktree entries and passes `npx prettier --check` for all five files. This appends the requested committed-blob correction without altering prior notes.
Commands run and results: focused supervisor tests: 13 passed; first exact check stopped at lint and was corrected; a first full check had an intermittent Vitest presentation-worker warning and was not accepted; isolated presentation coverage then passed (33 files/249 tests); final exact `npm run check` passed warning-free in 181.5 seconds with 249 tests, all builds, all group coverage, and 2 E2E tests. Online `npm audit --include=dev --registry=https://registry.npmjs.org`: `found 0 vulnerabilities`.
Validation log paths: clone path above; ignored coverage/test-results/Playwright/PID artifacts only and none are staged.
Required check status or local-check handoff reason: exact-head local check, online audit, blob inspection, and fresh-clone format proof passed. Local-path origin has no GitHub handoff; fresh review remains required.
Evidence links/paths: `docs/implementation/long-term-optimization-007-evidence.md`, `docs/implementation/long-term-optimization-tracker.md`.
Decisions made: only verified marker-owned children may be individually terminated. A live unmarked child is evidence, not a cleanup target. Spawn commands pass the marker explicitly; marker absence is a retained diagnosis failure.
Standards notes: `.gitattributes` remains LF enforcing and no platform-dependent Prettier setting, coverage threshold/exclusion, or coverage-ignore pragma was added.
Reviewer notes: tracker intentionally remains Rework until a fresh reviewer accepts this exact head.
Open questions: none.
Known residual risks: POSIX individual-process cleanup is structurally covered but not exercised on this Windows machine.
Blocker or context escalation details: none.

## Codex Worker Note

Round: 10 terminal correction
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Evidence ordering correction: the document contains pre-existing non-chronological append-only history. The preceding Round 10 correction is retained where the generic context inserted it; this terminal note records the final result without moving or rewriting any historical entry.
Corrected exact-head result: after the root-close cleanup-path correction, focused ownership/runtime/supervisor/TUI tests passed (42 tests), and `npm run check` passed in 247.7 seconds: 34 test files/257 tests, all builds, kernel 89.45 statements/81.71 branches/93.75 functions/89.91 lines, product 91.23/80.74/97.14/91.30, presentation 92.18/80.31/94.11/93.01, and 2 Playwright E2E tests. Online `npm audit --include=dev --registry=https://registry.npmjs.org` again reported `found 0 vulnerabilities`; `git diff --check` passed; the independent constructed-marker/path Win32 Node/Vite/Vitest/Playwright/Chromium scan again reported zero matches. No process was killed by this scan.
Local tracker state: Rework pending fresh reviewer.

## Codex Review Note

Round: 6
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Reviewer context: user-supplied Review Round 6 on exact head `fafd920eefac25a5423219995b0601c034d8b827`
Reviewer edits: none
Reviewed branch: `codex/long-term-optimization-007`
Base revision/diff scope: `fafd920eefac25a5423219995b0601c034d8b827`; retained ancestry and post-root-exit cleanup discovery.
Standards Review blocking: cleanup discovery was anchored only in currently live roots or marked processes. When a recorded root exited, an unmarked late child linked by its historical parent PID could escape two empty scans and allow false manifest success.
Standards Review non-blocking: none.
Standards Review missing evidence: exact absent-root marked/unmarked reproductions, root-termination late-child behavior, explicit root-capture absence behavior, and fresh final gates.
Spec Review blocking: retain creation-qualified ancestry through terminal cleanup; discover recursively from retained anchors even when absent; refuse root PID reuse; preserve unmarked descendants as evidence; distinguish short-lived normal completion from required cleanup with no captured root.
Spec Review non-blocking: none.
Spec Review missing evidence: focused ownership/runtime/supervisor tests, exact check, online audit, diff check, and independent final process scan.
Local tracker state decision: Rework
State decision reason: user accepted both P1 counterexamples; worker remains owner pending a fresh review.

## Codex Worker Note

Round: 11
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Local tracker state transition: Rework -> Rework
Branch: `codex/long-term-optimization-007`
PR URL: not used; this program remains local-branch/local-review with local-path `origin`.
Base revision/diff scope: `fafd920eefac25a5423219995b0601c034d8b827` through the pending Round 6 fix commit.
Summary of behavior delivered: cleanup now keeps a creation-qualified ancestry ledger through its terminal decision. The Node owned-process tree discovers recursively from every retained ancestry identity even after the root has exited, rejects a live PID whose identity differs from the ledger, and retains historical chains for post-root-exit revalidation. The E2E manifest supervisor applies the same ancestry-aware discovery: late marked descendants are persisted with inherited ancestry and individually terminated; late unmarked descendants are persisted as `unverified-ancestry-descendant` evidence and fail without termination. Local runtime root capture now returns an explicit boolean; normal close tolerates a root that completed before capture, while cancellation, timeout, or finalization requiring cleanup reports missing root ownership as a cleanup error.
Final scope summary: Accepted Review Round 6 P1 ancestry races fixed; tracker remains Rework pending fresh reviewer.
Changed files/modules: `src/adapters/node/owned-process-cleanup.ts`, `src/adapters/node/local-tool-runtime.ts`, `scripts/owned-e2e-supervisor.mjs`, focused ownership/supervisor tests, evidence, and tracker.
Tests added/updated: 45 focused ownership/runtime/supervisor/TUI tests passed. Added deterministic root-termination late-child discovery, root-capture absence refusal, and absent-root/live-unmarked-child manifest reproduction with `terminated=[]`. Existing marked absent-root and root PID-reuse cases continue to pass.
Acceptance criteria status: complete pending fresh review. No recursive `taskkill`, broad Node kill, coverage threshold/exclusion, or coverage-ignore pragma was added.
Commands run and results: `npm run check` passed in 247.3 seconds: format/lint/typechecks/builds; 34 test files/260 tests; kernel 89.45 statements/81.71 branches/93.75 functions/89.91 lines; product 91.23/80.74/97.14/91.30; presentation 92.18/80.31/94.11/93.01; 2 Playwright E2E tests passed. Online `npm audit --include=dev --registry=https://registry.npmjs.org`: `found 0 vulnerabilities`. `git diff --check` passed. Independent constructed-marker/path Win32 Node/Vite/Vitest/Playwright/Chromium scan found zero matches; no process was terminated by that scan.
Validation log paths: ignored coverage, test-results, Playwright artifacts, and PID manifests remain untracked and are not evidence artifacts.
Required check status or local-check handoff reason: exact local check and online audit passed; local-path origin has no GitHub handoff. Fresh reviewer remains required by the tracker.
Evidence links/paths: `docs/implementation/long-term-optimization-007-evidence.md`, `docs/implementation/long-term-optimization-tracker.md`.
Decisions made: a missing historical parent is not permission to forget ownership. It remains an ancestry anchor unless its PID is live with a different identity, which fails safely. A normal already-completed process is distinct from a cancellation/timeout/finalizer cleanup request that cannot prove root ownership.
Standards notes: Windows termination remains individual and identity-validated; no `taskkill /T` remains in tracked source or scripts.
Reviewer notes: tracker intentionally remains Rework until a fresh reviewer accepts the new exact head.
Open questions: none.
Known residual risks: POSIX individual-process cleanup is structurally covered but not exercised on this Windows machine; an unmarked retained descendant intentionally leaves manifest evidence for operator diagnosis rather than being killed.
Blocker or context escalation details: none.

## Codex Review Note

Round: 7 terminal record
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Evidence ordering note: the prior Round 7 entry is preserved in its legacy matched position. This terminal append records the same manager-accepted closeout without rewriting historical evidence.
Reviewer context: fresh Review Round 7 strict review accepted by manager
Reviewer edits: none
Reviewed branch and revision: `codex/long-term-optimization-007 @ 3fb9ee5487b2debc9aed969bbd4c00cb11a80141`
Review result: STRICT PASS; no reasonable findings.
Validation reviewed: focused process/runtime/supervisor/TUI suite: 53 tests passed; format, lint, TypeScript typechecks, `git diff --check`, and online `npm audit --include=dev` passed with `found 0 vulnerabilities`; attributable Win32 Node/Vite/Vitest/Playwright/Chromium process scan reported zero matches. This review relies on the already-recorded exact-head full check: 260 unit tests and 2 E2E tests passed.
Local tracker state decision: Complete
State decision reason: manager accepted the strict pass. Wave 5 integration remains a separate, not-yet-completed step.

## Codex Review Note

Round: 8 and 9
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Integration correction: canonical integration gate `776ccedf` exposed supervisor ancestry instability; subsequent Review 8 required local root attestation, and Review 9 required handle-bound Windows termination, canonical tokens, and wrapper/schema hardening.
Reviewer edits: none
Local tracker state decision: Rework
State decision reason: accepted P1 findings remain pending fresh review.

## Codex Worker Note

Round: 14 and 15
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Local tracker state transition: Rework -> Rework
Summary: local tool roots now attest identity over their owned stdout pipe before executing base64-decoded approved script text. Windows default terminators verify the expected composite identity against a held Process object and WMI before calling `Kill()`; recursive taskkill and Stop-Process paths remain absent. Canonical creation tokens are required by E2E ownership validation.
Acceptance criteria status: Round 15 validation pending current exact gate and fresh review.

## Codex Worker Note

Round: 15 correction
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Local tracker state transition: Rework -> Rework
Branch: `codex/long-term-optimization-007`
Prior validation correction: `a37a7043ef4ececd1bc89773cbeae1c03ad96c29` passed its recorded gate with 262 unit tests, 2 Playwright E2E tests, online development-dependency audit reporting `found 0 vulnerabilities`, and zero attributable process-scan matches. That revision did not yet contain the required real default-terminator coverage; this note preserves that pending record rather than rewriting it.
Integration/review history correction: canonical integration revision `776ccedf` failed on incoherent supervisor identity snapshots. Review Round 8 then required direct local-root stdout attestation to prevent initial PID reuse capture; Worker Round 14 delivered that protocol. Review Round 9 required handle-bound Windows termination, canonical token validation, attestation schema validation, and safe command wrapping; Worker Round 15 delivered those changes. The tracker remains Rework pending a fresh reviewer; this does not mark Wave 5 integrated.
Final implementation revision: `cf187fc90b566c3c6221f6d7d4d168e4ec2ad026` (`fix: normalize owned process creation tokens`). Windows process creation identity is now Unix epoch milliseconds as a decimal string at the PowerShell attestation, CIM process listing, and held `System.Diagnostics.Process` verification boundaries. E2E manifest schema is version 4. Exact identity comparison remains strict after normalization; executable comparison is case-insensitive on Windows, while parent PID, command line, and marker checks remain exact. Mismatch diagnostics name only failed identity fields and the held process object is disposed in `finally`.
Tests added/updated: two real Windows default-terminator tests each spawn and own one uniquely marked long-lived Node child. The local path refuses wrong creation token, command line, parent PID, and executable before the exact held-handle kill. The E2E path refuses wrong token, marker, and command line before its exact held-handle kill. Both use only the direct child handle as failure fallback. Supervisor token assertions now mutate `creationToken`, and synthetic ancestry fixtures use canonical tokens.
Commands run and results: focused local runtime, owned-process cleanup, and E2E supervisor suites passed 34 tests. The exact `npm run check` on `cf187fc90b566c3c6221f6d7d4d168e4ec2ad026` passed in 301.4 seconds: format, lint, both typechecks, builds, 34 test files/264 unit tests, kernel 89.45 statements/81.71 branches/93.75 functions/89.91 lines, product 91.23/80.74/97.14/91.30, presentation 92.18/80.31/94.11/93.01, and 2 Playwright E2E tests. Online `npm audit --include=dev --registry=https://registry.npmjs.org` reported `found 0 vulnerabilities`; `git diff --check` passed; an independent Win32 `zen-local`/`zen-e2e` marker/path scan reported zero matches and killed nothing.
Acceptance criteria status: complete for Worker Round 15, pending fresh review. No `taskkill /T`, `Stop-Process`, broad Node kill, threshold reduction, source exclusion, or coverage-ignore pragma was added.

## Codex Review Note

Round: 10
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Reviewed branch and revision: `codex/long-term-optimization-007 @ 9dd9202ed7440826f805375fecc34a645da38164`
Reviewer proposal: add a separate owner-marker field to generic local `OwnedProcessIdentity` values.
Manager decision: rejected as unreasonable. The directly spawned local root attests its unique marker inside the exact command line; descendants are generic exact operating-system identities owned through the recorded temporal ancestry chain. An ignored additional object property cannot represent a different live process and would not strengthen the process identity contract.
Reviewer edits: none.
Local tracker state decision: Rework pending the fresh Round 11 review.

## Codex Review Note

Round: 11
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Reviewed branch and revision: `codex/long-term-optimization-007 @ 9dd9202ed7440826f805375fecc34a645da38164`
Review result: STRICT PASS from a fresh clean-context review; no concrete reproducible findings.
Reviewer edits: none.
Validation reviewed: focused ownership tests, formatting, lint, TypeScript typechecks, and an attributable Win32 process scan with zero matches.
Local marker model confirmed: the attested local root marker is part of its exact command line, while generic descendants are owned only through exact composite identities and temporal ancestry, not through a redundant mutable marker property.
Local tracker state decision: Complete.
State decision reason: manager accepted the strict pass. Wave 5 remains not integrated until a separate canonical follow-up merge and gate.

## Codex Worker Note

Round: 15 terminal correction
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Branch: `codex/long-term-optimization-007`
Exact Round 15 code/test revision: `cf187fc90b566c3c6221f6d7d4d168e4ec2ad026`.
Exact reviewed documentation revision: `9dd9202ed7440826f805375fecc34a645da38164`.
Validation record: the exact full gate at `cf187fc90b566c3c6221f6d7d4d168e4ec2ad026` passed 264 unit tests and 2 Playwright E2E tests. Coverage was kernel 89.45 statements/81.71 branches/93.75 functions/89.91 lines, product 91.23/80.74/97.14/91.30, and presentation 92.18/80.31/94.11/93.01. Online development-dependency audit reported `found 0 vulnerabilities`; the final attributable `zen-local`/`zen-e2e` Win32 process scan reported zero matches.
Final scope status: Worker Round 15 is complete and issue 007 is Complete after Review Round 11. Wave 5 integration remains a separate pending canonical follow-up.

## Codex Review Note

Round: 11 integration correction
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Canonical integration revision: `c9ac99a`
Integration result: Rework. The canonical gate completed 263 of 264 tests and intermittently failed while concurrently registering the real launcher, child, and grandchild: Windows raised `EPERM` renaming the shared owned-process manifest. Five isolated reruns passed, confirming a real cross-process read-modify-write/rename race rather than a persistent process residue.
Reviewer edits: none.
Local tracker state decision: Complete -> Rework.
State decision reason: unique temporary names did not make concurrent replacement of one manifest target safe.

## Codex Worker Note

Round: 16
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Local tracker state transition: Complete -> Rework
Branch: `codex/long-term-optimization-007`
Implementation revisions: `da00e1cb87bd6b80700f9cfaeac038b8e3cd68d2` replaces mutable manifest upserts with schema-5 immutable ledger events; `4b32b7149653eabc8885bb2972cd21a3406fcff9` removes the pre-command CIM parent lookup from local-root attestation by injecting the known direct Node parent PID.
Summary of behavior delivered: run metadata is initialized once before spawn and each registration writes a unique temporary event then renames it to a unique final event file in the run ledger. Readers fold only complete events by composite identity key, ignore temporary files, and tolerate duplicate events. Terminal clear occurs only after the two-pass quiescence and independent marker scan, additionally verifying that no event arrived between scan and clear. Registration failure now stops only the original direct ChildProcess handle, performs retained-ledger safe cleanup/scanning, preserves unverified diagnostic evidence, and aggregates cleanup failures with the registration error.
Tests added/updated: 23 focused supervisor tests passed, including 16 concurrent cross-process writers with no lost identities, reader exclusion of an in-progress event, late completed event observation before clear, duplicate folding, retained unverified-registration evidence, direct-root no-orphan cleanup, and aggregate failure propagation. The real launcher/child/grandchild registration test passed 10 serial repetitions after the ledger change. Test teardown verifies its exact temp-directory parent and prefix before removing it.
Integration cleanup evidence: six pre-existing `zen-e2e-supervisor-*` temporary directories were individually verified to be direct children of the system temporary directory with no live Win32 command-line reference, then removed. No process was killed.
Validation correction: the first exact Round 16 gate on `da00e1c` passed format, lint, both typechecks, build, 268 unit tests, kernel coverage, and product coverage, then timed out only in the pre-existing local wrapper behavior test during presentation coverage. The failure was preserved; isolated diagnosis showed bootstrap startup near the fixed test budget. The direct-parent injection revision `4b32b71` removed the unnecessary WMI dependency and its exact gate passed in 315.4 seconds: 34 test files/268 unit tests; kernel 89.45 statements/81.71 branches/93.75 functions/89.91 lines, product 91.23/80.74/97.14/91.30, presentation 92.18/80.31/94.11/93.01, and 2 Playwright E2E tests. Online `npm audit --include=dev --registry=https://registry.npmjs.org` reported `found 0 vulnerabilities`; `git diff --check` passed; final attributable `zen-local`/`zen-e2e` process scan found zero matches and the owned supervisor temporary-residue scan found zero directories.
Acceptance criteria status: complete for Worker Round 16, pending fresh review. No rename retry, fragile lock, broad process kill, recursive taskkill, coverage threshold reduction, source exclusion, or coverage-ignore pragma was added.

## Codex Review Note

Round: 12
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Reviewed branch and revision: `codex/long-term-optimization-007 @ 26f7045b17ba70c56589cdcf5db21435e95a606c`
Review result: Rework.
Standards Review blocking: terminal ledger clear closed metadata then removed and recreated a shared ledger directory. A paused writer that had already read open metadata could append after recreation and contaminate the terminal or next run.
Spec Review blocking: test directory teardown checked only the path shape before recursive removal and did not independently refuse a live command line referencing the exact directory or run marker.
Reviewer edits: none.
Local tracker state decision: Rework.

## Codex Worker Note

Round: 17
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Local tracker state transition: Rework -> Rework
Branch: `codex/long-term-optimization-007`
Implementation revision: `45eeaca4daa8d34fd2d36849c7e1cadcff460f97` (`fix: isolate owned ledger generations`).
Summary of behavior delivered: every initialization now creates a fresh run ID and a dedicated `<manifest>.ledger/<runId>` directory. Metadata identifies that immutable generation. Appenders read the generation once and never create it; clear validates the expected revision, writes closed metadata, removes only that exact generation, and never recreates it. A paused writer therefore fails with the removed generation or has its event removed by clear, and a next initialization uses a distinct generation that old writers cannot contaminate. If Windows cannot remove an open generation, cleanup fails rather than claiming a false terminal clear.
Tests added/updated: focused supervisor tests now cover the paused writer after terminal clear, old-generation writer after next initialization, generation-specific temporary-event reads, and teardown refusal for both an exact directory and exact marker reference. Teardown validates the exact temporary root/prefix, independently lists Win32 processes immediately before deletion, refuses live references without killing them, and deletes only when the scan is empty. The focused suite passed 26 tests; the real launcher/child/grandchild test passed 10 serial repetitions.
Commands run and results: exact `npm run check` passed in 374.1 seconds: format, lint, both typechecks, builds, 34 test files/271 unit tests; kernel coverage 89.45 statements/81.71 branches/93.75 functions/89.91 lines, product 91.23/80.74/97.14/91.30, presentation 92.18/80.31/94.11/93.01, and 2 Playwright E2E tests. Online `npm audit --include=dev --registry=https://registry.npmjs.org` reported `found 0 vulnerabilities`; `git diff --check` passed; attributable `zen-local`/`zen-e2e` process scan found zero matches and the owned supervisor temporary-residue scan found zero directories.
Acceptance criteria status: complete for Worker Round 17, pending fresh review. No lock, rename retry, broad process kill, recursive taskkill, or coverage weakening was added.

## Codex Review Note

Round: 13
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Reviewed branch and revision: `codex/long-term-optimization-007 @ dddf4e6f54824ef2044c5d1b7bacc61a3e1e29dd`
Review result: Rework.
Standards Review blocking: initialization recursively removed the whole ledger root. A writer paused in an older generation could resume after a newer initialization removed its generation, producing `ENOENT` despite the immutable-generation ownership contract.
Reviewer edits: none.
Local tracker state decision: Rework.

## Codex Worker Note

Round: 18
Issue: long-term-optimization-007 Establish release-quality local gates and browser workflow
Local tracker state transition: Rework -> Rework
Branch: `codex/long-term-optimization-007`
Implementation revision: `16f9cfb250c715ff07d3e38dd6dee1e24ca8ab62` (`fix: retain active owned ledger generations`).
Summary of behavior delivered: initialization now creates a new immutable run-ID generation without deleting the ledger root or older generations. Each generation has validated `run.json` metadata. Stale reclamation is explicit and generation-scoped: it folds that generation's exact event identities, checks the marker and identities against a process snapshot, refuses active generations, removes only proven unowned generations, and leaves unrecognized paths untouched. The existing clear path retains its closed-metadata and exact-generation-only removal behavior, so a clear-vs-paused-writer still cannot produce a post-clear event.
Tests added/updated: focused supervisor coverage now includes the accepted interleaving where an old writer pauses after creating its temporary event, a new initialization creates another generation, and the old writer resumes successfully into its own generation without contaminating the new run. It also covers crash-leftover generation reclamation, active-generation refusal, and preservation of unrelated ledger-root paths. The focused suite passed 28 tests; the real launcher/child/grandchild path passed 10 serial repetitions.
Commands run and results: exact `npm run check` passed in 377.2 seconds: format, lint, both typechecks, builds, 34 test files/273 unit tests; kernel coverage 89.45 statements/81.71 branches/93.75 functions/89.91 lines, product 91.23/80.74/97.14/91.30, presentation 92.18/80.31/94.11/93.01, and 2 Playwright E2E tests. Online `npm audit --include=dev --registry=https://registry.npmjs.org` reported `found 0 vulnerabilities`; `git diff --check` passed; final attributable `zen-local`/`zen-e2e` process scan found zero matches and the supervisor temporary-residue scan found zero directories.
Acceptance criteria status: complete for Worker Round 18, pending fresh review. Issue 007 remains Rework; no retry, lock, broad deletion, broad process kill, recursive taskkill, or coverage weakening was added.
