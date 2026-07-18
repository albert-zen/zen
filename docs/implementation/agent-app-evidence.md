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

Pending implementation and targeted verification.
