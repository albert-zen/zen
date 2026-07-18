# Agent App Evidence

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

- `AgentScheduler` applies per-project FIFO concurrency, releases leases during
  waits, and reacquires only after event-driven wait settlement.
- `WaitGraph` supports `any` and `all`, rejects cycle paths before adding an
  edge, and cleans waiting state on cancellation/disposal.
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
