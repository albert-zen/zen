# Agentic Flywheel Quality Discipline

This policy defines minimum validation, note, blocker, review, and state discipline for Symphony-managed Zen agent work.

## Required Evidence

Every worker handoff must record these checks in the latest `## Codex Worker Note`:

- Linear issue identifier and scope.
- Branch name and commit hash.
- Acceptance criteria status.
- Focused validation commands and outcomes.
- Broad gate status when available.
- Explanation for skipped gates.
- Known residual risks.
- Whether this is local-branch mode or GitHub PR mode.

Current local-branch mode does not require GitHub PR checks because this repo has no remote. After GitHub is configured, workers must not move an issue to `Agent Review` until the PR exists and required checks pass.

## Local Validation Fallback

Focused local checks are preferred while iterating. Broad gates should run locally when the environment supports them, but workers should not burn repeated turns on ambiguous local tooling failures.

If a broad gate times out or is interrupted:

1. Inspect the log tail and search for final result markers.
2. Check for residual processes.
3. If the log contains a final result, use that result.
4. If incomplete and no process remains, rerun at most once when local result is required.
5. Otherwise record the local limitation and keep the issue out of `Agent Review` unless a manager explicitly accepts the risk.

## Agent Notes

Use append-only Linear comments as the human audit trail:

```md
## Codex Worker Note
```

for each worker round, and:

```md
## Codex Review Note
```

for each review round.

Prior worker/review notes must not be edited or overwritten.

## Blocker Discipline

Use `Needs Human Context` when the issue lacks product, architecture, acceptance, dependency, or decision context.

Use `Blocked` only when the work is clear but cannot proceed because of an external or system condition: credentials, tool failure, environment, dependency, Linear/GitHub/API failure, or runtime orchestration issue.

Blocker notes must include:

- what failed,
- command or subsystem involved,
- recovery attempted,
- current impact,
- next operator action.

## Review Loop

Reviewer agents check two axes:

- Standards Review: architecture, TDD, deep module standard, item-first design intent, clean code, quality gates, and evidence quality.
- Spec Review: PRD, DAG node, Agent Brief, acceptance criteria, dependencies, and out-of-scope boundaries.

Move the issue to:

- `Human Review` when both axes pass.
- `Rework` when bounded worker fixes are needed.
- `Needs Human Context` when the spec or decision authority is insufficient.
- `Blocked` when review cannot proceed because of external/system failure.

## Commit And Branch Conventions

Use the commit message rules in `docs/agents/engineering-standards.md`.

Worker branches:

```text
codex/<linear-id>-<short-topic>
```

Examples:

```text
codex/alb-72-scaffold-typescript-kernel
codex/alb-73-item-list
```

## No Gate Weakening

Agents must not weaken, skip, disable, or relax CI, lint, formatter, typecheck, review, or readiness gates to finish work. If a gate is wrong or flaky, create or link a follow-up issue and keep the current issue out of `Agent Review` unless the manager explicitly accepts the risk.

