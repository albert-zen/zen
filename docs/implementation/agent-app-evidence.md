# Agent App Evidence

## Packaged Render Hotfix (2026-07-19)

- The prior packaged smoke was insufficient: it proved only that the Electron
  process started and exited. It did not inspect the rendered document. The
  shipped static host therefore returned `Not found` without failing the gate.
- Root cause: Vite used the repository root with `web/index.html` as its input,
  producing `web-dist/web/index.html`, while the Electron static host correctly
  required `web-dist/index.html` as the SPA entry document.
- Fix: the Vite application root is now `web/`, and the generated production
  entry is `web-dist/index.html`. Package inspection fails unless the root Web
  document and both Electron entrypoints exist in ASAR.
- Regression gates: static-host/package tests passed `2` files / `7` tests;
  Web TypeScript and ESLint passed; a clean unsigned NSIS build completed; and
  the final ASAR passed all hygiene and required-entry checks with `127`
  entries.
- Real packaged UI verification now launches the exact built executable through
  Playwright, waits for `Zen control plane`, requires Project/Thread/Create
  Project content, rejects a `Not found` body, checks horizontal overflow, and
  captures
  `docs/implementation/artifacts/agent-app/agent-app-packaged-fixed.png`.
  Final verification loaded `http://127.0.0.1:<ephemeral>/` with title
  `Zen Agent` and viewport/scroll width `1267/1267`.

## APP-010 Final Blocker Close (2026-07-19)

- Restart recovery: file-backed close/reopen tests prove one durably activated
  message Turn and one resolved-wait continuation are each re-enqueued exactly
  once by a fresh Coordinator/ThreadManager. Durable queued Turns survive;
  only stale `inProgress` Turns receive interruption repair.
- Cancellation and handoff: cancellation runs no Executor while the projection
  remains canceled. A later authorized UI Turn or Agent handoff persists normal
  command/Turn facts, projects queued before execution, and resumes the same
  durable conversation. Canceled Agent sources are denied. A crash between the
  outer handoff command and nested message is reconciled by fresh journals,
  command store, Coordinator, and Server with one nested message, one Executor,
  and one outer result.
- Idempotency: identical concurrent request payloads coalesce; a different
  payload using the same project/method/key conflicts before sharing the
  in-flight Promise.
- Product cleanup: obsolete TUI/demo README commands and the unreachable demo
  runtime/test were removed. Production builds first clean only fixed generated
  directories, preserving runtime data; the clean desktop ASAR has `128`
  entries and no denied TUI/session/demo/test/journal/secret output. Executor
  dependencies (`provider-runtime`, local tools, production composition, and
  internal App Server protocol modules) remain packaged as required.
- Functional gates: blocker/build hygiene/module-boundary tests passed `3`
  files / `13` tests; the focused durability/scheduler/ledger/coordinator suite
  passed `8` / `57` after replacing one obsolete queued-Turn repair assertion;
  real HTTP/SSE/reconnect/backpressure passed `4` / `28`; desktop
  origin/lifecycle tests passed `5` / `13`; and the three real Playwright
  Project/Thread workflows passed. TypeScript passed and the clean desktop pack
  rebuilt successfully.
- Packaged usability: one hidden isolated-data auto-quit launch of
  `release/win-unpacked/Zen Agent.exe` exited `0` as owned PID `36344`; the
  exact packaged executable and worker-attributable Node/Electron/Zen Agent
  censuses are zero afterward. No NSIS rebuild was needed.
- Per the final usability-first direction, coverage thresholds, full
  `npm run check`, and audit were not rerun. An already-running product coverage
  attempt had `377/378` tests pass and stopped on the pre-existing
  `LocalToolRuntime` five-second shell timeout; no timeout, threshold, skip, or
  retry was added.

## APP-010 Consolidated Remediation

- Current state: **Complete**. The authoritative model is App Server-first:
  both humans and Agents persist Project/Thread commands through the same
  authorization, idempotency, durability, and scheduling pipeline. A Thread is
  durable conversation history, never a resident Agent or process. Only a
  short-lived Turn Executor holds one `maxActiveExecutions` scheduler slot.
- Execution semantics: a Turn/Command is durable before scheduler admission;
  queued Turns remain durable; wait persists its dependency and yields the
  current slot; wake creates a separately scheduled continuation Turn.
  Cancellation fences queued/running Turn work without deleting Thread
  history. Project root is immutable, while model, permissions, and concurrency
  updates are captured atomically by the next granted Turn and do not alter an
  active Turn's captured policy.

| #   | Decision           | Validated remediation                                                                                     |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| 1   | Accepted, narrowed | Scheduler now governs short-lived Turn Executors; idle Threads and durable waits hold zero slots.         |
| 2   | Accepted           | Transitive ancestor control is denied across send, interrupt, cancel, archive, and handoff.               |
| 3   | Accepted           | Archive durably fences queued/running execution, preserves readable history, and disables UI writes.      |
| 4   | Accepted           | Thread/Turn journal barriers precede coordination references, with injected failure/restart coverage.     |
| 5   | Accepted           | A durable project-scoped command/result ledger replays completion and reports pending recovery safely.    |
| 6   | Accepted           | Desktop bearer injection requires exact Host/Origin/fetch metadata, method, and content type.             |
| 7   | Accepted, narrowed | Immutable root plus next-Turn runtime snapshots replace runtime/UI divergence without resident Agents.    |
| 8   | Accepted           | Project identity stores absolute host-real paths with Windows case normalization before collision checks. |
| 9   | Accepted           | Retired TUI/bin/session/projectless Node client and obsolete in-memory WaitGraph surfaces were removed.   |
| 10  | Accepted           | SSE subscribers use bounded buffering and isolate/disconnect slow consumers.                              |
| 11  | Accepted           | Server close attempts every runtime open/close and reports one aggregate failure.                         |
| 12  | Accepted           | Production defaults use OS app-data/state; repository `.zen/` is ignored.                                 |

- Targeted verification: APP-010 command/execution/HTTP-SSE/backpressure tests
  passed `4` files / `13` tests; durability and recovery passed `3` / `33`;
  presentation project/reset/error/archive tests passed `3` / `44`; the true
  loopback multi-project/multi-thread HTTP/SSE execution test passed `1` / `1`;
  and hostile desktop origin tests passed `1` / `3`.
- Coverage passed without threshold, exclusion, skip, retry, or timeout changes:
  kernel `89.52/82.98/94.05/90.10`, product
  `88.53/80.05/93.83/91.19`, and presentation
  `92.10/80.38/96.03/93.73` (statements/branches/functions/lines).
- Final serialized gate: the single final `npm run check` exited `0` after
  formatting, lint, main/Web/desktop typechecks, `51` Vitest files / `372`
  tests, core/acceptance/Web/desktop builds, all three coverage groups, and
  `3` real Playwright HTTP/SSE workflows. `npm audit --audit-level=low`
  reported zero vulnerabilities.
- Desktop release evidence: hostile-origin tests passed; `desktop:pack` and
  unpublished unsigned NSIS `desktop:dist` passed. The installer is
  Authenticode `NotSigned`. ASAR contains `4,235` entries with required
  `dist`, `web-dist`, `desktop-dist`, and `package.json`; prohibited tests,
  `.git`, coverage, `.zen`, journals, secrets, TUI, retired session, and
  WaitGraph paths matched zero. Packaged bins are only `zen-app-server` and
  `zen-web`.
- Packaged smoke: two serial hidden auto-quit launches exited `0` (PIDs `23572`
  and `28340`), each used and removed one exact isolated app-data root, and
  each left zero exact packaged-executable processes.
- One gate exposed a concrete Windows hygiene defect outside product behavior:
  strict string-case comparison could reject a realpath-equivalent ownership
  terminal after rename. The supervisor now preserves realpath/symlink
  confinement while comparing Windows path identity case-insensitively; its
  `42`-test regression suite passed.
- Final hygiene: exact `zen-agent-app-*`, `zen-agent-app-e2e-*`, `zen-e2e-*`,
  `zen-desktop-*`, and `zen-agent-smoke-*` temporary-root counts are zero;
  worktree `.zen`, coverage, and Playwright test-results are absent; the exact
  attributable Node/Electron/Zen Agent process census is zero. No broad process
  kill or unverified temporary-directory deletion was used.
- Release blockers: none.

## APP-009 Final Integration Gate

- Historical APP-009 state: **Complete**. APP-010 was Pending at that gate. The
  final serialized `npm run check` exited `0`, followed by `npm audit` with zero
  vulnerabilities.
- Test migration: serial `npm test` passed with `49` files and `401` tests
  after replacing retired single-thread dogfood and CLI contract assertions with
  the Project-first protocol. Vitest is explicitly constrained to one fork
  worker (`--maxWorkers=1`) after investigating an earlier worker-exit report.
- Browser E2E: `npm run e2e` passed with real production composition,
  authenticated HTTP/SSE transport, and same-origin Vite proxy. It covers
  first-project creation, parent thread/human turn, deep link/refresh/back,
  and typed invalid-request no-side-effect behavior. Representative real
  screenshots are written by the workflow to
  `docs/implementation/artifacts/agent-app/` at 1440x900, 1728x1000, and
  390x844. A subsequent complete gate exposed an invalid Playwright locator
  assertion (`expect(locator).evaluate`); the assertion was corrected to
  evaluate first and assert the boolean. The final full gate ran all three
  real HTTP/SSE workflows successfully.
- Product repair: `ProjectThreadSummary` now projects the durable thread
  objective, so the Project/Threads/Thread UI shows operator-supplied work
  intent rather than only opaque thread IDs.
- Coverage: standalone serial gates pass without threshold changes or source
  exclusions: kernel `88.07/82.01/92.07/88.92`, product
  `87.23/80.61/90.37/90.17`, and presentation
  `91.00/80.11/94.13/92.75` (statements/branches/functions/lines). The product
  and presentation branch thresholds are now both at least `80%`.
- Packaging: `npm run desktop:pack` passed. `npm run desktop:dist` now uses
  `electron-builder --publish never` plus explicit `build.publish: null`, and
  completed with exit `0`, producing
  `release/Zen Agent-0.0.0-x64.exe`, its `.blockmap`, and
  `release/win-unpacked/Zen Agent.exe`. ASAR inspection found `dist`,
  `web-dist`, `desktop-dist`, and dependency licenses; prohibited tests,
  `.git`, coverage, journals, and secrets matched zero paths.
- Packaged smoke: two serial hidden auto-quit launches of the unpacked exe
  exited `0` (PIDs `1332` and `15136`), each used an isolated temporary app-data
  root that was removed, and both observed `Zen Agent.exe` census `0` before
  and after.
- Full-gate history: the first final `npm run check` passed formatting, lint,
  core/Web/desktop typechecks, `49` Vitest files / `401` tests, all builds, and
  all three coverage gates, then failed its first E2E test only because of the
  locator assertion API described above. After correcting that test, the next
  full check again passed formatting, lint, types, `49`/`401`, and all builds,
  then failed kernel coverage when
  `test/local-tool-runtime.test.ts > runs shell commands in the workspace and
  returns command output` exceeded Vitest's existing `5000ms` timeout. The
  timeout was not changed, skipped, or retried inside Vitest. An immediately
  following standalone serial kernel coverage run passed `49`/`401`; this
  indicated resource-sensitive cleanup work rather than a confirmed leak. The
  normal-exit owned-process path was then narrowed from global Windows process
  enumeration to the captured ownership tree and its direct children, while
  retaining two independent snapshots and identity/parent-chain verification.
  Kernel coverage passed three serial repetitions (`49` files / `401` tests),
  each with zero test-owned process and `zen-agent-app-*` residue. The single
  subsequent full gate exited `0`: format, lint, main/Web/desktop typechecks,
  `49` files / `401` tests, core/acceptance/Web/desktop builds, all three
  coverage groups, and the three real E2E workflows passed.
- Hygiene: `.zen` resolved exactly to
  `D:\desktop\zen-agent-app-worker\.zen`, contained only test/CLI-created
  project journals, and was removed after verification. No broad process kill
  or temporary-directory delete occurred. The externally reported attributable
  Node/Electron/Zen Agent census is `0`. The final gate's worktree `.zen` was
  re-verified and removed; known `zen-agent-app-*`, `zen-desktop-*`, and
  `zen-agent-smoke-*` temporary-root counts are zero. The existing
  `zen-tools-*` baseline remained `1657` and was not broadly deleted.

## APP-001

- Base: `446ed0f4b750f049ab8f0179d7308cce7e1050eb`.
- Branch: `codex/agent-app`.
- Artifacts: PRD, architecture decision record, DAG, and local tracker.
- Linear: intentionally not contacted.

## Resource Hygiene

- Targeted Node tests run serially.
- Tests create only prefix-validated `mkdtemp` roots and tear down exactly
  those roots in `afterEach`.
- No broad process termination, directory scans, or arbitrary deletion is
  permitted. Final evidence records process and temporary-root delta.

## APP-002

- Product: `ProjectManager` with injected clock, ID generator, and root
  canonicalizer; immutable snapshots; create/list/read/update/archive; policy
  validation; and serialize-before-publish persistence behavior.
- Registries: product `InMemoryProjectRegistry`; Node `FileProjectRegistry`
  with one explicit app-data JSON path, versioned schema validation, fail-closed
  corruption handling, serialized writes, and temp-write plus rename.
- Tests: `test/project-manager.test.ts` covers CRUD/archive, validation,
  canonical collision, immutability, persistence failure, restart, corruption,
  file-write ordering, and the Windows canonicalizer.
- Validation: `npx prettier --write` for changed files; targeted `npx eslint`;
  `npm run typecheck`; `npm run build`; and serial targeted Vitest for project
  and module boundaries all passed. No full `npm run check`, coverage, or E2E
  command was run.
- Final test count: 2 files and 13 tests passed.
- Hygiene census: pre/post Node PID set unchanged; exact
  `zen-agent-app-project-*` temporary-root delta is zero.

## APP-003

- Product coordination uses an explicit project-scoped envelope rather than
  overloading kernel Items whose `runId` and `turnId` are execution scoped.
- `ProjectCoordinator` owns one ThreadManager runtime per Project, rebuilds
  mailbox and idempotency projections from coordination Items, and activates a
  target turn only after durable `thread.message.sent` then delivery facts.
- `FileProjectCoordinationJournal` is a single explicit append-only JSONL file
  with tail serialization, sync-before-return, schema/version validation, and
  fail-closed replay.

## APP-004

- Historical APP-004 used per-project FIFO leases and an in-memory `WaitGraph`.
  APP-010 supersedes and removes that model: durable wait ends its Turn and a
  durable wake creates a distinct continuation Turn that re-enters scheduling.
- `ThreadToolRuntime` exposes the eight provider-neutral thread tools with
  strict schemas, typed errors, execution-context authority, and an optional
  fallback runtime for existing local tools.
- Final validation: Prettier, targeted ESLint, `npm run typecheck`, and
  `npm run build` passed. Serial targeted product/node/module verification
  passed 5 files and 24 tests. Full check, coverage, and E2E were not run.
- Hygiene census: the Node PID set was unchanged; exact
  `zen-agent-app-project-*` and `zen-agent-app-coordination-*` temporary-root
  deltas were both zero.

## APP-005A

- Added independent `AgentApp*` project-scoped protocol validation and a lazy,
  injectable `AgentAppServer`/`ProjectRuntime` product composition.
- This transition commit deliberately leaves the legacy single-project protocol
  and its consumers untouched. APP-005B performs their removal and migration.
- Targeted protocol/server tests and main typecheck passed.

## APP-005B

- Agent App HTTP/SSE is a thin adapter over the existing capability-authenticated,
  quiesce-aware transport. It uses 005A's parser before dispatch, preserves the
  project notification envelope, and shares one application cursor/replay stream.
- Node composition accepts an explicit app-data root and registry path. Each
  registry-known project gets a base64url-encoded fixed subdirectory containing
  separate thread and coordination journals; no project data directories are scanned.
- The project runtime shares a ThreadManager between AppServer and coordinator,
  recovers both journals at startup, injects trusted project/thread authority into
  the eight thread tools, and combines them with local tools in a CompositeToolRuntime.
- Validation: Prettier check, targeted ESLint, main and web TypeScript checks,
  production build, and serial targeted Vitest passed: 4 files, 32 tests. Full
  check, coverage, and E2E were intentionally not run.
- Hygiene census: the integration tests remove only their exact mkdtemp roots;
  no processes were terminated and no broad temporary-directory cleanup was run.

## APP-005C

- Public product, Node, and presentation entrypoints no longer export
  `AppServerRequest`, `AppServerResponse`, `AppServerNotification`,
  `AppServerClient`, `HttpAppServerClient`, or `serveAppServerHttpTransport`.
  The legacy single-project runtime remains an unexported Node implementation.
- Added `AgentAppTransportClient` for Node and
  `BrowserAgentAppTransportClient` for browser HTTP/SSE, retaining the
  existing request gate, replay, reconnect, and reset behavior behind the
  project notification envelope.
- Web bootstrap now lists projects through Agent App, selects an explicit
  requested project when available, otherwise the first active project, and
  creates a default project through `project/create` when none exists. Thread,
  turn, and approval requests all carry `projectId`; subscriptions filter the
  selected project before projection installation.
- `zen-app-server` and `zen-web` now start the Agent App production
  composition and Agent App HTTP transport. The legacy TUI build is isolated
  behind a Node entrypoint and is not a network route.
- Validation passed: main and Web TypeScript checks, ESLint, Prettier check,
  serial Agent App server/node integration/module-boundary tests (3 files,
  10 tests), core build, Web build, and `git diff --check`. Full check,
  coverage, and E2E were not run.
- Hygiene census: no process was terminated; the exact
  `zen-agent-app-*` temporary-root census was empty after validation. No broad
  temporary-directory cleanup was performed.

## APP-006

- Branch: `codex/agent-app`; base: `57e862c540b6b60bb891397fa050fd0d4e7ef463`.
- Presentation: added `AgentWorkspaceClient`, a generation-guarded,
  `useSyncExternalStore`-ready Project/Thread snapshot projection. Project
  switches clear the selected Thread projection before loading the new Project;
  stale loads raise `WebUiLifecycleCanceledError`; subscriptions add agent-created
  Threads immediately.
- Web: replaced the single-thread shell-oriented workspace with split Project
  navigator, Thread navigator, timeline/composer, and accessible modal modules.
  The interface has no terminal, editor, file tree, manual diff, or source-control
  workbench. It supports deep links and browser navigation, project/thread create,
  archive/cancel/handoff, responsive mobile views, and no-project creation.
- Demo: two projects, a parent with two children, wait and handoff coordination
  facts, and model-profile summaries are available through the Agent App fixture.
- Tests added: `test/agent-workspace-client.test.ts` and updated
  `test/workspace-lifecycle.test.tsx`; serial targeted run passed 2 files and 6
  tests. It covers no-project bootstrap/create, project isolation, child-thread
  notification, idempotent command shape, stale selection, dialog Escape, and
  mobile view smoke coverage.
- Validation passed: Prettier check, ESLint, core/Web TypeScript checks, core
  build, Web build, and `git diff --check`. Full check, coverage, and E2E were
  intentionally not run.
- Known test-contract gap: the pre-existing `test/web-ui-client.test.ts` retains
  the removed single-project AppServer request shape (no `projectId` and no
  `project/list` fixture). Its 32 legacy expectations fail against the APP-005C
  Agent App protocol before APP-006 UI behavior is reached; it was not changed
  because APP-006 must not restore the deprecated protocol surface.

## Codex Worker Note

Round: 1

- APP-006 complete on `codex/agent-app`; local-only workflow, no GitHub push.
- APP-007 remains Pending. No intermediate review is required by this wave.
- Residual risk: APP-009 should replace or retire the legacy single-project WebUi
  client characterization fixture as part of the protocol/E2E fixture refresh.

## APP-005C Migration Repair

- The APP-006 known test-contract gap above is resolved and its residual-risk
  statement is superseded. `test/web-ui-client.test.ts` retains 32 tests, now
  covering the project-scoped Agent App browser request gate, SSE replay/reset
  generations, Web UI lifecycle cancellation, authoritative snapshot handoff,
  projection idempotency, project-scoped thread/turn/approval operations, and
  two-project notification isolation.
- Removed the test-only `BrowserAppServerTransportClient` compatibility alias.
  `WebUiClientOptions.client` now exposes `AgentAppClient` directly, and the
  presentation notification helper is `applyAgentAppNotification` with no old
  public alias.
- Fixed a project-switch exposure found by the migrated tests: an explicit
  switch now cancels the old handoff/subscription and clears the old projection
  before the new authoritative snapshot is installed. Stale callbacks and
  foreign-project envelopes cannot repopulate it.
- Serial related validation passed 8 files and 87 tests, including 32/32 in
  `test/web-ui-client.test.ts` and the Agent App server/Node transport,
  workspace client, interaction session waiter/early-terminal, presentation
  projection, UI lifecycle, and module-boundary suites.
- APP-005, APP-005C, and APP-006 remain Complete. No APP-006 visual changes were
  made. Full check, coverage, and E2E were not run.
- Hygiene census: the pre/post Node PID set was identical and the exact
  `zen-agent-app-*` temporary-root census was empty before and after the serial
  run. Every integration-test `mkdtemp` root was removed by its owning test; no
  process was terminated and no broad deletion was performed.

## APP-007

- Branch: `codex/agent-app`; base: `732246a7423896fcf540ef6cc1147152c667e982`.
- Desktop: Electron starts the Agent App production composition under
  `app.getPath('userData')`, binds its capability-authenticated HTTP/SSE
  transport to loopback on an ephemeral port, and serves `web-dist` through a
  same-origin static host. The host safely normalizes paths, rejects traversal,
  keeps `/request` and `/events` out of SPA fallback, injects the capability
  only into its proxy, and supplies MIME, cache, and CSP headers.
- Security: BrowserWindow uses `contextIsolation`, sandbox, disabled Node
  integration, enabled web security, denied navigation, and denied window
  creation. Only external `http(s)` popups are delegated to Electron shell.
  The preload bridge exposes only a validated directory picker, bounded native
  notification, platform, and Electron version; it exposes no shell, git, or
  filesystem IPC.
- Lifecycle: the testable desktop lifecycle quiesces transport and static-host
  ingress, drains Agent App composition, then closes transport, host, and
  window with idempotent aggregate semantics. Single-instance focus, repeated
  signal shutdown, partial startup, and sibling-close failure behavior are
  covered without starting Electron GUI.
- Web: the project dialog retains manual root-path entry and conditionally adds
  a folder-icon picker in desktop mode. Project creation still goes through the
  Agent App `project/create` protocol.
- Build: added `tsconfig.desktop.json`, Electron main/preload compilation to
  `desktop-dist`, desktop build/dev/pack/dist scripts, and explicit asar/NSIS
  x64 electron-builder configuration. `package.json` and `package-lock.json`
  include the expected Electron `43.1.1` and electron-builder `26.15.3`
  dependencies.
- Validation passed: serial focused Vitest (`6` files, `14` tests), Prettier
  check, ESLint, core/Web/desktop TypeScript checks, core/Web/desktop build,
  `git diff --check`, and `npm audit --audit-level=low` (`0` vulnerabilities).
  Full check, coverage, and E2E were intentionally not run for this scoped
  issue.
- Packaging attempt: `npm run desktop:pack` completed the configured desktop
  build and electron-builder setup but failed while downloading an Electron
  packaging dependency because the client TLS connection disconnected before
  establishment. No `release` artifact remained; the unsigned package
  configuration is retained for APP-009/package-environment retry.
- Hygiene census: final process list contained no Electron process. Existing
  Node PIDs were `472, 5264, 19176, 19252, 21148, 21468, 23320, 25040, 25232,
30164`; no process was terminated. Exact `zen-desktop-*` and
  `zen-agent-app-*` temporary-root counts were both zero. No broad delete or
  workspace scan was used.

## Codex Worker Note

Round: 1

- APP-007 complete on `codex/agent-app`; APP-008 remains Pending.
- Local-only workflow: no Linear mutation, no intermediate review, and no
  GitHub push. Electron packaging is blocked only by the recorded transient
  TLS download failure; APP-009 owns package smoke/retry work.

## APP-008

- Capability boundary: `ThreadToolRuntime` accepts only runtime-injected actor
  context. Tool payload cannot select project, source thread, or capabilities.
  Capability checks distinguish child/peer messaging and reject agent self or
  ancestor control paths before coordinator mutation.
- Resource boundary: Project policy now normalizes bounded total threads,
  queued messages, wait targets, message bytes, and idempotency retention.
  Coordinator mutations serialize limit checks before coordination journal
  appends and return typed `RESOURCE_EXHAUSTED` failures. The UI compactly
  exposes the thread/depth/concurrency policy summary.
- Recovery: coordination replay records stale granted leases as recovered,
  continues sent-but-not-activated delivery, and preserves a durable delivery
  then activation fence. Idempotency retention is represented by deterministic
  compaction Items; pending delivery facts are excluded from compaction.
- Input/security: Agent App JSON input has bounded recursive validation and
  rejects non-finite values, unsafe prototype keys, excess depth, and excess
  byte size. Existing desktop/static-host and lifecycle regressions remain in
  the focused suite.
- Tests: `test/app-008-policy.test.ts` adds injected-context forgery,
  thread/message resource exhaustion, and malformed JSON assertions. Serial
  targeted validation passed nine test files / 35 tests, including coordinator,
  scheduler, server/runtime, journal, desktop lifecycle, and static host.

## Codex Worker Note

Round: 1

- APP-008 complete on `codex/agent-app`; APP-009 remains Pending.
- Local-only workflow: no Linear mutation, no intermediate review, and no
  GitHub push. Full check, coverage, E2E, and package operations were not run;
  APP-009 owns those broader gates.

## Codex Worker Note

Round: 2

- Completion validation passed: serial focused Vitest, Prettier check, ESLint,
  core/Web TypeScript checks, core/Web/desktop builds, `npm audit
  --audit-level=low`, and `git diff --check`.
- No Linear mutation, external push, full check, coverage, E2E, or package
  command was run. This remains a local `codex/agent-app` implementation.
