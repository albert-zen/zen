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
