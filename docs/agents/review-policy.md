# Review Policy

## Modes

| Mode | Owner | When |
| --- | --- | --- |
| `worker-single-pass` | Worker | Non-trivial assigned issue before handoff |
| `manager-single-pass` | Manager | Normal wave or low-risk branch |
| `manager-strict-loop` | Manager | High-risk, release-blocking, or architecture-sensitive work |

## Review Axes

- **Standards Review**: architecture, TDD, Canvas, repo conventions, quality gates, and `docs/agents/engineering-standards.md`.
- **Spec Review**: PRD, issue brief, acceptance criteria, DAG constraints.

Reviewer agents must not implement fixes. They may run commands and make temporary verification edits inside the reviewer workspace when that helps inspect behavior, but they must not push reviewer edits or turn exploratory changes into implementation work.

## Approval Rule

Approve only when:

- No blocking Standards findings remain.
- No blocking Spec findings remain.
- Required evidence from `docs/agents/quality-gates.md` is present or explicitly skipped.
- Commit messages follow `docs/agents/engineering-standards.md` when commits are in scope.
- Any remaining non-blocking findings are accepted or deferred.

## Linear State Decisions

- Move to `Human Review` when both axes have no blocking findings and required evidence is present.
- Move to `Rework` when the spec is clear and bounded worker fixes are needed.
- Move to `Needs Human Context` when the spec, acceptance criteria, dependency state, or decision authority is insufficient.
- Move to `Blocked` when GitHub, Linear, Codex, CI, environment, dependency, or deployment failure prevents review.

Each review round must create a new append-only `## Codex Review Note` with:

- `Round: <n>`,
- Standards Review blocking/non-blocking/missing evidence,
- Spec Review blocking/non-blocking/missing evidence,
- state decision and reason.

## Escalation

Run `align-with-canvas` when review finds:

- Spec ambiguity.
- Canvas/spec mismatch.
- Hard-to-reverse decision.
- Architecture direction change.
