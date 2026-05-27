# Review Policy

## Modes

| Mode | Owner | When |
| --- | --- | --- |
| `worker-single-pass` | Worker | Non-trivial assigned issue before handoff |
| `manager-single-pass` | Manager | Normal wave or low-risk branch |
| `manager-strict-loop` | Manager | High-risk, release-blocking, or architecture-sensitive work |

## Review Axes

- **Standards Review**: architecture, TDD, Canvas, repo conventions, quality gates.
- **Spec Review**: PRD, issue brief, acceptance criteria, DAG constraints.

## Approval Rule

Approve only when:

- No blocking Standards findings remain.
- No blocking Spec findings remain.
- Required evidence from `docs/agents/quality-gates.md` is present or explicitly skipped.
- Any remaining non-blocking findings are accepted or deferred.

## Escalation

Run `align-with-canvas` when review finds:

- Spec ambiguity.
- Canvas/spec mismatch.
- Hard-to-reverse decision.
- Architecture direction change.
