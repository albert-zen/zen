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
