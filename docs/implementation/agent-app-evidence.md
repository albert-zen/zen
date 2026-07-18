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
