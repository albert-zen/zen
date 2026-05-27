# Worker Model

Use a single local branch/workspace until the repo has implementation scale that justifies multiple worktrees.

## Roles

- **Manager**: owns the issue DAG, wave planning, worker assignment, integration, quality gates, review loop, and human escalation.
- **Worker**: owns one assigned issue slice and its evidence. It does not expand scope.
- **Reviewer**: reads a frozen review packet and reports findings. It does not modify files or own the loop.

## Worker Assignment Packet

Managers should give workers:

| Field | Required |
| --- | --- |
| Issue id/title | yes |
| Objective | yes |
| Acceptance criteria | yes |
| Dependencies satisfied | yes |
| Allowed files/modules | yes |
| Do-not-touch scope | yes |
| Required tests | yes |
| Required evidence | yes |
| Engineering standards | yes |
| Review intensity | yes |
| Base revision/diff scope | yes |

## Worker Return Packet

Workers must return:

| Field | Required |
| --- | --- |
| Summary of behavior delivered | yes |
| Changed files/modules | yes |
| Tests added/updated | yes |
| Commands run and results | yes |
| Evidence links/paths | yes |
| Decisions made | yes |
| Standards notes | yes |
| Open questions | yes |
| Residual risks | yes |

## Conflict Policy

- Workers must not revert user or other worker changes.
- If two workers need the same file or behavior boundary, manager serializes the work or narrows scopes.
- If a worker discovers scope expansion is required, it stops and reports the issue instead of proceeding.
