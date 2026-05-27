# Worker Model

This workflow separates shaping, implementation, review, and final acceptance. Each role owns a different decision surface.

Use Symphony with separate worker and reviewer instances when running unattended automation. Use direct Codex manager execution only for shaping, release decisions, integration, emergency repair, or when Symphony is not running.

## Roles

- **Human/Codex manager**: aligns on product and architecture intent, shapes specs, releases ready DAG nodes, resolves hard decisions, owns final acceptance, and handles system-level blockers.
- **Worker Symphony instance**: polls `Ready for Agent` and `Rework`, starts implementer Codex sessions, and enforces implementation handoff discipline.
- **Worker Codex agent**: implements one scoped issue, validates it, records evidence, and moves only to `Agent Review` after readiness passes.
- **Reviewer Symphony instance**: polls `Agent Review` and starts reviewer Codex sessions.
- **Reviewer Codex agent**: performs review only. It reports findings and moves the Linear issue to `Human Review`, `Rework`, `Needs Human Context`, or `Blocked`.
- **Codex Worker Note**: one append-only human-facing Linear comment per worker round whose first line is `## Codex Worker Note`.
- **Codex Review Note**: one append-only human-facing Linear comment per reviewer round whose first line is `## Codex Review Note`.
- **Symphony Control**: transient runtime-owned system comments for durable claim coordination. Control comments are not human progress notes.

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
| Decision policy | yes |

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
| Branch or PR reference | yes |
| Linear state transition made | yes |

Before moving to `Agent Review`, the worker must leave:

- a new `## Codex Worker Note` with `Round: <n>`,
- branch name and PR URL when GitHub is configured,
- final scope summary,
- acceptance criteria status,
- validation commands and outcomes, with log paths when relevant,
- required check status or local-check handoff reason,
- reviewer notes and known residual risks,
- blocker or context escalation details when not complete.

## Reviewer Assignment Packet

The reviewer prompt must include:

- Linear issue, prior worker/review notes, branch or PR URL, and diff scope,
- Agent Brief, PRD, DAG node, and acceptance criteria,
- architecture/quality standards and relevant ADRs,
- required validation evidence,
- explicit instruction that reviewer workspace edits are only for local verification; reviewers must not push those edits, open implementation PRs, or turn exploratory changes into implementation work.

## Decision Policy

Agents may make conservative decisions when the choice is safe, local, reversible, and does not change product meaning or architecture direction. Record the decision in the worker or review note for that round.

Agents must move the issue to `Needs Human Context` when a decision affects:

- product behavior or acceptance criteria,
- architecture direction or public interfaces,
- data shape, migration, or irreversible state,
- security, privacy, credentials, or deployment policy,
- quality gate, coverage, review, or merge policy,
- ambiguous scope where multiple reasonable implementations would satisfy different intents.

Use `Blocked` only when the work is clear but cannot proceed because of an external or system condition.

## Conflict Policy

- Keep one Linear issue, one branch, and one review packet. Do not broaden an active worker issue to absorb adjacent work.
- Workers must not revert user or other worker changes.
- If two workers need the same file or behavior boundary, manager serializes the work or narrows scopes.
- If a worker discovers scope expansion is required, it stops and reports the issue instead of proceeding.
- Do not change another worker's branch or workspace unless a manager explicitly assigns integration or recovery work.
